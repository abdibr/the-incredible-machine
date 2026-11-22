/**
 * sandboxScript - the deterministic build script the sandbox watch replays
 * (issue #64).
 *
 * No model in the loop yet (the live turn source is #65): the build is a
 * FIXED, deterministic sequence of placement beats, every beat driven
 * through the phase-1 action API (place / rotate / nudge - the never-throw
 * result envelope) against the goal-less sandbox session (ADR 0011). The
 * script is pure data; applyBuildBeat is its only executor. A refused beat
 * is data the flow reports and moves past - never a throw.
 *
 * The shipped script stages the classic machine: a catcher bucket, a
 * straight-drop ball, a ramp (placed flat, then rotated to its slope)
 * whose ball is nudged onto it, and a second catcher for the roll-off. On
 * a fresh empty board the action API accepts every beat, and the run
 * catches both balls - at t=0.95s and t=1.57s, deterministic across
 * repeated cycles (the sandbox board has no goal, so the catches are data
 * in the event log, not verdicts).
 */

import { place, rotate, nudge } from '../../agent/actions.js';

/**
 * The build beats, in order - the exact shapes applyBuildBeat executes:
 *  { kind: 'place', type, x, y, angle? }      - a part on the board
 *  { kind: 'rotate', type, slot?, radians }   - a placed part retuned
 *  { kind: 'nudge', type, dx, dy, slot? }     - a placed part fine-tuned
 */
export const SANDBOX_BUILD_SCRIPT = [
    { kind: 'place', type: 'bucket', x: 700, y: 470 },         // the catcher
    { kind: 'place', type: 'ball', x: 700, y: 100 },           // the straight drop - caught ~t=0.95s
    { kind: 'place', type: 'ramp', x: 480, y: 380, angle: 0 }, // flat; the next beat tilts it
    { kind: 'rotate', type: 'ramp', radians: 0.4 },            // the slope, applied live
    { kind: 'place', type: 'ball', x: 440, y: 300 },           // above the ramp's high end
    { kind: 'nudge', type: 'ball', dx: 30, dy: 25, slot: 1 },  // settled onto the slope
    { kind: 'place', type: 'bucket', x: 620, y: 470 },         // the roll-off catcher - caught ~t=1.57s
];

/** A status-facing label for one beat (the flow narrates the build with these). */
export function beatLabel(beat) {
    switch (beat?.kind) {
        case 'place': return `place ${beat.type} at (${beat.x}, ${beat.y})`;
        case 'rotate': return `rotate ${beat.type} to ${beat.radians} rad`;
        case 'nudge': return `nudge ${beat.type} by (${beat.dx}, ${beat.dy})`;
        default: return `unknown beat: ${beat?.kind ?? '?'}`;
    }
}

/**
 * Apply one build beat through the phase-1 action API. NEVER THROWS: the
 * result carries the standard envelope ({ ok, error? }) - a refused beat
 * is data, exactly like any other action result.
 * @param {import('../../agent/session.js').AgentSession} session
 * @param {{ kind: string, type?: string, x?: number, y?: number, angle?: number,
 *           radians?: number, dx?: number, dy?: number, slot?: number }} beat
 * @returns {import('../../agent/actions.js').ActionResult}
 */
export function applyBuildBeat(session, beat) {
    let result;
    switch (beat?.kind) {
        case 'place':
            result = place(session, beat.type, beat.x, beat.y, { angle: beat.angle ?? 0 });
            break;
        case 'rotate':
            result = rotate(session, beat.type, beat.slot ?? 0, beat.radians);
            break;
        case 'nudge':
            result = nudge(session, beat.type, beat.dx, beat.dy, beat.slot ?? 0);
            break;
        default:
            result = { ok: false, error: `unknown beat kind: ${beat?.kind ?? '?'}` };
    }
    return result;
}