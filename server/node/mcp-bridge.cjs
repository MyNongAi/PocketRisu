'use strict';

// PocketRisu as an MCP server (the user's request, 2026-10-31): Claude Code,
// Codex, Gemini CLI, Antigravity and other MCP clients on a subscription edit
// bots and modules through the same Risu Access tools the bot edit mode gives
// the chat model. The tools run in an open PocketRisu page, which asks before
// each write and backs the bot up first (src/ts/process/mcp/externalBridge.ts);
// this server only carries the calls:
//
//   client --POST /mcp (JSON-RPC, bearer token)--> here --SSE 'call'--> page
//   page --POST /api/mcp/bridge/result--> here --JSON-RPC result--> client
//
// The calls go to the page used last (a click, a key, the tab shown), so the
// question shows where the user is. The token lives in save/__mcp_token, next
// to the JWT secret, never in the database or its backups; without the file
// the endpoint is off. Streamable HTTP without sessions: every answer is one
// JSON body, and nothing is pushed to the client.

const fs = require('fs');
const path = require('path');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const TOKEN_FILE = '__mcp_token';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_INSTRUCTIONS = 'PocketRisu bot and module editing. The tools run in the PocketRisu page that is open; writes are confirmed there.';

const DEFAULTS = {
    // A write waits for the user to answer in the page.
    callTimeoutMs: 10 * 60_000,
    listTimeoutMs: 15_000,
    heartbeatMs: 20_000,
};

class BridgeError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function createMcpBridge(options = {}) {
    const config = { ...DEFAULTS, ...options };
    const tokenPath = path.join(config.dir, TOKEN_FILE);
    const logger = config.logger ?? console;
    const now = config.now ?? (() => Date.now());

    let token = null;
    try {
        token = fs.readFileSync(tokenPath, 'utf-8').trim() || null;
    } catch { /* off */ }

    const pages = new Map(); // pageId -> { res, activeAt, heartbeat, closed }
    const pending = new Map(); // callId -> { pageId, resolve, reject, timer }
    // The page's last tool list, for a client that connects while no page is open.
    let cachedList = null;

    function writeToken(value) {
        if (value === null) {
            fs.rmSync(tokenPath, { force: true });
        } else {
            fs.writeFileSync(tokenPath, value, { encoding: 'utf-8', mode: 0o600 });
        }
        token = value;
    }

    function newToken() {
        return `prmcp_${randomBytes(32).toString('base64url')}`;
    }

    function authorized(header) {
        if (!token || typeof header !== 'string') return false;
        const match = /^Bearer\s+(.+)$/i.exec(header.trim());
        if (!match) return false;
        const given = Buffer.from(match[1].trim());
        const expected = Buffer.from(token);
        return given.length === expected.length && timingSafeEqual(given, expected);
    }

    // ── Pages ────────────────────────────────────────────────────────────

    function send(page, frame) {
        if (page.closed) return;
        try {
            page.res.write(frame);
        } catch {
            detach(page);
        }
    }

    function detach(page) {
        if (page.closed) return;
        page.closed = true;
        clearInterval(page.heartbeat);
        if (pages.get(page.id) === page) pages.delete(page.id);
        try { page.res.end(); } catch { /* already gone */ }
        for (const [callId, call] of pending) {
            if (call.pageId === page.id) settleCall(callId, null, new BridgeError('page-closed', 'The PocketRisu page closed before answering.'));
        }
    }

    /** A page offering to run the tools: an event stream of calls. */
    function attach(res, pageId) {
        if (typeof pageId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(pageId)) {
            res.status(400).send({ error: 'page' });
            return null;
        }
        const previous = pages.get(pageId);
        if (previous) detach(previous);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        // Used when it says so (markActive); until then only if no page was.
        const page = { id: pageId, res, activeAt: 0, heartbeat: null, closed: false };
        pages.set(pageId, page);
        send(page, `retry: 5000\n\nevent: hello\ndata: {}\n\n`);
        page.heartbeat = setInterval(() => send(page, `: ping\n\n`), config.heartbeatMs);
        if (typeof page.heartbeat.unref === 'function') page.heartbeat.unref();
        res.on('close', () => detach(page));
        return page;
    }

    function markActive(pageId) {
        const page = pages.get(pageId);
        if (!page) return false;
        page.activeAt = now();
        return true;
    }

    /** The page used last. */
    function receiver() {
        let best = null;
        for (const page of pages.values()) {
            if (!page.closed && (!best || page.activeAt >= best.activeAt)) best = page;
        }
        return best;
    }

    function settleCall(callId, result, error) {
        const call = pending.get(callId);
        if (!call) return false;
        pending.delete(callId);
        clearTimeout(call.timer);
        if (error) call.reject(error);
        else call.resolve(result);
        return true;
    }

    /** A page's answer; only the page that was asked can answer. */
    function settle(pageId, body) {
        const call = body && typeof body.id === 'string' ? pending.get(body.id) : null;
        if (!call || call.pageId !== pageId) return false;
        if (typeof body.error === 'string') return settleCall(body.id, null, new BridgeError('page-error', body.error.slice(0, 2000)));
        return settleCall(body.id, body.result ?? null, null);
    }

    function ask(kind, payload, timeoutMs) {
        const page = receiver();
        if (!page) return Promise.reject(new BridgeError('no-page', 'No PocketRisu page is open. Open PocketRisu in a browser and try again.'));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => settleCall(id, null, new BridgeError('timeout', 'The PocketRisu page did not answer in time.')), timeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
            pending.set(id, { pageId: page.id, resolve, reject, timer });
            send(page, `event: call\ndata: ${JSON.stringify({ id, kind, ...payload })}\n\n`);
        });
    }

    // ── JSON-RPC ─────────────────────────────────────────────────────────

    async function listTools() {
        try {
            const result = await ask('list', {}, config.listTimeoutMs);
            if (result && Array.isArray(result.tools)) {
                cachedList = { tools: result.tools, instructions: typeof result.instructions === 'string' ? result.instructions : undefined };
            }
        } catch (error) {
            if (!cachedList) throw error;
        }
        return cachedList ?? { tools: [] };
    }

    async function handleMessage(message) {
        if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return rpcError(message?.id, -32600, 'Invalid Request');
        }
        const { id, method, params } = message;
        // Notifications (no id) are acknowledged without an answer.
        if (id === undefined || id === null) return null;
        try {
            switch (method) {
                case 'initialize': {
                    const asked = params?.protocolVersion;
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
                            capabilities: { tools: { listChanged: false } },
                            serverInfo: { name: 'PocketRisu', version: '1.0.0' },
                            instructions: cachedList?.instructions ?? DEFAULT_INSTRUCTIONS,
                        },
                    };
                }
                case 'ping':
                    return { jsonrpc: '2.0', id, result: {} };
                case 'tools/list': {
                    const { tools } = await listTools();
                    return { jsonrpc: '2.0', id, result: { tools } };
                }
                case 'tools/call': {
                    const name = params?.name;
                    if (typeof name !== 'string') return rpcError(id, -32602, 'Tool name is required');
                    const startedAt = now();
                    try {
                        const result = await ask('call', { name, arguments: params?.arguments ?? {} }, config.callTimeoutMs);
                        const content = Array.isArray(result?.content) ? result.content : [{ type: 'text', text: String(result?.text ?? '') }];
                        logger.info?.(`[MCP] ${name} answered in ${((now() - startedAt) / 1000).toFixed(1)}s`);
                        return { jsonrpc: '2.0', id, result: { content, isError: result?.isError === true } };
                    } catch (error) {
                        logger.info?.(`[MCP] ${name} failed: ${error.code ?? 'error'}`);
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true } };
                    }
                }
                default:
                    return rpcError(id, -32601, `Method not found: ${method}`);
            }
        } catch (error) {
            return rpcError(id, -32603, error.message);
        }
    }

    /** POST /mcp from a client. */
    async function handleHttp(req, res) {
        if (!token) {
            res.status(404).send({ error: 'The PocketRisu MCP server is off.' });
            return;
        }
        if (!authorized(req.headers.authorization)) {
            res.status(401).set('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
            return;
        }
        const body = req.body;
        if (body === undefined || body === null || typeof body !== 'object') {
            res.status(400).send(rpcError(null, -32700, 'Parse error'));
            return;
        }
        if (Array.isArray(body)) {
            const answers = (await Promise.all(body.map(handleMessage))).filter(Boolean);
            if (answers.length === 0) res.status(202).end();
            else res.send(answers);
            return;
        }
        const answer = await handleMessage(body);
        if (!answer) res.status(202).end();
        else res.send(answer);
    }

    return {
        attach,
        markActive,
        settle,
        handleHttp,
        handleMessage,
        authorized,
        /** For the settings page (authenticated): the token and who gets the calls. */
        status(pageId) {
            const current = receiver();
            return {
                enabled: token !== null,
                token,
                pages: pages.size,
                receiving: current ? current.id === pageId : false,
                receiverConnected: current !== null,
            };
        },
        enable() {
            if (!token) writeToken(newToken());
            return token;
        },
        rotate() {
            writeToken(newToken());
            return token;
        },
        disable() {
            writeToken(null);
            for (const [callId] of pending) settleCall(callId, null, new BridgeError('off', 'The PocketRisu MCP server was turned off.'));
            for (const page of [...pages.values()]) detach(page);
        },
        get pageCount() { return pages.size; },
        closeAll() { for (const page of [...pages.values()]) detach(page); },
    };
}

module.exports = { createMcpBridge, PROTOCOL_VERSIONS, TOKEN_FILE };
