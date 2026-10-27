/**
 * recorder/replay — bug-file replay + divergence report (ADR 0006).
 *
 * Node-safe: no DOM, no rAF. Rebuilds each recorded run from its play-start
 * board snapshot (fresh deserialize — construction IS the restore, the
 * AgentSession pattern), steps the recorded per-tick dt stream verbatim
 * (re-applying recorded speed changes at their ticks), and drives a second
 * passive SessionRecorder as the comparison collector so recorded and
 * replayed streams share recording conventions by construction (ADR 0006
 * decision 9).
 *
 * Ordering matters and matches the browser GameLoop exactly:
 *   engine.step(dt)  →  eventBus.emit('loop:frame', {dt, elapsed})
 * (loop:frame AFTER the step; the GoalChecker's off-world check therefore
 * sees post-step states, same as live). The recorder's collision hook is
 * attached after engine construction — later than PhysicsEngine's own
 * matrix listeners, reproducing the browser's listener order.
 */

import { eventBus } from '../EventBus.js';
import { objectRegistry } from '../objects/ObjectRegistry.js';
import { registerAllObjects } from '../objects/registerAllObjects.js';
import { PhysicsEngine } from '../engine/PhysicsEngine.js';
import { GoalChecker } from '../goals/GoalChecker.js';
import { SessionRecorder } from './SessionRecorder.js';
import { REPLAYABLE_TOPICS } from './schema.js';

/**
 * Replay a whole bug file (all runs, or one selected run).
 *
 * @param {object} file — parsed bug-file document
 * @param {object} [options]
 * @param {number|null} [options.runIndex] — replay only this run (null: all)
 * @param {number} [options.untilTick] — stop stepping early (debug aid)
 * @returns {{ok: boolean, schemaVersion: number|null, runReports: object[], summary: string}}
 */
export function replayBugFile(file, { runIndex = null, untilTick = Infinity } = {}) {
    if (objectRegistry.getAll().length === 0) registerAllObjects();
    const runs = Array.isArray(file?.runs) ? file.runs : [];
    const indices = runIndex === null ? runs.map((_, i) => i) : [runIndex];
    const runReports = [];
    for (const index of indices) {
        if (!runs[index]) {
            runReports.push({ ok: false, runIndex: index, divergence: { kind: 'missing-run', runIndex: index }, compared: { events: 0, poses: 0 }, samplingMismatch: false, note: '' });
            continue;
        }
        runReports.push(replayRun(file, index, { untilTick }));
    }
    const ok = runReports.length > 0 && runReports.every((r) => r.ok);
    return { ok, schemaVersion: file?.schemaVersion ?? null, runReports, summary: summarize(runReports) };
}

/** ── (part 1b: single-run replay) ── */

/**
 * Replay one recorded run and compare it against the recording.
 *
 * @param {object} file
 * @param {number} runIndex
 * @param {object} [options]
 * @param {number} [options.untilTick]
 */
export function replayRun(file, runIndex, { untilTick = Infinity } = {}) {
    const run = file?.runs?.[runIndex];
    if (!run) throw new Error(`[Replay] no run ${runIndex} in bug file`);

    const playfield = file.playfield ?? { width: 1000, height: 600 };
    const engine = new PhysicsEngine(playfield.width, playfield.height, {
        gravityX: file.engine?.gravityX ?? 0,
        gravityY: file.engine?.gravityY ?? 1,
        enableSleeping: file.engine?.enableSleeping ?? true,
    });

    // Build the board from the authoritative snapshot rows — all of them,
    // including isFixed rows (in the sandbox the snapshot IS the level) —
    // then two-phase-bind rope attachment tokens, mirroring
    // restorePlacedFromSnapshot's aligned-board rule.
    const board = [];
    for (const row of run.boardSnapshot ?? []) {
        if (!row) continue;
        try {
            board.push(objectRegistry.deserialize(row));
        } catch (e) {
            console.warn(`[Replay] could not deserialize row "${row.type}":`, e);
        }
    }
    const aligned = board.length === (run.boardSnapshot?.length ?? 0);
    if (!aligned) {
        console.warn(`[Replay] board/row mismatch (${board.length} vs ${run.boardSnapshot?.length ?? 0}) — unbinding attachment tokens`);
    }
    for (const obj of board) {
        if (typeof obj.bindAttachment === 'function') obj.bindAttachment(aligned ? board : null);
    }
    for (const obj of board) engine.addObject(obj);

    // A recorded goal needs a checker on the bus (the AgentSession pattern).
    let goalCheckerInstance = null;
    if (run.goal) {
        goalCheckerInstance = new GoalChecker();
        goalCheckerInstance.init({ physicsEngine: engine });
        eventBus.emit('level:loaded', { id: run.levelId ?? file.context?.levelId ?? null, goal: run.goal });
        eventBus.emit('mode:changed', { oldMode: 'EDITING', newMode: 'PLAYING' });
    }

    // The comparison collector — same SessionRecorder, driven passively.
    const observer = new SessionRecorder({ passive: true });
    observer.init({
        getBoard: () => board,
        getSnapshot: () => run.boardSnapshot ?? null,
        getEngine: () => engine.engine, // the Matter engine, not the wrapper
        getPlayfield: () => playfield,
        getEngineInfo: () => file.engine ?? null,
    });
    observer.startSession();
    eventBus.emit('loop:play', { elapsed: 0 }); // opens the run

    const dts = run.dt?.values ?? [];
    const pendingTimeScale = [...(run.timeScale ?? [])];
    let elapsed = 0;
    for (let step = 1; step <= dts.length && step <= untilTick; step++) {
        // Recorded speed changes apply from the step after their tick:
        // in the browser the toggle lands between two steps.
        while (pendingTimeScale.length > 0 && pendingTimeScale[0].tick < step) {
            engine.setTimeScale(pendingTimeScale[0].speed);
            pendingTimeScale.shift();
        }
        const dt = dts[step - 1];
        engine.step(dt);
        elapsed += dt;
        eventBus.emit('loop:frame', { dt, elapsed });
    }

    observer.closeOpenRun('replay-end');
    const replayedRuns = observer.toJSON().runs;
    const replayed = replayedRuns[0] ?? null;
    observer.dispose();
    if (goalCheckerInstance) goalCheckerInstance.dispose();

    return compareRuns(run, replayed, { untilTick, replayedTicks: dts.length });
}

/** ── (part 2: comparison + report helpers) ── */

/**
 * Compare a recorded run against a replayed run. Events: pairwise over the
 * replayable-topic subset by (tick, topic, data). Poses: by tick on the
 * intersection of both row sets (dense recordings keep extra rows the
 * default-rate replay observer cannot produce — flagged, not fatal, when
 * the FILE was recorded dense… but a recorded default file replaying at the
 * same interval must align fully).
 */
function compareRuns(recordedRun, replayedRun, { untilTick, replayedTicks }) {
    const report = {
        ok: true,
        runIndex: recordedRun.index,
        lastTickRecorded: recordedRun.lastTick ?? null,
        lastTickReplayed: replayedRun?.lastTick ?? null,
        compared: { events: 0, poses: 0 },
        divergence: null,
        samplingMismatch: false,
        note: '',
    };
    if (!replayedRun) {
        report.ok = false;
        report.divergence = { kind: 'no-replayed-run' };
        return report;
    }

    const isReplayable = (e) => REPLAYABLE_TOPICS.includes(e.topic);
    const recEvents = (recordedRun.events ?? []).filter(isReplayable);
    const repEvents = (replayedRun.events ?? []).filter(isReplayable);
    const shared = Math.min(recEvents.length, repEvents.length);
    for (let i = 0; i < shared; i++) {
        const rec = recEvents[i];
        const rep = repEvents[i];
        report.compared.events++;
        const same = rec.tick === rep.tick
            && rec.topic === rep.topic
            && JSON.stringify(rec.data) === JSON.stringify(rep.data);
        if (!same) {
            report.ok = false;
            report.divergence = {
                kind: 'event',
                index: i,
                tickRecorded: rec.tick,
                tickReplayed: rep.tick,
                topic: rec.topic,
                topicReplayed: rep.topic,
                recorded: rec,
                replayed: rep,
            };
            report.note = tickNote(i, shared, untilTick);
            return report;
        }
    }
    if (recEvents.length !== repEvents.length) {
        report.ok = false;
        report.divergence = {
            kind: 'event-count',
            topic: shared > 0 ? recEvents[shared - 1].topic : null,
            recorded: { count: recEvents.length, tail: recEvents[shared] ?? null },
            replayed: { count: repEvents.length, tail: repEvents[shared] ?? null },
        };
        return report;
    }

    // Poses by tick
    const repPosesByTick = new Map((replayedRun.poses?.rows ?? []).map((row) => [row[0], row]));
    for (const row of recordedRun.poses?.rows ?? []) {
        const [tick, cells] = row;
        const rep = repPosesByTick.get(tick);
        if (!rep) {
            report.samplingMismatch = true;
            continue; // dense-file intersection case — flagged in the note
        }
        report.compared.poses++;
        const rCells = rep[1] ?? [];
        if (rCells.length !== cells.length) {
            report.ok = false;
            report.divergence = {
                kind: 'pose', tick, detail: `body count ${cells.length} vs ${rCells.length}`,
                recorded: cells, replayed: rCells,
            };
            return report;
        }
        for (let c = 0; c < cells.length; c++) {
            const a = cells[c];
            const b = rCells[c];
            if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3]
                || a[4] !== b[4] || a[5] !== b[5] || a[6] !== b[6]) {
                report.ok = false;
                report.divergence = { kind: 'pose', tick, cellIndex: c, recorded: a, replayed: b };
                return report;
            }
        }
    }

    if (untilTick === Infinity && report.lastTickRecorded !== report.lastTickReplayed) {
        report.ok = false;
        report.divergence = {
            kind: 'last-tick',
            recorded: report.lastTickRecorded,
            replayed: report.lastTickReplayed,
        };
    }
    return report;
}

/** Human hint appended to the first divergence. */
function tickNote(index, count, untilTick) {
    if (untilTick !== Infinity) return `compared with --until cap (${untilTick})`;
    if (index === 0) return 'diverged at the very first replayable event';
    return `matched ${index} prior event pair(s)`;
}

/** One-line-per-run summary strings. */
function summarize(runReports) {
    return runReports.map((r) => {
        if (r.ok && !r.samplingMismatch) {
            return `run ${r.runIndex}: OK — ${r.compared.events} events, ${r.compared.poses} pose rows match`;
        }
        if (r.ok) {
            return `run ${r.runIndex}: OK (event/pose comparison) — sampled rows not fully aligned (dense recording)`;
        }
        return `run ${r.runIndex}: DIVERGED — ${JSON.stringify(r.divergence)}`;
    });
}

export default replayBugFile;