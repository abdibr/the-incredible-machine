/**
 * registerAllObjects — Bootstrap registration of all game object types
 *
 * Called once at app startup to populate the ObjectRegistry
 * with all available game objects and their metadata.
 */

import { objectRegistry } from './ObjectRegistry.js';

import Ball from './Ball.js';
import Ramp from './Ramp.js';
import Conveyor from './Conveyor.js';
import Trampoline from './Trampoline.js';
import Fan from './Fan.js';
import Spring from './Spring.js';
import Domino from './Domino.js';
import Gear from './Gear.js';
import Pulley from './Pulley.js';
import Balloon from './Balloon.js';
import Bucket from './Bucket.js';
import Candle from './Candle.js';
import Rope from './Rope.js';
import Scissors from './Scissors.js';
import Mouse from './Mouse.js';

/**
 * Register all game objects with the central ObjectRegistry.
 * Must be called before any toolbox rendering or level loading.
 */
export function registerAllObjects() {
    // ── Balls ────────────────────────────────────
    objectRegistry.register('ball', Ball, {
        displayName: 'Bowling Ball',
        category: 'balls',
        description: 'Heavy ball — rolls, bounces, and smashes.',
    });

    objectRegistry.register('tennis-ball', class TennisBall extends Ball {
        constructor(x, y, opts = {}) { super(x, y, { ...opts, variant: 'tennis' }); }
        get type() { return 'tennis-ball'; }
        static deserialize(data) { return new TennisBall(data.x, data.y, { ...data.options, customId: data.id }); }
    }, {
        displayName: 'Tennis Ball',
        category: 'balls',
        description: 'Light bouncy ball.',
    });

    objectRegistry.register('baseball', class Baseball extends Ball {
        constructor(x, y, opts = {}) { super(x, y, { ...opts, variant: 'baseball' }); }
        get type() { return 'baseball'; }
        static deserialize(data) { return new Baseball(data.x, data.y, { ...data.options, customId: data.id }); }
    }, {
        displayName: 'Baseball',
        category: 'balls',
        description: 'Medium-weight ball.',
    });

    // ── Surfaces ─────────────────────────────────
    objectRegistry.register('ramp', Ramp, {
        displayName: 'Ramp',
        category: 'surfaces',
        description: 'Angled surface — redirect rolling objects.',
    });

    objectRegistry.register('conveyor', Conveyor, {
        displayName: 'Conveyor Belt',
        category: 'surfaces',
        description: 'Moving belt that pushes objects along.',
    });

    objectRegistry.register('trampoline', Trampoline, {
        displayName: 'Trampoline',
        category: 'surfaces',
        description: 'Bouncy surface — launches objects skyward.',
    });

    // ── Machines ─────────────────────────────────
    objectRegistry.register('fan', Fan, {
        displayName: 'Fan',
        category: 'machines',
        description: 'Blows wind to push objects away.',
    });

    objectRegistry.register('spring', Spring, {
        displayName: 'Spring',
        category: 'machines',
        description: 'Compressed launcher — flings objects upward.',
    });

    objectRegistry.register('gear', Gear, {
        displayName: 'Gear',
        category: 'machines',
        description: 'Rotating wheel — meshes with adjacent gears.',
    });

    objectRegistry.register('pulley', Pulley, {
        displayName: 'Pulley',
        category: 'machines',
        description: 'Two platforms linked by ropes — one goes up, the other goes down.',
    });

    // ── Triggers / Special ───────────────────────
    objectRegistry.register('domino', Domino, {
        displayName: 'Domino',
        category: 'triggers',
        description: 'Thin tile that topples over — chain reaction!',
    });

    objectRegistry.register('balloon', Balloon, {
        displayName: 'Balloon',
        category: 'triggers',
        description: 'Floats upward — its knot ties a rope end; pop with scissors or flame.',
    });

    objectRegistry.register('bucket', Bucket, {
        displayName: 'Bucket',
        category: 'triggers',
        description: 'Goal container — its rim ties a rope end; catch objects inside.',
    });

    objectRegistry.register('candle', Candle, {
        displayName: 'Candle',
        category: 'triggers',
        description: 'Flickering flame — burns ropes, pops balloons.',
    });

    objectRegistry.register('rope', Rope, {
        displayName: 'Rope',
        category: 'triggers',
        description: 'Each end ties to balloon knots and bucket rims — drop either part right up close to the other.',
    });

    objectRegistry.register('free-rope', class FreeRope extends Rope {
        constructor(x, y, opts = {}) { super(x, y, { ...opts, free: true }); }
        get type() { return 'free-rope'; }
        drawToolboxIcon(ctx, w, h) {
            // Distinct toolbox icon (issue #55): the pinned rope shows the
            // nail + hanging strand; the free rope is its inert coil — the
            // same three concentric arcs the bundle draws on the board
            // (Rope.draw, radii 6/9/12), scaled to the icon, plus a loose
            // end spilling out of the outer ring (ready to tie and uncoil).
            // Never draws the gray nail dot.
            const cx = w / 2;
            const cy = h / 2;
            const outer = w * 0.32;
            ctx.strokeStyle = '#8B6914'; // ROPE_COLOR (duplicated here, as in Pulley.js)
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(cx + outer * 0.8, cy + outer * 0.6);
            ctx.quadraticCurveTo(cx + outer + w * 0.04, cy + outer + h * 0.06, cx + w * 0.1, cy + outer + h * 0.08);
            ctx.stroke();
            for (let i = 0; i < 3; i++) {
                ctx.beginPath();
                ctx.arc(cx, cy, outer - i * w * 0.09, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        static deserialize(data) {
            return new FreeRope(data.x, data.y, {
                angle: data.angle,
                isFixed: data.isFixed,
                customId: data.id,
                length: data.options?.length || 100,
                endPoint: data.options?.endPoint,
                severed: data.options?.severed ?? false,
                attachments: data.attachments ?? [],
            });
        }
        serialize() {
            // The spawned discriminator is derived live, never stored: a
            // bundle re-serializes spawned:false, a spawned chain spawned:true.
            // Mirrors the ADR 0005 convergence pattern (derive at serialize
            // time so round-trips stay stable).
            const data = super.serialize();
            data.options.spawned = this._segments.length > 0;
            return data;
        }
        restoreState(record) {
            super.restoreState(record);
            // Snapshot rewind (issue #55): the snapshot predates the first
            // tie (spawned:false) while this instance already carries a
            // spawned chain — collapse it back into the bundle (force skips
            // the live-knot guard; the engine consumer un-bundles the world).
            // The reverse is intentionally skipped: once collapsed, the chain
            // bodies are gone from the world, so a spawned snapshot cannot
            // resurrect them — it keeps its bundle like a severed rope keeps
            // its severed flag.
            if (record?.options?.spawned === false && this._segments.length > 0) {
                this._maybeRevertToBundle(true);
            }
        }
    }, {
        displayName: 'Free Rope',
        category: 'triggers',
        description: 'Inert coiled rope — tie one end to a knot or rim to spawn the hanging chain; untie it all to coil back up.',
    });

    objectRegistry.register('scissors', Scissors, {
        displayName: 'Scissors',
        category: 'triggers',
        description: 'Blades rest open — a weight on the handle snaps them shut, cutting ropes and popping balloons.',
    });

    objectRegistry.register('mouse', Mouse, {
        displayName: 'Mouse',
        category: 'triggers',
        description: 'Walks left and right — adds life to puzzles.',
    });

    console.log(`[ObjectRegistry] Registered ${objectRegistry.getAll().length} object types across ${objectRegistry.getCategories().length} categories.`);
}

export default registerAllObjects;
