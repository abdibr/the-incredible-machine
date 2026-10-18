/**
 * rules.js — the interaction table. THE source of truth for what reacts to
 * what in this game.
 *
 * Add a row here (and a per-row test in tests/interactions.test.js) instead
 * of adding per-frame scans or collision overrides to an object class.
 *
 * Row shape:
 *   {
 *     id:      stable identifier (referenced by tests and docs),
 *     summary: one-line human description of the interaction,
 *     actor:   matcher for the reacting object,
 *     target:  matcher for the counterpart,
 *     handler: (actor, target, pair) => void — routes to the actor's public
 *              behavior method; behavior itself stays on the object,
 *     test:    the per-row test name in tests/interactions.test.js,
 *     docOnly: true for rows that must never dispatch (documented
 *              null-participants such as the boundary walls),
 *   }
 *
 * Matcher side shape: `{ type, label?, predicate?, match? }` where `match`
 * is the human phrase rendered in docs. An empty matcher `{}` is a wildcard.
 * State-dependent predicates delegate to decision methods on the object
 * (isCatchContact, isSnapTrigger, isRelevantContact, isLaunchTrigger), so
 * the local state stays local.
 *
 * Behavior-preservation notes are inline per row; bugs fixed on migration
 * are marked BUG-FIX and detailed in docs/adr/0001-interaction-matrix.md.
 */

// Wildcard matcher: any object.
const ANY = { match: 'any object' };

export const DEFAULT_INTERACTION_ROWS = [
    // ── Rope reactions ─────────────────────────────────────────
    {
        id: 'rope-candle-flame',
        summary: 'A rope segment touching a candle flame burns through and severs.',
        actor: { type: 'rope', match: 'rope (any segment)' },
        target: { type: 'candle', label: 'candle-flame', match: "candle flame (label 'candle-flame')" },
        handler: (rope) => rope.sever(),
        test: 'rope ✕ candle-flame severs; rope ✕ candle wax does not',
        // BUG-FIX: the old Rope.onCollision keyed on `other.type === 'candle'`
        // with no label gate, so resting on the solid wax severed the rope
        // too. Only the flame sensor cuts now (scissors kept a label gate;
        // candles didn't).
    },
    {
        id: 'rope-closed-scissors-blade',
        summary: 'A rope touching the blade bodies of snapped-shut scissors is cut.',
        actor: { type: 'rope', match: 'rope (any segment)' },
        target: {
            type: 'scissors',
            label: 'scissors-blade',
            predicate: (scissors) => scissors.isClosed,
            match: "scissors, closed, via label 'scissors-blade'",
        },
        handler: (rope) => rope.sever(),
        test: 'rope ✕ closed-scissors blade severs; open blades and handles never cut',
        // Preserved from Rope.onCollision: this was the codebase's only
        // label-gated pair; open blades let a rope rest untouched.
    },

    // ── Balloon reactions ──────────────────────────────────────
    {
        id: 'balloon-scissors',
        summary: 'A balloon pops on contact with any scissors body (blade or handle).',
        actor: { type: 'balloon', match: 'balloon' },
        target: { type: 'scissors', match: 'any scissors body' },
        handler: (balloon) => balloon.pop(),
        test: 'balloon ✕ scissors pops (any body)',
    },
    {
        id: 'balloon-candle',
        summary: 'A balloon pops on contact with any candle body (wax or flame).',
        actor: { type: 'balloon', match: 'balloon' },
        target: { type: 'candle', match: 'any candle body' },
        handler: (balloon) => balloon.pop(),
        test: 'balloon ✕ candle pops (wax or flame)',
        // Behavior preserved deliberately (Balloon.onCollision keyed on the
        // candle object, not the flame). Wax-pop is a candidate refinement
        // flagged in docs/adr/0001-interaction-matrix.md — not changed here.
    },

    // ── Bucket reaction ────────────────────────────────────────
    {
        id: 'bucket-catch',
        summary: 'The bucket registers a catch when a matching object touches its sensor zone.',
        actor: {
            type: 'bucket',
            predicate: (bucket, other, pair) => bucket.isCatchContact(other, pair),
            match: "bucket, via its 'bucket-sensor' body, catchType filter",
        },
        target: ANY,
        handler: (bucket, other) => bucket.registerCatch(other),
        test: 'bucket ✕ matching object via sensor emits bucket:caught once per object',
    },

    // ── Gear reaction ──────────────────────────────────────────
    {
        id: 'gear-gear',
        summary: 'Two touching gears mesh: each drives the other to counter-rotate at its own speed.',
        actor: { type: 'gear', match: 'gear' },
        target: { type: 'gear', match: 'gear' },
        handler: (a, b) => {
            a.meshWith(b);
            b.meshWith(a);
        },
        test: 'gear ✕ gear meshes mutually through the public mesh seam',
        // BUG-FIX: Gear.onCollision reached through to `other._angularSpeed`.
        // meshWith()/applyGearDrive() is the public seam; firing both
        // directions here reproduces the old double-dispatch outcome exactly.
    },

    // ── Scissors reaction ──────────────────────────────────────
    {
        id: 'scissors-snap',
        summary: 'A dynamic weight landing on a scissors handle snaps the levers shut (one-shot).',
        actor: {
            type: 'scissors',
            predicate: (scissors, other, pair) => scissors.isSnapTrigger(other, pair),
            match: "scissors, open, via its 'scissors-handle' bodies; ignores ropes and statics",
        },
        target: ANY,
        handler: (scissors) => scissors.snapShut(),
        test: 'scissors ✕ dynamic weight on handle snaps; rope/static/blade contacts never do',
    },

    // ── Mouse reaction ─────────────────────────────────────────
    {
        id: 'mouse-reverse',
        summary: 'A mouse reverses on significant, front-facing, head-on contacts (debounced).',
        actor: {
            type: 'mouse',
            predicate: (mouse, other, pair) => mouse.isRelevantContact(other, pair),
            match: 'mouse, head-on & front-facing contact; ignores other mice',
        },
        target: ANY,
        handler: (mouse) => mouse.reverseFromContact(),
        test: 'mouse ✕ head-on contact reverses once within the debounce window',
    },

    // ── Spring reaction ────────────────────────────────────────
    {
        id: 'spring-trigger',
        summary: 'Something landing on the spring platform compresses and arms the launch.',
        actor: {
            type: 'spring',
            predicate: (spring, other, pair) => spring.isLaunchTrigger(other, pair),
            match: "spring, via its 'spring-platform' body, off cooldown",
        },
        target: ANY,
        handler: (spring) => spring.armLaunch(),
        test: 'spring ✕ platform contact triggers; cooldown suppresses retriggers',
    },

    // ── Trampoline reaction ────────────────────────────────────
    {
        id: 'trampoline-stretch',
        summary: 'Any contact involving the trampoline plays the stretch animation.',
        actor: { type: 'trampoline', match: 'trampoline' },
        target: ANY,
        handler: (trampoline) => trampoline.stretch(),
        test: 'trampoline ✕ any contact stretches',
    },

    // ── Documented null-participants (never dispatch) ──────────
    {
        id: 'boundary-null',
        summary: 'Boundary walls collide with everything physically but participate in no interaction rows.',
        actor: { type: 'boundary-wall', match: 'boundary walls (floor/left/right/ceiling)' },
        target: ANY,
        docOnly: true,
        test: 'boundary walls are null participants',
    },
    {
        id: 'silent-objects-null',
        summary: 'Ball, Ramp, Conveyor, Fan, Domino, Pulley and Candle declare no reaction rows — contacts affect other objects, never them.',
        actor: { type: 'ball/ramp/conveyor/fan/domino/pulley/candle', match: 'the silent object classes' },
        target: ANY,
        docOnly: true,
        test: 'silent classes have no reaction rows',
    },
];