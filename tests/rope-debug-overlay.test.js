/**
 * Debug overlay and knot tooltips - GitHub issue #59.
 *
 * Two debugging affordances (ADR 0007 decision 9 + the Consequences
 * debugging bullet), riding existing facts only:
 *
 * 1. The knot tooltip: hovering a tie square in the edit modes explains
 *    that seat's knots - which seat/segment body it belongs to (role is
 *    THE seat address since issue #90), the target's type and id, the
 *    attachment point id, realized vs still pending-bind, and the
 *    severed flag - for endpoint, mid-chain and knot-less seats alike.
 *    The tooltip is a knot-walking consumer riding the capability
 *    duck-check (getAttachmentRefs), the same contract the bug-file
 *    narrator and the placed-board annotator gate on.
 *
 * 2. The debug overlay: an explicitly-enabled toggle renders the LIVE
 *    engine picture for every rope-family member - chain segment
 *    outlines, realized engine links, and reconcile/bind warnings -
 *    derived for AFK agents and humans alike. The family loop asks the
 *    rope module's own membership fact (Rope.ROPE_FAMILY_TYPES via
 *    isRopeFamily/isRopeFamilyType, C1 issue #75) - never a fresh
 *    enumeration and never a hand-rolled `type === 'rope'` pair.
 *
 * The one decision-9 exception is the overlay: explicitly-enabled live
 * debugging may render during play. Knot tooltips stay suppressed in
 * PLAY (edit-only affordance). The toggle defaults off and disturbs
 * nothing but its own flag.
 *
 * Seams under test (user-confirmed, five):
 * 1. Tooltip fact coverage - endpoint, mid-chain, knot-less endpoints.
 * 2. Overlay content - segment outlines, realized links, warnings.
 * 3. Toggle defaults off and disturbs nothing (simulation/gameplay).
 * 4. PLAY gating - tooltip suppressed in PLAY; overlay only when enabled.
 * 5. Family parity - pinned rope, free-rope bundle, rope-to-rope knots.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import ConnectFlow from '../js/ui/ConnectFlow.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { buildKnotTooltipData, buildRopeOverlayData, drawRopeDebugOverlay } from '../js/render/RopeDebug.js';
import Renderer, { renderer as rendererSingleton } from '../js/render/Renderer.js';

registerAllObjects();

const DT = 1000 / 60;
const engines = [];

afterEach(() => {
    for (const engine of engines) engine.dispose();
    engines.length = 0;
    vi.restoreAllMocks();
    rendererSingleton.showRopeDebugOverlay = false;
});

describe('Knot tooltip facts - endpoint, mid-chain, knot-less (seam 1)', () => {
    it('an endpoint knot lists carrier, seat+body, target type+id, point and pending-bind before its link realizes', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        rope.attachEndpoint('end', balloon, 'knot');
        const endIdx = rope.bodies.length - 1;

        const data = buildKnotTooltipData(rope, 'end', null, endIdx);

        expect(data).not.toBeNull();
        expect(data.carrierType).toBe('rope');
        expect(data.carrierId).toBe(rope.id);
        expect(data.role).toBe('end');
        expect(data.bodyIndex).toBe(endIdx);
        expect(data.severed).toBe(false);
        expect(data.knot).toEqual({
            targetType: 'balloon', targetId: balloon.id,
            pointId: 'knot', state: 'pending-bind', severed: false,
        });
        // The same facts, as the tooltip's lines: address, tie, point, state.
        expect(data.lines).toContain(`rope #${rope.id}`);
        expect(data.lines).toContain(`seat end (body ${endIdx})`);
        expect(data.lines).toContain(`knot → balloon #${balloon.id}`);
        expect(data.lines).toContain('point knot');
        expect(data.lines).toContain('pending-bind');
        rope.dispose();
        balloon.dispose();
    });

    it('a mid-chain knot rides its mid seat and reads realized once the engine link exists', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const rope = new Rope(300, 100, { length: 100 });
        const balloon = new Balloon(300, 166);
        rope.attachEndpoint('mid', balloon, 'knot');
        physics.addObject(rope);
        physics.addObject(balloon);
        const midSeat = rope.getTieSeats().find((s) => s.role === 'mid');
        const midIdx = rope.bodies.indexOf(midSeat.body);

        // The ref exists but the engine link realizes lazily on the step:
        // pending-bind first...
        expect(buildKnotTooltipData(rope, 'mid', physics, midIdx).knot.state).toBe('pending-bind');
        physics.step(DT);
        // ...realized once the reconcile has pinned the link.
        const data = buildKnotTooltipData(rope, 'mid', physics, midIdx);
        expect(data.knot).toEqual({
            targetType: 'balloon', targetId: balloon.id,
            pointId: 'knot', state: 'realized', severed: false,
        });
        expect(data.role).toBe('mid');
        expect(data.bodyIndex).toBe(midIdx);
        expect(data.lines).toContain('realized');
        expect(data.lines).toContain(`knot → balloon #${balloon.id}`);
        rope.dispose();
        balloon.dispose();
    });

    it('a knot-less endpoint answers the seat facts with no knot and a no-knot line', () => {
        const rope = new Rope(300, 100, { length: 40 });

        const data = buildKnotTooltipData(rope, 'end', null, rope.bodies.length - 1);

        expect(data).not.toBeNull();
        expect(data.knot).toBeNull();
        expect(data.knotless).toBe(true);
        expect(data.pendingTokens).toEqual([]);
        expect(data.lines).toContain(`seat end (body ${rope.bodies.length - 1})`);
        expect(data.lines).toContain('no knot');
        expect(data.lines.join('\n')).not.toContain('knot →');
        rope.dispose();
    });

    it('a knot into a severed rope target carries the severed flag and reads pending-bind', () => {
        const ropeA = new Rope(100, 100, { length: 100 });
        const ropeB = new Rope(160, 100, { length: 100 });
        ropeA.attachEndpoint('end', ropeB, 'anchor'); // rope-to-rope knot (issue #57)
        ropeB.sever(ropeB.bodies[2]); // the target rope is cut after the tie

        const data = buildKnotTooltipData(ropeA, 'end', null, ropeA.bodies.length - 1);

        expect(data.severed).toBe(false); // the HOLDER is intact
        expect(data.knot).toEqual({
            targetType: 'rope', targetId: ropeB.id,
            pointId: 'anchor', state: 'pending-bind', severed: true,
        });
        expect(data.lines).toContain('target severed');
        ropeA.dispose();
        ropeB.dispose();
    });

    it('a severed rope reports its own severed fact on the tooltip data', () => {
        const rope = new Rope(300, 100, { length: 40 });
        rope.sever(1);

        const data = buildKnotTooltipData(rope, 'mid', null, 2);

        expect(data).not.toBeNull();
        expect(data.severed).toBe(true);
        expect(data.knot).toBeNull(); // no live knot to explain
        expect(data.lines).toContain('no knot');
        rope.dispose();
    });

    it('pending-bind tokens answer through the tooltip before they bind', () => {
        // A rope restored with an unbound token (the deferred rope-target
        // shape between levelReset's retry passes): the seat answers a
        // pending-bind entry, not a live knot.
        const rope = new Rope(300, 100, {
            length: 40,
            attachments: [{ seat: 'end', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' }],
        });

        const data = buildKnotTooltipData(rope, 'end', null, rope.bodies.length - 1);

        expect(data.knot).toBeNull();
        expect(data.pendingTokens).toEqual([{
            seat: 'end', targetType: 'balloon', targetOrdinal: 0,
            pointId: 'knot', state: 'pending-bind',
        }]);
        expect(data.knotless).toBe(false);
        expect(data.lines).toContain('token → balloon (ordinal 0)');
        expect(data.lines).toContain('point knot');
        expect(data.lines).toContain('pending-bind');
        expect(data.lines).toContain('no live knot');
        rope.dispose();
    });

    it('answers nothing for parts that offer no attachment refs - the duck-check gate', () => {
        const balloon = new Balloon(300, 100);
        expect(buildKnotTooltipData(balloon, 'anchor', null)).toBeNull();
        expect(buildKnotTooltipData({}, 'anchor', null)).toBeNull();
        expect(buildKnotTooltipData(null, 'anchor', null)).toBeNull();
        balloon.dispose();
    });
});

describe('Debug overlay content - outlines, links, warnings (seam 2)', () => {
    it('the family loop outlines every chain segment body of every rope-family member', () => {
        const rope = new Rope(300, 100, { length: 100 });
        const bundle = objectRegistry.create('free-rope', 500, 400); // bodyless coil

        const data = buildRopeOverlayData([rope, bundle], null);

        expect(data.ropes).toHaveLength(2);
        const laid = data.ropes[0];
        expect(laid.carrierType).toBe('rope');
        expect(laid.coil).toBe(false);
        expect(laid.outlines).toHaveLength(rope.bodies.length); // anchor + 6 segments
        rope.bodies.forEach((b, i) => {
            expect(laid.outlines[i].x).toBeCloseTo(b.position.x, 5);
            expect(laid.outlines[i].y).toBeCloseTo(b.position.y, 5);
            expect(laid.outlines[i].r).toBeGreaterThan(0);
        });
        // The bodyless bundle: no segments to outline - its coil bounds stand in.
        const coil = data.ropes[1];
        expect(coil.coil).toBe(true);
        expect(coil.outlines).toHaveLength(0);
        expect(coil.coilBounds).toEqual(boundsLike(bundle.bounds));
        rope.dispose();
        bundle.dispose();
    });

    it('realized engine links ride the overlay once - the reconcile is the only source', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const rope = new Rope(100, 100, { length: 40 });
        const balloon = new Balloon(110, 180);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint('end', balloon, 'knot');

        // Before the step: the ref is live but no link exists - nothing realized.
        expect(buildRopeOverlayData([rope, balloon], physics).links).toHaveLength(0);
        physics.step(DT);

        const data = buildRopeOverlayData([rope, balloon], physics);
        expect(data.links).toHaveLength(1);
        const seatBody = rope.getTieSeats().find((s) => s.role === 'end').body;
        expect(data.links[0].a).toEqual({ x: seatBody.position.x, y: seatBody.position.y });
        const knotBody = balloon.attachmentPoints.find((p) => p.id === 'knot').body;
        expect(data.links[0].b).toEqual({ x: knotBody.position.x, y: knotBody.position.y });
        // Idempotent steps never duplicate the link.
        physics.step(DT);
        expect(buildRopeOverlayData([rope, balloon], physics).links).toHaveLength(1);
        rope.dispose();
        balloon.dispose();
    });

    it('warnings flag fresh knots (pending-bind), severed ropes and unbound tokens', () => {
        // Fresh tie, never stepped: the reconcile has not realized the link.
        const rope = new Rope(100, 100, { length: 40 });
        const balloon = new Balloon(130, 120);
        rope.attachEndpoint('end', balloon, 'knot');
        let warnings = buildRopeOverlayData([rope, balloon], null).ropes[0].warnings;
        expect(warnings).toHaveLength(1);
        expect(warnings[0].reason).toBe('pending-bind');
        expect(warnings[0].lines.join(' ')).toContain('knot end →');
        expect(warnings[0].lines.join(' ')).toContain(`balloon #${balloon.id}`);
        expect(warnings[0].lines.join(' ')).toContain('pending-bind');

        // Stepped and realized: a healthy tie raises nothing.
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        physics.addObject(rope);
        physics.addObject(balloon);
        physics.step(DT);
        warnings = buildRopeOverlayData([rope, balloon], physics).ropes[0].warnings;
        expect(warnings).toHaveLength(0);

        // A severed rope warns what severing means for its knots: the piece
        // cut keeps its pieces' knots, the legacy shape realizes nothing.
        const cut = new Rope(400, 100, { length: 100 });
        cut.sever(2);
        const legacy = new Rope(600, 100, { length: 100, severed: true });
        const cutData = buildRopeOverlayData([cut, legacy], null);
        const cutWarnings = cutData.ropes[0].warnings;
        expect(cutWarnings[0].reason).toBe('severed');
        expect(cutWarnings[0].lines.join(' ')).toMatch(/piece/);
        const legacyWarnings = cutData.ropes[1].warnings;
        expect(legacyWarnings[0].reason).toBe('severed');
        expect(legacyWarnings[0].lines.join(' ')).toMatch(/nothing/);

        // Pending-bind tokens: the deferred restore token counts itself.
        const tokenRope = new Rope(300, 300, {
            length: 40,
            attachments: [{ seat: 'end', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' }],
        });
        warnings = buildRopeOverlayData([tokenRope], null).ropes[0].warnings;
        expect(warnings[0].reason).toBe('pending-bind');
        expect(warnings[0].lines.join(' ')).toContain('token');

        rope.dispose();
        balloon.dispose();
        cut.dispose();
        legacy.dispose();
        tokenRope.dispose();
    });

    it('a knot into a severed target flags severed-target, not a healthy pending-bind', () => {
        const ropeA = new Rope(100, 100, { length: 100 });
        const ropeB = new Rope(160, 100, { length: 100 });
        ropeA.attachEndpoint('end', ropeB, 'anchor');
        ropeB.sever(ropeB.bodies[2]);

        const warnings = buildRopeOverlayData([ropeA, ropeB], null).ropes[0].warnings;
        expect(warnings.map((w) => w.reason)).toContain('severed-target');
        expect(warnings.map((w) => w.reason)).not.toContain('pending-bind');
        expect(warnings.flatMap((w) => w.lines).join(' ')).toContain(`rope #${ropeB.id}`);
        ropeA.dispose();
        ropeB.dispose();
    });

    it('draw paints segment outlines for the whole chain', () => {
        const rope = new Rope(100, 100, { length: 40 });
        const balloon = new Balloon(300, 300);
        const data = buildRopeOverlayData([rope, balloon], null); // no links, no warnings

        const ctx = makeDrawCtx();
        drawRopeDebugOverlay(ctx, data);

        const arcs = ctx.arc.mock.calls.map(([x, y, r]) => ({ x, y, r }));
        expect(arcs).toHaveLength(rope.bodies.length); // anchor + segments, nothing else
        rope.bodies.forEach((b, i) => {
            expect(arcs[i].x).toBeCloseTo(b.position.x, 5);
            expect(arcs[i].y).toBeCloseTo(b.position.y, 5);
            expect(arcs[i].r).toBeGreaterThan(0);
        });
        expect(ctx.strokeStyles.length).toBeGreaterThan(0);
        expect(ctx.fillText).not.toHaveBeenCalled(); // a healthy picture carries no warnings
        expect(ctx.moveTo).not.toHaveBeenCalled(); // and no realized links
        rope.dispose();
        balloon.dispose();
    });

    it('draw pins every realized link between its two bodies', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const rope = new Rope(100, 100, { length: 40 });
        const balloon = new Balloon(110, 180);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint('end', balloon, 'knot');
        physics.step(DT); // realize

        const seatBody = rope.getTieSeats().find((s) => s.role === 'end').body;
        const knotBody = balloon.attachmentPoints.find((p) => p.id === 'knot').body;
        const ctx = makeDrawCtx();
        drawRopeDebugOverlay(ctx, buildRopeOverlayData([rope, balloon], physics));

        // The link's line goes seat body to knot body...
        expect(ctx.moveTo).toHaveBeenCalledWith(seatBody.position.x, seatBody.position.y);
        expect(ctx.lineTo).toHaveBeenCalledWith(knotBody.position.x, knotBody.position.y);
        // ...pinned by one dot at each end.
        const arcs = ctx.arc.mock.calls.map(([x, y, r]) => ({ x, y, r }));
        expect(arcs).toContainEqual(expect.objectContaining({
            x: seatBody.position.x, y: seatBody.position.y,
        }));
        expect(arcs).toContainEqual(expect.objectContaining({
            x: knotBody.position.x, y: knotBody.position.y,
        }));
        rope.dispose();
        balloon.dispose();
    });

    it('draw paints warning badges above the rope they describe', () => {
        const rope = new Rope(100, 100, { length: 40 });
        const balloon = new Balloon(130, 120);
        rope.attachEndpoint('end', balloon, 'knot'); // fresh tie: pending-bind

        const ctx = makeDrawCtx();
        drawRopeDebugOverlay(ctx, buildRopeOverlayData([rope, balloon], null));

        const texts = ctx.fillText.mock.calls.map((c) => c[0]);
        expect(texts.join('\n')).toMatch(/pending-bind/);
        expect(texts.join('\n')).toMatch(/balloon/);
        expect(ctx.fillRect).toHaveBeenCalled(); // the badge box behind the text
        expect(ctx.strokeStyles).toContain('#e34e4e'); // the warning border
        rope.dispose();
        balloon.dispose();
    });

    it('draw marks a bodyless bundle by its coil bounds', () => {
        const bundle = objectRegistry.create('free-rope', 500, 400);

        const data = buildRopeOverlayData([bundle], null);
        const b = data.ropes[0].coilBounds;
        const ctx = makeDrawCtx();
        drawRopeDebugOverlay(ctx, data);

        expect(ctx.strokeRect).toHaveBeenCalledWith(b.x - 2, b.y - 2, b.width + 4, b.height + 4);
        bundle.dispose();
    });
});



describe('The overlay toggle - wiring defaults off, flips nothing else (seam 3)', () => {
    let unsubs = [];

    afterEach(() => { vi.unstubAllGlobals(); });

    it('the DBG button flips its pressed state and announces enabled on the bus', () => {
        const fakeButtons = [];
        const makeFakeButton = () => {
            const classes = new Set();
            const el = {
                className: '', id: '', textContent: '', title: '', disabled: false,
                attrs: {}, _listeners: {},
                classList: {
                    add: (...c) => c.forEach((x) => classes.add(x)),
                    remove: (...c) => c.forEach((x) => classes.delete(x)),
                    toggle: (c, force) => {
                        if (force === undefined ? !classes.has(c) : force) classes.add(c);
                        else classes.delete(c);
                    },
                    contains: (c) => classes.has(c),
                },
                addEventListener: (type, fn) => { (el._listeners[type] = el._listeners[type] ?? []).push(fn); },
                dispatch: (type) => (el._listeners[type] ?? []).forEach((fn) => fn({})),
            };
            el.setAttribute = (k, v) => { el.attrs[k] = v; };
            return el;
        };
        fakeButtons.length = 0;
        const container = { innerHTML: '', appendChild: (el) => fakeButtons.push(el) };
        vi.stubGlobal('document', {
            readyState: 'loading',
            getElementById: vi.fn(() => container),
            createElement: vi.fn(() => makeFakeButton()),
            addEventListener: vi.fn(),
        });

        return import('../js/ui/PlayControls.js').then(({ playControls }) => {
            playControls.init();
            const dbg = fakeButtons.find((b) => b.id === 'btn-rope-debug');
            expect(dbg).toBeDefined();
            expect(dbg.title).toBe('Rope debug overlay');
            expect(dbg.textContent).toBe('DBG');
            expect(dbg.classList.contains('btn-active')).toBe(false); // defaults OFF

            const emissions = [];
            const unsub = eventBus.on('controls:rope-debug', (e) => emissions.push(e));
            unsubs.push(unsub);

            dbg.dispatch('click');
            expect(emissions).toEqual([{ enabled: true }]);
            expect(dbg.classList.contains('btn-active')).toBe(true);

            dbg.dispatch('click');
            expect(emissions).toEqual([{ enabled: true }, { enabled: false }]);
            expect(dbg.classList.contains('btn-active')).toBe(false); // off again
        });
    });

    it('the app wiring flips only the renderer flag - no simulation or gameplay state moves', async () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const rope = new Rope(100, 100, { length: 40 });
        const balloon = new Balloon(110, 180);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint('end', balloon, 'knot');
        physics.step(DT); // realize: a live simulation to leave untouched
        const refsBefore = rope.getAttachmentRefs().map((r) => ({ seat: r.seat, target: r.target, pointId: r.pointId }));
        const linksBefore = physics.getAttachedConstraints().length;
        const positionsBefore = rope.bodies.map((b) => ({ ...b.position }));

        // main.js boots when the DOM is ready; keep the boot deferred while
        // importing (speed-wiring's pattern).
        vi.stubGlobal('document', { readyState: 'loading', addEventListener: vi.fn() });
        vi.stubGlobal('window', { addEventListener: vi.fn() });
        vi.stubGlobal('requestAnimationFrame', vi.fn());
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const main = await import('../js/main.js');

        const modeEvents = [];
        unsubs.push(eventBus.on('mode:changed', (e) => modeEvents.push(e)));
        unsubs.push(main.wireRopeDebugOverlay());

        eventBus.emit('controls:rope-debug', { enabled: true });
        expect(rendererSingleton.showRopeDebugOverlay).toBe(true);
        eventBus.emit('controls:rope-debug', { enabled: false });
        expect(rendererSingleton.showRopeDebugOverlay).toBe(false);

        // Toggling disturbed nothing but the flag...
        expect(modeEvents).toEqual([]); // no stage change rode along
        expect(physics.getAttachedConstraints()).toHaveLength(linksBefore); // the link kept
        expect(rope.getAttachmentRefs()).toEqual(refsBefore); // the knots kept
        rope.bodies.forEach((b, i) => {
            expect(b.position.x).toBeCloseTo(positionsBefore[i].x, 5);
            expect(b.position.y).toBeCloseTo(positionsBefore[i].y, 5);
        });
    });
});
describe('Knot tooltip on the renderer - hover pick, stage gating (seam 4)', () => {
    function makeEditRenderer(rope, balloon, mode, hover) {
        const flow = new ConnectFlow();
        flow._mode = mode;
        const r = new Renderer();
        r._mode = mode;
        r.setConnectFlow(flow);
        r.hoverPoint = hover;
        return { r, objs: [rope, balloon], flow };
    }

    it('hovering a tied square paints the knot facts; a free square paints no-knot', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        rope.attachEndpoint('end', balloon, 'knot');
        const midSq = rope.getTieSeats().find((s) => s.role === 'mid');
        const endSq = rope.getTieSeats().find((s) => s.role === 'end');

        // Hover the free MID square: knot-less seat facts.
        const wired = makeEditRenderer(rope, balloon, 'EDITING', { x: midSq.worldPoint.x, y: midSq.worldPoint.y });
        let ctx = makeDrawCtx();
        wired.r._drawKnotTooltip(ctx, wired.objs);
        let texts = ctx.fillText.mock.calls.map((c) => c[0]);
        expect(texts.join('\n')).toContain(`rope #${rope.id}`);
        expect(texts.join('\n')).toMatch(/seat mid \(body \d+\)/);
        expect(texts.join('\n')).toContain('no knot');
        expect(ctx.fillRect).toHaveBeenCalled(); // the tooltip box

        // Hover the tied END square: the knot's own facts.
        wired.r.hoverPoint = { x: endSq.worldPoint.x, y: endSq.worldPoint.y };
        ctx = makeDrawCtx();
        wired.r._drawKnotTooltip(ctx, wired.objs);
        texts = ctx.fillText.mock.calls.map((c) => c[0]);
        expect(texts.join('\n')).toContain(`knot → balloon #${balloon.id}`);
        expect(texts.join('\n')).toContain('point knot');
        expect(texts.join('\n')).toContain('pending-bind'); // no engine: link unconfirmed
        expect(texts.join('\n')).not.toContain('no knot');
        rope.dispose();
        balloon.dispose();
    });

    it('no hover, no square: the tooltip paints nothing', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        const wired = makeEditRenderer(rope, balloon, 'EDITING', null);
        let ctx = makeDrawCtx();
        wired.r._drawKnotTooltip(ctx, wired.objs);
        expect(ctx.fillText).not.toHaveBeenCalled();

        wired.r.hoverPoint = { x: 30, y: 30 }; // empty space
        ctx = makeDrawCtx();
        wired.r._drawKnotTooltip(ctx, wired.objs);
        expect(ctx.fillText).not.toHaveBeenCalled();
        rope.dispose();
        balloon.dispose();
    });

    it('Knot tooltips are edit-only: PLAY suppresses them, SANDBOX keeps them', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        const endSq = rope.getTieSeats().find((s) => s.role === 'end');
        const hover = { x: endSq.worldPoint.x, y: endSq.worldPoint.y };

        // PLAY: decision 9 - tooltips stay suppressed even with the cursor
        // parked exactly on a square.
        const playing = makeEditRenderer(rope, balloon, 'PLAYING', hover);
        let ctx = makeDrawCtx();
        playing.r._drawKnotTooltip(ctx, playing.objs);
        expect(ctx.fillText).not.toHaveBeenCalled();
        expect(ctx.fillRect).not.toHaveBeenCalled();

        // SANDBOX: an edit stage - the tooltip answers.
        const sandbox = makeEditRenderer(rope, balloon, 'SANDBOX', hover);
        ctx = makeDrawCtx();
        sandbox.r._drawKnotTooltip(ctx, sandbox.objs);
        expect(ctx.fillText.mock.calls.length).toBeGreaterThan(0);
        rope.dispose();
        balloon.dispose();
    });
});

describe('Rope debug overlay on the renderer - the toggle and its gates (seams 3+4)', () => {
    function pictureReady() {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const rope = new Rope(100, 100, { length: 40 });
        const balloon = new Balloon(110, 180);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint('end', balloon, 'knot');
        physics.step(DT); // realize the link: a live picture to draw
        return { physics, rope, balloon };
    }

    it('defaults off, and a disabled overlay draws nothing - not even in play', () => {
        const { rope, balloon } = pictureReady();
        const r = new Renderer();
        r._physicsEngine = engines[engines.length - 1];
        r._mode = 'PLAYING';
        expect(r.showRopeDebugOverlay).toBe(false); // the default

        const ctx = makeDrawCtx();
        r._drawRopeDebugOverlay(ctx, [rope, balloon]);
        expect(ctx.arc).not.toHaveBeenCalled();
        expect(ctx.strokeRect).not.toHaveBeenCalled();
        expect(ctx.fillText).not.toHaveBeenCalled();
        rope.dispose();
        balloon.dispose();
    });

    it('explicitly enabled, it renders during play too - the one decision-9 exception', () => {
        const { physics, rope, balloon } = pictureReady();
        const r = new Renderer();
        r._physicsEngine = physics;
        r._mode = 'PLAYING';
        r.showRopeDebugOverlay = true;

        const ctx = makeDrawCtx();
        r._drawRopeDebugOverlay(ctx, [rope, balloon]);
        const arcs = ctx.arc.mock.calls.map(([x, y]) => ({ x, y }));
        expect(arcs.length).toBe(rope.bodies.length + 2); // outlines + the two link dots
        const seatBody = rope.getTieSeats().find((s) => s.role === 'end').body;
        const knotBody = balloon.attachmentPoints.find((p) => p.id === 'knot').body;
        expect(ctx.moveTo).toHaveBeenCalledWith(seatBody.position.x, seatBody.position.y);
        expect(ctx.lineTo).toHaveBeenCalledWith(knotBody.position.x, knotBody.position.y);
        rope.dispose();
        balloon.dispose();
    });

    it('explicitly enabled, it renders in the edit stages as well', () => {
        const { physics, rope, balloon } = pictureReady();
        const r = new Renderer();
        r._physicsEngine = physics;
        r._mode = 'EDITING';
        r.showRopeDebugOverlay = true;

        const ctx = makeDrawCtx();
        r._drawRopeDebugOverlay(ctx, [rope, balloon]);
        expect(ctx.arc).toHaveBeenCalled();
        rope.dispose();
        balloon.dispose();
    });
});
/** Bounds matcher: copies the bundle's own bounds answer. */
function boundsLike(b) {
    return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/** Minimal canvas 2D-context stub that records calls (no DOM/canvas in Node). */
describe('The connect-flow squares on the renderer — the tied seat keeps gold (issue #103)', () => {
    it('a tied seat under an armed seek paints gold, never the seeking blue, and the dashed preview points nowhere', () => {
        const rope = objectRegistry.create('free-rope', 300, 300); // bodyless coil: one anchor seat
        const spawnBall = new Balloon(360, 240);  // the coil tie's target: spawn hangs from its knot
        const otherBall = new Balloon(320, 380);  // the out-of-band mid tie's target
        const flow = new ConnectFlow();
        flow._mode = 'EDITING';

        flow.handlePointerDown(300, 300, [rope, spawnBall]); // the coil square seeks
        const knot1 = spawnBall.getAttachmentWorldPoint('knot');
        flow.handlePointerDown(knot1.x, knot1.y, [rope, spawnBall]); // the spawn tie; the flow armed the MID seat (issue #103)
        expect(flow.seek.role).toBe('mid');

        // The armed seat gets tied OUT OF BAND — the restore path binds
        // its tokens straight into the rope — so the armed square's truth
        // is now occupied while the flow still reports the seek on it.
        rope.attachEndpoint('mid', otherBall, 'knot');
        flow.setPreview(500, 400); // the aim the armed seek keeps reporting

        const r = new Renderer();
        r._mode = 'EDITING';
        r.setConnectFlow(flow);
        r.hoverPoint = null;
        const ctx = makeDrawCtx();
        r._drawConnectSquares(ctx, [rope, spawnBall, otherBall]);

        // The tied square paints gold — the seeking blue LOSES the
        // priority fight (issue #103): an occupied seat is never painted
        // as a live blue aiming square.
        expect(ctx.fillStyles).toContainEqual('rgba(184, 134, 11, 0.85)');
        expect(ctx.fillStyles).not.toContainEqual('rgba(64, 128, 255, 0.9)');
        // And the dashed preview never points at the cursor while the
        // armed seat is occupied: no line leaves the armed square.
        expect(ctx.lineTo).not.toHaveBeenCalled();

        rope.dispose();
        spawnBall.dispose();
        otherBall.dispose();
    });
});

function makeDrawCtx() {
    const ctx = {};
    const strokeStyleLog = [];
    const fillStyleLog = [];
    const fontLog = [];
    for (const fn of [
        'save', 'restore', 'beginPath', 'moveTo', 'lineTo',
        'arc', 'fillRect', 'strokeRect', 'fill', 'stroke', 'setLineDash',
        'fillText',
    ]) {
        ctx[fn] = vi.fn();
    }
    // Rendering code assigns styles as it goes; keep the whole history.
    Object.defineProperty(ctx, 'strokeStyle', {
        set(v) { strokeStyleLog.push(v); },
        get() { return strokeStyleLog[strokeStyleLog.length - 1]; },
    });
    Object.defineProperty(ctx, 'fillStyle', {
        set(v) { fillStyleLog.push(v); },
        get() { return fillStyleLog[fillStyleLog.length - 1]; },
    });
    Object.defineProperty(ctx, 'font', {
        set(v) { fontLog.push(v); },
        get() { return fontLog[fontLog.length - 1]; },
    });
    ctx.strokeStyles = strokeStyleLog;
    ctx.fillStyles = fillStyleLog;
    ctx.fonts = fontLog;
    return ctx;
}
