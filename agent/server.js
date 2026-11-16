/**
 * server - the headless turn service (ticket #45).
 *
 * A tiny dependency-free node:http JSON facade over the ONE named seam,
 * runTurn(actionJson) -> { observation, result } (agent/turn.js). No LLMs,
 * no containers here - later tickets wrap this service, and the browser
 * bundle stays untouched (nothing under js/ imports agent/).
 *
 *   node agent/server.js [--port 8787] [--host 127.0.0.1] [--level level-01]
 *
 * Endpoints (all responses are JSON, never a stack trace):
 *   POST /turn   { action: 'place'|'remove'|'rotate'|'nudge'|'reset'|'trial'|'observe', ...level? }
 *                -> { observation, result }  (one action per session turn)
 *   session scope: a request may carry a level id; it defaults to the
 *   current session's level, which itself defaults to level-01. ONE live
 *   session at a time (the shared eventBus forbids concurrent worlds).
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { AgentSession } from './session.js';
import { runTurn, KNOWN_ACTIONS, trialGuardError } from './turn.js';
import { parseFlags } from './cli-flags.js';

export const DEFAULT_LEVEL = 'level-01';

/** Request body cap - an HTTP service must not buffer without bound. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Level ids are plain puzzle names ('level-01'); never paths. */
const LEVEL_ID_RE = /^[\w-]{1,64}$/;

/**
 * The session scope: ONE live AgentSession at a time, scoped by level id.
 * Requests are serialized by the server's promise chain, so the shared
 * eventBus never sees two concurrent worlds.
 * @private
 */
function createSessionScope({ defaultLevel = DEFAULT_LEVEL } = {}) {
    let session = null;
    let currentLevel = null;

    function disposeCurrent() {
        session?.dispose();
        session = null;
        currentLevel = null;
    }

    async function ensure(wanted) {
        if (typeof wanted !== 'string' || !LEVEL_ID_RE.test(wanted)) {
            throw Object.assign(new Error(`invalid level id: ${JSON.stringify(wanted ?? null)}`), { statusCode: 400 });
        }
        if (session && currentLevel === wanted) return session;
        disposeCurrent();
        const next = new AgentSession();
        try {
            await next.loadLevel(wanted);
        } catch (e) {
            next.dispose();
            throw Object.assign(new Error(`cannot load level "${wanted}": ${e?.message ?? 'unknown error'}`), { statusCode: 400 });
        }
        session = next;
        currentLevel = wanted;
        return session;
    }

    /** Observation of whatever session is live, else a placeholder. */
    function describeCurrent() {
        return session ? runTurn({ action: 'observe' }, session).observation : '(no session)';
    }

    return { ensure, describeCurrent, dispose: disposeCurrent, get level() { return currentLevel ?? defaultLevel; } };
}

/** @private - collect the request body, capped. */
function readBody(req, limit = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error(`request body too large (max ${limit} bytes)`), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** @private - write one JSON response, nothing else ever leaves. */
function respond(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}

/**
 * @private - route one request. Everything is JSON; every failure is a
 * structured { observation, result } body with no stack trace. Known paths
 * reject wrong methods with a structured 405; unknown paths 404.
 */
async function handleRequest(req, res, scope) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
    try {
        switch (path) {
            case '/turn':
                if (req.method !== 'POST') return methodNotAllowed(req, res, scope, path);
                return await handleTurn(req, res, scope);
            case '/observation':
                if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(req, res, scope, path);
                return await handleObservation(req, res, scope, url.searchParams);
            case '/level':
                if (req.method !== 'POST') return methodNotAllowed(req, res, scope, path);
                return await handleLevel(req, res, scope);
            case '/health':
                if (req.method !== 'GET') return methodNotAllowed(req, res, scope, path);
                return respond(res, 200, { ok: true, level: scope.level });
            default:
                return respond(res, 404, {
                    observation: scope.describeCurrent(),
                    result: { ok: false, error: `unknown endpoint: ${req.method} ${path}` },
                });
        }
    } catch (e) {
        // One structured error shape everywhere: the complete envelope with a
        // failed result - machine-readable, never a stack trace or a throw.
        const status = e?.statusCode ?? 500;
        const error = status === 500 ? `internal error: ${e?.message ?? 'unknown'}` : e.message;
        return respond(res, status, { observation: scope.describeCurrent(), result: { ok: false, error } });
    }
}

/** @private */
function methodNotAllowed(req, res, scope, path) {
    respond(res, 405, {
        observation: scope.describeCurrent(),
        result: { ok: false, error: `method ${req.method} not allowed on ${path}` },
    });
}

/** @private - POST /turn: one action against the scoped session. */
async function handleTurn(req, res, scope) {
    const raw = await readBody(req);
    let actionJson = null;
    try {
        actionJson = JSON.parse(raw);
    } catch {
        actionJson = null; // malformed body -> runTurn's structured envelope
    }
    // THE one clamp (agent/turn.js): the same wording the driver tool answers
// with - out-of-range trial knobs are refused before they wedge the loop.
const refusal = actionJson && actionJson.action === 'trial' ? trialGuardError(actionJson) : null;
    if (refusal) {
        const session = await scope.ensure(actionJson.level ?? scope.level);
        return respond(res, 400, {
            observation: runTurn({ action: 'observe' }, session).observation,
            result: { ok: false, error: refusal },
        });
    }
    const usable =
        !!actionJson &&
        typeof actionJson === 'object' &&
        !Array.isArray(actionJson) &&
        KNOWN_ACTIONS.includes(actionJson.action);
    // A payload that is not a usable action object, or names no known
    // action, is a 400 - still through runTurn, so the envelope (with the
    // observation of the current world) stays complete.
    let requestedLevel = usable ? actionJson.level : undefined;
    const session = await scope.ensure(requestedLevel ?? scope.level);
    const turn = runTurn(actionJson, session);
    respond(res, usable ? 200 : 400, turn);
}

/** @private - GET|POST /observation: the observation block standalone. */
async function handleObservation(req, res, scope, params) {
    const raw = req.method === 'POST' ? await readBody(req) : '';
    let body = {};
    try {
        if (raw) body = JSON.parse(raw);
    } catch {
        body = {}; // query params still apply on a malformed body
    }
    const session = await scope.ensure(params.get('level') ?? body.level ?? scope.level);
    // THE raw-params map (ticket #95): query params overlay the JSON body
    // into ONE source object - the option keys themselves are whitelisted in
    // exactly one place, the observationOptions builder inside runTurn
    // (agent/turn.js), which also settles the string->boolean reading of
    // the raw query values. The HTTP composition and the /turn composition
    // are the same composition; a sixth option is one edit in turn.js.
    // The observe verb is PINNED LAST, after the body and query spreads:
    // this endpoint is the observation entry point, never an action path -
    // a client action key (body or query) cannot reach trial/reset here
    // (?action=trial&dt= would otherwise wedge the session chain forever).
    const turn = runTurn({ ...body, ...Object.fromEntries(params), action: 'observe' }, session);
    respond(res, 200, { level: scope.level, observation: turn.observation });
}

/** @private - POST /level: explicit level selection (scopes the session). */
async function handleLevel(req, res, scope) {
    const raw = await readBody(req);
    let body = {};
    try {
        if (raw) body = JSON.parse(raw);
    } catch {
        body = {}; // malformed body -> falls through to the current/default scope
    }
    const session = await scope.ensure(body.level ?? scope.level);
    const turn = runTurn({ action: 'observe' }, session);
    respond(res, 200, { level: scope.level, observation: turn.observation });
}
/**
 * Build the turn service as an http.Server (not listening) - tests and
 * tooling compose it. The server also carries `disposeSessions()` for a
 * clean teardown of the shared-eventBus subscriptions.
 *
 * @param {{ defaultLevel?: string }} [options]
 * @returns {import('node:http').Server & { disposeSessions(): void }}
 */
export function createTurnServer(options = {}) {
    const scope = createSessionScope(options);
    /** Serialization chain - requests touch the session strictly one at a time. */
    let chain = Promise.resolve();
    const server = createServer((req, res) => {
        chain = chain.then(() => handleRequest(req, res, scope)).catch(() => { /* handled inside */ });
    });
    server.disposeSessions = () => scope.dispose();
    return /** @type {typeof server & { disposeSessions(): void }} */ (server);
}

/**
 * Create + listen. Resolves once the port is bound.
 * @param {{ port?: number, host?: string, defaultLevel?: string }} [options]
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string, close(): Promise<void> }>}
 */
export async function startTurnServer({ port = 0, host = '127.0.0.1', ...rest } = {}) {
    const server = createTurnServer(rest);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
    const address = /** @type {{ port: number, address: string }} */ (server.address());
    const url = `http://${host}:${address.port}`;
    return {
        server,
        port: address.port,
        url,
        async close() {
            await new Promise((resolve) => server.close(() => resolve()));
            server.disposeSessions();
        },
    };
}


/* CLI entry: `node agent/server.js --port 8787 --level level-01` */
async function main() {
    const args = parseFlags(process.argv.slice(2));
    const service = await startTurnServer({
        port: Number(args.port) || 8787,
        host: args.host || '127.0.0.1',
        defaultLevel: args.level || DEFAULT_LEVEL,
    });
    console.log(`[agent] turn service on ${service.url} (default level: ${args.level || DEFAULT_LEVEL})`);
    process.on('SIGINT', () => {
        service.close().then(() => process.exit(0));
    });
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
    main().catch((e) => {
        console.error('[agent] fatal:', e);
        process.exitCode = 1;
    });
}
