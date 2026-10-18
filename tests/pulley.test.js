/**
 * Unit tests for Pulley left↔right rope coupling (issue #13).
 *
 * Behavior under test: the pulley behaves as a shared rope over a pivot —
 * loading one platform sinks that side and raises the other; the state is
 * deterministic across play/reset cycles.
 *
 * Seams: Pulley construction + PhysicsEngine.step (public physics surface).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const PIVOT_X = 400;
const PIVOT_Y = 150;
const STEP_MS = 1000 / 60;
const SETTLE_STEPS = 120;   // let the free-hanging platforms settle into place
const SWING_STEPS = 240;    // enough sim time (~4s) for the coupled swing

describe('Pulley coupling', () => {
    let PhysicsEngine, Pulley, Ball;

    beforeEach(async () => {
        ({ PhysicsEngine } = await import('../js/engine/PhysicsEngine.js'));
        ({ default: Pulley } = await import('../js/objects/Pulley.js'));
        ({ default: Ball } = await import('../js/objects/Ball.js'));
    });

    function makeRig() {
        const physics = new PhysicsEngine(800, 600);
        const pulley = new Pulley(PIVOT_X, PIVOT_Y);
        physics.addObject(pulley);
        const [, leftBody, rightBody] = pulley.bodies;
        return { physics, pulley, leftBody, rightBody };
    }

    function stepRig(rig, steps) {
        for (let i = 0; i < steps; i++) {
            rig.physics.step(STEP_MS);
        }
    }

    it('produces identical runs for identical starting conditions (deterministic)', () => {
        const a = makeRig();
        const b = makeRig();
        try {
            stepRig(a, SETTLE_STEPS);
            stepRig(b, SETTLE_STEPS);
            a.physics.addObject(new Ball(PIVOT_X - 60, 163, { variant: 'bowling' }));
            b.physics.addObject(new Ball(PIVOT_X - 60, 163, { variant: 'bowling' }));
            stepRig(a, SWING_STEPS);
            stepRig(b, SWING_STEPS);

            expect(a.leftBody.position.x).toBeCloseTo(b.leftBody.position.x, 3);
            expect(a.leftBody.position.y).toBeCloseTo(b.leftBody.position.y, 3);
            expect(a.rightBody.position.y).toBeCloseTo(b.rightBody.position.y, 3);
        } finally {
            a.physics.dispose();
            b.physics.dispose();
        }
    });

    it('repeats the same swing across play/reset cycles on the same instance', () => {
        const rig = makeRig();
        try {
            stepRig(rig, SETTLE_STEPS);
            const baselineLeftY = rig.leftBody.position.y;
            const baselineRightY = rig.rightBody.position.y;
            rig.physics.takeSnapshot();

            // Cycle 1: load the left platform, let it swing to the rope clamp.
            rig.physics.addObject(new Ball(PIVOT_X - 60, 163, { variant: 'bowling' }));
            stepRig(rig, SWING_STEPS);
            expect(baselineRightY - rig.rightBody.position.y).toBeGreaterThan(15); // swing completed
            const cycle1LeftY = rig.leftBody.position.y;
            const cycle1RightY = rig.rightBody.position.y;

            // Reset (restore snapshot) — the ridden ball is dropped and
            // re-placed fresh, mirroring the game's placed-parts reset.
            rig.physics.restoreSnapshot();
            for (const obj of [...rig.physics.getObjects()]) {
                if (obj.type === 'ball') rig.physics.removeObject(obj);
            }
            rig.physics.addObject(new Ball(PIVOT_X - 60, 163, { variant: 'bowling' }));

            // Platforms must be back on the baseline after reset.
            expect(rig.leftBody.position.y).toBeCloseTo(baselineLeftY, 1);
            expect(rig.rightBody.position.y).toBeCloseTo(baselineRightY, 1);

            // Cycle 2 — same load: the coupling re-engages and swings again
            // (repeatability; sub-pixel pendulum wander is left to chaos).
            stepRig(rig, SWING_STEPS);
            expect(baselineRightY - rig.rightBody.position.y).toBeGreaterThan(15);
            expect(rig.rightBody.position.y).toBeCloseTo(cycle1RightY, 0);
            expect(rig.leftBody.position.y).toBeCloseTo(cycle1LeftY, 0);
        } finally {
            rig.physics.dispose();
        }
    });

    it('stays still without any load (no self-driven drift)', () => {
        const rig = makeRig();
        try {
            stepRig(rig, SETTLE_STEPS);
            const leftY = rig.leftBody.position.y;
            const rightY = rig.rightBody.position.y;
            const leftX = rig.leftBody.position.x;
            const rightX = rig.rightBody.position.x;

            stepRig(rig, SWING_STEPS);

            // Equal, idle sides must not creep — the couple only transfers
            // length under a measured weight imbalance.
            expect(Math.abs(rig.leftBody.position.y - leftY)).toBeLessThan(2);
            expect(Math.abs(rig.rightBody.position.y - rightY)).toBeLessThan(2);
            expect(Math.abs(rig.leftBody.position.x - leftX)).toBeLessThan(2);
            expect(Math.abs(rig.rightBody.position.x - rightX)).toBeLessThan(2);
        } finally {
            rig.physics.dispose();
        }
    });

    it('raises the opposite platform when weight lands on one side', () => {
        const baseline = makeRig();
        const loaded = makeRig();
        try {
            stepRig(baseline, SETTLE_STEPS);
            stepRig(loaded, SETTLE_STEPS);

            // Drop a bowling ball onto the left platform.
            const ball = new Ball(PIVOT_X - 60, 163, { variant: 'bowling' });
            loaded.physics.addObject(ball);

            stepRig(baseline, SWING_STEPS);
            stepRig(loaded, SWING_STEPS);

            const baseLeftY = baseline.leftBody.position.y;
            const baseRightY = baseline.rightBody.position.y;
            const loadLeftY = loaded.leftBody.position.y;
            const loadRightY = loaded.rightBody.position.y;

            // Money assertion (issue #13): weight on one side lifts the other.
            expect(loadRightY).toBeLessThan(baseRightY - 5);
            // The loaded side must also sink — seesaw in both directions.
            expect(loadLeftY).toBeGreaterThan(baseLeftY + 5);
        } finally {
            baseline.physics.dispose();
            loaded.physics.dispose();
        }
    });

    // ── snapshot-restore seam (Phase 5 #5: no mid-play pose-jump heuristic) ──

    it('does not re-derive the rope split from mid-play pose-jump heuristics', () => {
        const rig = makeRig();
        try {
            stepRig(rig, SETTLE_STEPS);

            // Drop a heavy ball onto the left platform: the impact jolts the
            // platform by far more than any plausible per-step threshold. The
            // coupling must treat that as ordinary dynamics — a pose-jump
            // "teleport" heuristic misreads hard rider impacts, and it is the
            // same mechanism that false-positives after snapshot restores,
            // so it must not exist mid-play at all (an explicit restoreState
            // seam handles restores/reset instead).
            rig.physics.addObject(new Ball(PIVOT_X - 60, 163, { variant: 'bowling' }));
            const syncSpy = vi.spyOn(rig.pulley, '_syncRopeToGeometry');
            stepRig(rig, 40); // fall + impact + settle window

            expect(syncSpy).not.toHaveBeenCalled();
        } finally {
            rig.physics.dispose();
        }
    });

    it('re-derives the rope split exactly once on the step after a snapshot restore', () => {
        const rig = makeRig();
        try {
            stepRig(rig, SETTLE_STEPS);
            rig.physics.takeSnapshot();

            // Load + swing: the rope split drifts away from the snapshot's.
            rig.physics.addObject(new Ball(PIVOT_X - 60, 163, { variant: 'bowling' }));
            stepRig(rig, SWING_STEPS);

            // Unload so the live object set matches the snapshot again (no
            // drift retake) — mirrors the game's placed-parts restore flow.
            for (const obj of [...rig.physics.getObjects()]) {
                if (obj.type === 'ball') rig.physics.removeObject(obj);
            }

            const syncSpy = vi.spyOn(rig.pulley, '_syncRopeToGeometry');
            rig.physics.restoreSnapshot();

            stepRig(rig, 1);
            expect(syncSpy).toHaveBeenCalledTimes(1); // one-shot resync after restore
            stepRig(rig, 30);
            expect(syncSpy).toHaveBeenCalledTimes(1); // then never re-derived mid-play
        } finally {
            rig.physics.dispose();
        }
    });
});