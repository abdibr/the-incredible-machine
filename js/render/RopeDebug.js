/**
 * RopeDebug - the debugging affordances of the rope connection redesign
 * (issue #59; ADR 0007 decision 9 and the Consequences "debugging gains
 * new surfaces" bullet).
 *
 * Two fact builders + two canvas painters, consumed by render/Renderer.js:
 *
 * - buildKnotTooltipData - the knot tooltip's facts: for one tie seat of a
 *   knot-bearing part it answers which seat/segment body the knot belongs
 *   to (the seat ROLE is THE address since issue #90), the target's type
 *   and id, the attachment point id, realized vs still pending-bind, and
 *   the severed flag. A knot-walking consumer riding the capability
 *   duck-check (getAttachmentRefs) - the same contract the bug-file
 *   narrator and the placed-board annotator gate on (C1, issue #75).
 *
 * - buildRopeOverlayData - the debug overlay's live engine picture: chain
 *   segment outlines, realized engine links, and derived reconcile/bind
 *   warnings for EVERY rope-family member. The family loop asks the rope
 *   module's own membership fact (Rope.ROPE_FAMILY_TYPES via isRopeFamily,
 *   C1 issue #75) - never a fresh enumeration, never a hand-rolled
 *   `type === 'rope'` pair.
 *
 * The tooltip facts come from existing state (live refs, the reconcile's
 * own realized-link predicate, the pending-bind token list); the overlay
 * adds nothing to the engine - it only reads it. The seat/point body pair
 * a knot ref resolves through is the rope's own method
 * (Rope.knotLinkBodies - the one owner the reconcile and the sever
 * consumer share; the former local copy retired so the tooltip cannot
 * drift from what the engine realizes).
 */

import { isRopeFamily, isSeveredRope } from '../objects/Rope.js';

/**
 * The knot tooltip's facts for one tie seat (issue #59, seam: tooltip fact
 * coverage). Everything rides existing state: live refs (issue 04), the
 * reconcile's realized-link predicate, the pending-bind token list.
 *
 * @param {import('../objects/BaseObject.js').default} carrier - the part
 *   whose seat is hovered; anything answering getAttachmentRefs() (the
 *   knot-walking duck check), other rows answer null.
 * @param {'anchor'|'mid'|'end'} role - the hovered seat's role.
 * @param {import('../engine/PhysicsEngine.js').PhysicsEngine|null} engine -
 *   the live engine (or null where there is none: realization cannot be
 *   confirmed, so a ref answers pending-bind).
 * @param {number|null} [bodyIndex=null] - the seat body's index in the
 *   carrier's bodies list (the connect-flow square's answer), -1 for a
 *   bodyless free bundle's coil seat; null omits the body gloss.
 * @returns {{carrier: object, carrierType: string, carrierId: number|string,
 *   role: string, bodyIndex: number|null, severed: boolean,
 *   knot: {targetType: string, targetId: number|string, pointId: string,
 *     state: 'realized'|'pending-bind', severed: boolean}|null,
 *   pendingTokens: Array<{seat: string, targetType: string,
 *     targetOrdinal: number, pointId: string, state: 'pending-bind'}>,
 *   knotless: boolean, lines: string[]}|null}
 */
export function buildKnotTooltipData(carrier, role, engine, bodyIndex = null) {
    // Knot-walking consumer (C1, issue #75): capability-first - whatever
    // offers attachment refs is a knot-bearing part; every other board row
    // answers no tooltip.
    if (!carrier || typeof carrier.getAttachmentRefs !== 'function') return null;

    const carrierType = carrier.type ?? 'part';
    const carrierId = carrier.id ?? '?';

    // One knot per seat (issue #85) is the family rule, so the seat's refs
    // hold one entry in every live case.
    const seatRefs = carrier.getAttachmentRefs().filter((ref) => ref.seat === role);

    // Pending-bind tokens (issue #57's deferral, issue #88's schema): the
    // restore tokens still awaiting bind. A token names a knot-to-be - the
    // tooltip presents it alongside the live state, never as one.
    const pendingTokens = (carrier.pendingAttachmentTokens ?? [])
        .filter((t) => t.seat === role)
        .map((t) => ({ ...t, state: 'pending-bind' }));

    let knot = null;
    if (seatRefs.length > 0) {
        const ref = seatRefs[0];
        const realized = linkRealized(engine, carrier.knotLinkBodies?.(ref) ?? null);
        knot = {
            targetType: ref.target?.type ?? '?',
            targetId: ref.target?.id ?? '?',
            pointId: ref.pointId,
            state: realized ? 'realized' : 'pending-bind',
            severed: isSeveredRope(ref.target),
        };
    }

    // The lines as the tooltip paints them - one fact per line, the same
    // strings the tests (and humans) quote.
    const lines = [`${carrierType} #${carrierId}`];
    if (bodyIndex === null) lines.push(`seat ${role}`);
    else if (bodyIndex === -1) lines.push(`seat ${role} (bundle coil)`);
    else lines.push(`seat ${role} (body ${bodyIndex})`);
    if (knot) {
        lines.push(`knot → ${knot.targetType} #${knot.targetId}`);
        lines.push(`point ${knot.pointId}`);
        lines.push(knot.state);
        if (knot.severed) lines.push('target severed');
    }
    for (const token of pendingTokens) {
        lines.push(`token → ${token.targetType} (ordinal ${token.targetOrdinal})`);
        lines.push(`point ${token.pointId}`);
        lines.push('pending-bind');
    }
    if (!knot && pendingTokens.length === 0) lines.push('no knot');
    else if (!knot) lines.push('no live knot');

    return {
        carrier,
        carrierType,
        carrierId,
        role,
        bodyIndex,
        severed: isSeveredRope(carrier),
        knot,
        pendingTokens,
        knotless: !knot && pendingTokens.length === 0,
        lines,
    };
}

// The seat/point body pair a knot ref resolves through is the carrier's
// own method: Rope.knotLinkBodies (one owner - rope, engine and this
// picture cannot drift). A carrier without it answers no resolvable
// bodies and every knot reads pending-bind.

/**
 * Whether the knot's engine link is realized right now - the reconcile's
 * own exists-check (order-agnostic body pair, rope body to target body).
 * No engine (or an unresolvable body) answers false: the knot reads
 * pending-bind until the link is confirmed.
 * @param {import('../engine/PhysicsEngine.js').PhysicsEngine|null} engine
 * @param {{seatBody: Matter.Body|null, targetBody: Matter.Body|null}|null} bodies -
 *   Rope.knotLinkBodies' answer (null where the carrier owns no resolution)
 * @returns {boolean}
 */
function linkRealized(engine, bodies) {
    if (!engine || !bodies?.seatBody || !bodies?.targetBody) return false;
    const links = engine.getAttachedConstraints?.() ?? [];
    return links.some((link) =>
        (link.bodyA === bodies.seatBody || link.bodyB === bodies.seatBody)
        && (link.bodyA === bodies.targetBody || link.bodyB === bodies.targetBody));
}

/**
 * The debug overlay's live engine picture (issue #59, seam: overlay
 * content): every rope-family member's chain segment outlines plus the
 * realized engine links the reconcile is holding, with the derived
 * reconcile/bind warnings per rope. Reads existing facts only - the
 * engine's attached-link registry (ADR 0004's seam) and the ropes' own
 * knot state; nothing is added to the engine for this.
 *
 * @param {import('../objects/BaseObject.js').default[]} objects - the live board
 * @param {import('../engine/PhysicsEngine.js').PhysicsEngine|null} engine -
 *   the live engine; links and realization warnings need it, outlines and
 *   token/ severed warnings do not.
 * @returns {{ropes: Array<{carrier: object, carrierType: string,
 *   carrierId: number|string, outlines: Array<{x: number, y: number, r: number}>,
 *   coil: boolean, coilBounds: {x: number, y: number, width: number, height: number}|null,
 *   warnings: Array<{reason: string, lines: string[]}>}>,
 *   links: Array<{a: {x: number, y: number}, b: {x: number, y: number}}>}}
 */
export function buildRopeOverlayData(objects, engine) {
    // THE family loop (C1, issue #75): membership is the rope module's
    // fact (isRopeFamily -> ROPE_FAMILY_TYPES), so a new family member
    // joins this picture with nothing changed here.
    const ropes = (objects ?? []).filter(isRopeFamily).map((rope) => buildRopePicture(rope, engine));
    return { ropes, links: buildRealizedLinks(engine) };
}

/**
 * One rope's overlay entry: its chain bodies as outlines (or, for a
 * bodyless free bundle, the coil bounds standing in), and the warnings
 * the debug picture flags - severed, pending-bind tokens, knots that
 * have no realized engine link, and knots whose target is severed (the
 * reconcile prunes those on its next step).
 * @param {import('../objects/BaseObject.js').default} rope
 * @param {import('../engine/PhysicsEngine.js').PhysicsEngine|null} engine
 * @returns {{carrier: object, carrierType: string, carrierId: number|string,
 *   outlines: Array<{x: number, y: number, r: number}>, coil: boolean,
 *   coilBounds: {x: number, y: number, width: number, height: number}|null,
 *   warnings: Array<{reason: string, lines: string[]}>}}
 */
function buildRopePicture(rope, engine) {
    const bodies = rope.bodies ?? [];
    const outlines = bodies.map((b) => ({
        x: b.position.x,
        y: b.position.y,
        r: typeof b.circleRadius === 'number' ? b.circleRadius : 6,
    }));
    const coil = bodies.length === 0; // the free bundle's bodyless coil (issue #55)

    const warnings = [];
    // Severed (A7 decision 7, piece severing issue #58): a piece-cut rope
    // keeps its pieces' knots realizing; the legacy record-less shape
    // realizes and binds nothing. Either way the debug picture marks it.
    if (isSeveredRope(rope)) {
        const pieces = typeof rope.getPieces === 'function' ? rope.getPieces().length : 0;
        warnings.push({
            reason: 'severed',
            lines: [pieces > 0
                ? `! severed - ${pieces} piece(s) keep their knots`
                : '! severed - a severed rope realizes and binds nothing'],
        });
    }
    // Unbound restore tokens (the issue #57 bind-order deferral): knots the
    // board still owes, visible until a bind pass takes them.
    const tokens = rope.pendingAttachmentTokens ?? [];
    if (tokens.length > 0) {
        warnings.push({ reason: 'pending-bind', lines: [`! ${tokens.length} attachment token(s) pending-bind`] });
    }
    // Per-knot reconcile state: a severed target prunes on the next step
    // (the severed-target refusal's family truth), a knot with no realized
    // engine link is still pending-bind.
    for (const ref of rope.getAttachmentRefs?.() ?? []) {
        const target = ref.target;
        if (isSeveredRope(target)) {
            warnings.push({ reason: 'severed-target', lines: [`! knot ${ref.seat} → ${target?.type ?? '?'} #${target?.id ?? '?'} target severed`] });
        } else if (!linkRealized(engine, rope.knotLinkBodies?.(ref) ?? null)) {
            warnings.push({ reason: 'pending-bind', lines: [`! knot ${ref.seat} → ${target?.type ?? '?'} #${target?.id ?? '?'} pending-bind`] });
        }
    }

    return {
        carrier: rope,
        carrierType: rope.type ?? 'part',
        carrierId: rope.id ?? '?',
        outlines,
        coil,
        coilBounds: coil ? rope.bounds : null,
        warnings,
    };
}

/**
 * The realized knot links the engine is holding, as body-position pairs -
 * every ADR 0004 attached link whose either endpoint belongs to a
 * rope-family member (a knot link always has the rope's body on one side;
 * inbound rope-to-rope pairs count there once - the engine registry holds
 * each link exactly once, so the picture never double-paints a pair).
 * @param {import('../engine/PhysicsEngine.js').PhysicsEngine|null} engine
 * @returns {Array<{a: {x: number, y: number}, b: {x: number, y: number}}>}
 */
function buildRealizedLinks(engine) {
    if (!engine || typeof engine.getAttachedConstraints !== 'function') return [];
    const ropeOwned = (body) => {
        const owner = typeof engine.getObjectForBody === 'function'
            ? engine.getObjectForBody(body) : null;
        return isRopeFamily(owner);
    };
    return engine.getAttachedConstraints()
        .filter((link) => ropeOwned(link.bodyA) || ropeOwned(link.bodyB))
        .map((link) => ({
            a: { x: link.bodyA.position.x, y: link.bodyA.position.y },
            b: { x: link.bodyB.position.x, y: link.bodyB.position.y },
        }));
}

/** Overlay outline stroke - the chain segments' distinct debug cyan. */
const OVERLAY_OUTLINE_COLOR = '#2fa8d8';
/** Overlay link stroke - the realized knot links' debug magenta. */
const OVERLAY_LINK_COLOR = '#c04fd0';

/**
 * Paint the debug picture (issue #59): segment outlines, the coil bounds
 * for a bodyless bundle, one line + endpoint dots per realized link, and
 * a warning badge above every rope carrying warnings. Renders whenever
 * called with a picture - the PLAYER-facing gate lives on the renderer
 * (showRopeDebugOverlay), because the enabled-in-play case is the one
 * deliberate decision-9 exception.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ropes: Array, links: Array}|null} data - buildRopeOverlayData's answer
 */
export function drawRopeDebugOverlay(ctx, data) {
    if (!data) return;
    ctx.save();

    // Chain segment outlines (and the bundle's dashed coil bounds).
    ctx.strokeStyle = OVERLAY_OUTLINE_COLOR;
    ctx.lineWidth = 1.5;
    for (const rope of data.ropes) {
        for (const o of rope.outlines) {
            ctx.beginPath();
            ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
            ctx.stroke();
        }
        if (rope.coil && rope.coilBounds) {
            const b = rope.coilBounds;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(b.x - 2, b.y - 2, b.width + 4, b.height + 4);
            ctx.setLineDash([]);
        }
    }

    // Realized knot links: the pair as one line, pinned by dots at its ends.
    ctx.strokeStyle = OVERLAY_LINK_COLOR;
    ctx.fillStyle = OVERLAY_LINK_COLOR;
    ctx.lineWidth = 2;
    for (const link of data.links) {
        ctx.beginPath();
        ctx.moveTo(link.a.x, link.a.y);
        ctx.lineTo(link.b.x, link.b.y);
        ctx.stroke();
        for (const p of [link.a, link.b]) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Reconcile/bind warnings read as text above the rope they describe.
    ctx.font = '10px monospace';
    for (const rope of data.ropes) {
        if (rope.warnings.length === 0) continue;
        const lines = rope.warnings.flatMap((w) => w.lines);
        const b = rope.carrier.bounds;
        const width = Math.max(...lines.map((l) => l.length)) * 6 + 10;
        const height = lines.length * 12 + 6;
        const x = b.x;
        const y = Math.max(2, b.y - height - 4);
        ctx.fillStyle = 'rgba(40, 12, 12, 0.9)';
        ctx.strokeStyle = '#e34e4e';
        ctx.lineWidth = 1;
        ctx.fillRect(x, y, width, height);
        ctx.strokeRect(x, y, width, height);
        ctx.fillStyle = '#ffd9d9';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        lines.forEach((line, i) => ctx.fillText(line, x + 5, y + 4 + 12 * i));
    }

    ctx.restore();
}

/**
 * Paint the knot tooltip (issue #59): the seat's fact lines in one badge
 * anchored just off the hovered square. The refusal badge's painting
 * convention - a dark box, an edge stroke, monospace lines - so the two
 * read as the same family of on-canvas messages.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{lines: string[]}|null} data - buildKnotTooltipData's answer
 * @param {number} x - the hovered square's canvas x
 * @param {number} y - the hovered square's canvas y
 */
export function drawKnotTooltip(ctx, data, x, y) {
    if (!data || data.lines.length === 0) return;
    ctx.save();
    const lineHeight = 13;
    const pad = 5;
    const width = Math.max(...data.lines.map((l) => l.length)) * 7 + pad * 2;
    const height = data.lines.length * lineHeight + pad * 2;
    const bx = x + 12;
    const by = y + 10;
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(24, 22, 18, 0.92)';
    ctx.strokeStyle = '#8a6508';
    ctx.lineWidth = 1;
    ctx.fillRect(bx, by, width, height);
    ctx.strokeRect(bx, by, width, height);
    ctx.fillStyle = '#f2e8d8';
    data.lines.forEach((line, i) => ctx.fillText(line, bx + pad, by + pad + lineHeight * i));
    ctx.restore();
}
