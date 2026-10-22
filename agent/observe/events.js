/**
 * events — eventBus → bounded ring buffer of readable occurrences.
 *
 * Subscribes for the duration of a trial only, records fixed event types
 * (EventBus has no wildcard support by design) and renders them as short
 * sentences with a seconds timestamp derived from the `loop:frame` stream.
 * This turns an opaque simulation into a causal narrative.
 */

import { eventBus } from '../../js/EventBus.js';

/** Event types recorded during a trial (fixed list — no wildcard in EventBus) */
export const RECORDED_TOPICS = [
    'goal:reached',
    'goal:failed',
    'bucket:caught',
    'rope:severed',
    'balloon:popped',
];

/** Default cap — older rows drop off the ring when exceeded */
export const DEFAULT_CAP = 400;

/** Turn one recorded packet into a short readable sentence. */
function sentenceFor(topic, packet, tMs) {
    const t = (tMs / 1000).toFixed(2);
    switch (topic) {
        case 'goal:reached':
            return { t, text: `goal reached (${packet?.levelId ?? '?'} <- GOAL REACHED)`, landmark: true };
        case 'goal:failed':
            return { t, text: `goal failed — ${packet?.reason ?? 'unknown'}`, landmark: true };
        case 'bucket:caught': {
            const who = packet?.object?.type ?? '?';
            const where = packet?.bucket?.customId ?? 'bucket';
            return { t, text: `${who} caught by ${where}`, who, where };
        }
        case 'rope:severed':
            return { t, text: 'rope severed' };
        case 'balloon:popped':
            return { t, text: 'balloon popped' };
        default:
            return { t, text: topic };
    }
}

export class EventRecorder {
    /**
     * @param {object} [options]
     * @param {number} [options.cap] ring buffer capacity
     * @param {string[]} [options.topics] fixed event-type list to record
     */
    constructor({ cap = DEFAULT_CAP, topics = RECORDED_TOPICS } = {}) {
        this._cap = cap;
        this._topics = topics;
        this._rows = [];
        this._unsubs = [];
        this._t = 0;
    }

    /** Subscribe on the shared eventBus (trial duration only). */
    start() {
        this._rows = [];
        this._t = 0;
        this._unsubs.push(
            ...this._topics.map((topic) =>
                eventBus.on(topic, (packet) => this._push(topic, packet)),
            ),
        );
        // loop:frame drives the clock; GoalChecker reads the same stream.
        this._unsubs.push(
            eventBus.on('loop:frame', ({ dt = 0 } = {}) => {
                this._t += dt;
            }),
        );
    }

    /** Unsubscribe everything; the buffer stays readable. */
    stop() {
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
    }

    /** @private */
    _push(topic, packet) {
        this._rows.push(sentenceFor(topic, packet, this._t));
        if (this._rows.length > this._cap) this._rows.splice(0, this._rows.length - this._cap);
    }

    /** @returns {number} trial clock in ms */
    get t() {
        return this._t;
    }

    /** @returns {Array<{t: string, text: string, landmark?: boolean}>} recorded rows */
    get rows() {
        return [...this._rows];
    }

    /**
     * Render the buffer as trial-log lines.
     * @param {object} [options]
     * @param {string} [options.header] first line (e.g. "trial #7…")
     * @returns {string[]} lines
     */
    render({ header = null } = {}) {
        const lines = header ? [header] : [];
        for (const row of this._rows) {
            lines.push(`  t=${row.t}s  ${row.text}`);
        }
        return lines;
    }
}