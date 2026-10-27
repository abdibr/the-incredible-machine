/**
 * make-bugfile-fixture — (re)generate the committed regression fixture
 * `tests/fixtures/bugfiles/ball-drop-ramp.json` (ADR 0006 decision 13).
 *
 * The fixture is a REAL recording: a synthetic sandbox session (ball dropped
 * onto a tilted ramp, 4 s) recorded by SessionRecorder with the same event
 * order the browser plays. Recordings are deterministic per the same code
 * version + Math library, so the committed fixture pins bit-exact replay as
 * a regression test; a future code change that breaks the physics parity
 * fails tests/replay.test.js until the fixture is re-graduated here.
 *
 * Run: node scripts/make-bugfile-fixture.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { SessionRecorder } from '../js/recorder/SessionRecorder.js';

registerAllObjects();

const DT = 1000 / 60;
const STEPS = 240;

const outPath = fileURLToPath(new URL('../tests/fixtures/bugfiles/ball-drop-ramp.json', import.meta.url));
const outDir = fileURLToPath(new URL('../tests/fixtures/bugfiles/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const board = [
    objectRegistry.create('ramp', 500, 300, { angle: 0.35 }),
    objectRegistry.create('ball', 520, 80),
];
const engine = new PhysicsEngine(1000, 600);
for (const obj of board) engine.addObject(obj);

const recorder = new SessionRecorder({ passive: true });
recorder.init({
    getBoard: () => board,
    getEngine: () => engine.engine, // the Matter engine, not the wrapper
    getPlayfield: () => ({ width: 1000, height: 600 }),
    getEngineInfo: () => ({ gravityX: 0, gravityY: 1, enableSleeping: true }),
});
recorder.notes = 'ball dropped onto a tilted ramp; rolls off the low end and bounces on the floor';
recorder.startSession();
for (const obj of board) {
    eventBus.emit('object:placed', { type: obj.type, id: obj.id, object: obj });
}
eventBus.emit('loop:play', { elapsed: 0 });

let elapsed = 0;
for (let i = 0; i < STEPS; i++) {
    engine.step(DT);
    elapsed += DT;
    eventBus.emit('loop:frame', { dt: DT, elapsed });
}
eventBus.emit('controls:reset');
recorder.dispose();

const file = recorder.toJSON();
writeFileSync(outPath, JSON.stringify(file, null, 2), 'utf8');
console.log(`[make-bugfile-fixture] wrote ${outPath}`);
console.log(`[make-bugfile-fixture] fileId=${file.fileId}, events=${file.runs[0].events.length}, poses=${file.runs[0].poses.rows.length}`);