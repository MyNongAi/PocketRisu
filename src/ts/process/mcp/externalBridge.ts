// PocketRisu as an MCP server (the user's request, 2026-10-31: Antigravity
// too, and no access to the prompts). Claude Code, Codex, Gemini CLI,
// Antigravity and other MCP clients on a subscription reach this page's Risu
// Access tools through the server (server/node/mcp-bridge.cjs): the server
// passes each call here over an event stream, the tool runs as in the bot
// edit mode, and the answer goes back by POST. A write asks first, unless the
// approval is 'auto', and backs its bot or module up into the database's own
// sitting (risuaccess/writeAccess.ts), which the settings page puts back.
//
// Only the bot, module, folder and chat-history tools listed here go out.
// None of them reads a prompt preset, a prompt or toggle template, a
// long-term memory summary prompt or a model preset (the promise of
// 2026-10-21); a tool Risu Access gains later stays inside until it is
// added here.
import { v4 } from 'uuid'
import { forageStorage } from 'src/ts/globalApi.svelte'
import { createSseParser } from 'src/ts/sync/sseParser'
import type { MCPTool, RPCToolCallContent } from './mcplib'

export const EXTERNAL_TOOLS: ReadonlySet<string> = new Set([
    'risu-list-characters',
    'risu-get-character-info',
    'risu-set-character-info',
    'risu-list-character-lorebooks',
    'risu-get-character-lorebook',
    'risu-set-character-lorebook',
    'risu-delete-character-lorebook',
    'risu-get-character-regex-scripts',
    'risu-set-character-regex-scripts',
    'risu-delete-character-regex-scripts',
    'risu-get-character-lua-script',
    'risu-set-character-lua-script',
    'risu-get-character-additional-assets',
    'risu-delete-character-additional-assets',
    'risu-get-chat-history',
    'risu-list-character-folders',
    'risu-list-folder-characters',
    'risu-list-folder-lorebooks',
    'risu-list-modules',
    'risu-get-module-info',
    'risu-set-module-info',
    'risu-list-module-lorebooks',
    'risu-get-module-lorebook',
    'risu-set-module-lorebook',
    'risu-delete-module-lorebook',
    'risu-get-module-regex-scripts',
    'risu-set-module-regex-script',
    'risu-delete-module-regex-script',
    'risu-get-module-lua-script',
    'risu-set-module-lua-script',
])

export interface BridgeCall {
    id: string
    kind: 'list' | 'call'
    name?: string
    arguments?: unknown
}

export interface ToolHost {
    serverInfo: { instructions?: string }
    getToolList(): Promise<MCPTool[]>
    callTool(name: string, args: unknown): Promise<RPCToolCallContent[]>
}

export type BridgeAnswer =
    | { tools: MCPTool[], instructions?: string }
    | { content: RPCToolCallContent[], isError?: boolean }

export async function answerCall(host: ToolHost, call: BridgeCall): Promise<BridgeAnswer> {
    if (call.kind === 'list') {
        const tools = (await host.getToolList()).filter((tool) => EXTERNAL_TOOLS.has(tool.name))
        return { tools, instructions: host.serverInfo.instructions }
    }
    if (typeof call.name !== 'string' || !EXTERNAL_TOOLS.has(call.name)) {
        return { content: [{ type: 'text', text: `Tool ${String(call.name)} is not available.` }], isError: true }
    }
    return { content: await host.callTool(call.name, call.arguments ?? {}) }
}

export interface BridgeDeps {
    /** An authenticated request to this server. */
    fetch: (path: string, init?: RequestInit) => Promise<Response>
    host: () => Promise<ToolHost>
    pageId: string
    /** Waits `ms`, or less when woken. */
    wait?: (ms: number, wake: Promise<void>) => Promise<void>
}

export interface BridgeConnection {
    /** Check again now (the settings page turned it on, the tab came back). */
    wake(): void
    /** This page is being used: send the calls here. */
    markActive(): void
    stop(): void
}

const ACTIVE_EVERY_MS = 15_000

function defaultWait(ms: number, wake: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        void wake.then(() => {
            clearTimeout(timer)
            resolve()
        })
    })
}

export function startMcpBridge(deps: BridgeDeps): BridgeConnection {
    const wait = deps.wait ?? defaultWait
    const page = encodeURIComponent(deps.pageId)
    let stopped = false
    let connected = false
    let stream: AbortController | null = null
    let woken: () => void = () => {}
    let wakeSignal = new Promise<void>((resolve) => { woken = resolve })
    let queue: Promise<void> = Promise.resolve()
    let lastActive = 0

    function wake() {
        woken()
        wakeSignal = new Promise<void>((resolve) => { woken = resolve })
    }

    function post(path: string, body: unknown) {
        return deps.fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
    }

    async function run(call: BridgeCall) {
        try {
            const result = await answerCall(await deps.host(), call)
            await post('/api/mcp/bridge/result', { page: deps.pageId, id: call.id, result })
        } catch (error) {
            await post('/api/mcp/bridge/result', { page: deps.pageId, id: call.id, error: String((error as Error)?.message ?? error) }).catch(() => {})
        }
    }

    async function enabled(): Promise<boolean> {
        try {
            const res = await deps.fetch(`/api/mcp/status?page=${page}`, { cache: 'no-store' })
            return res.ok && (await res.json())?.enabled === true
        } catch {
            return false
        }
    }

    async function listen() {
        stream = new AbortController()
        const res = await deps.fetch(`/api/mcp/bridge?page=${page}`, {
            signal: stream.signal,
            cache: 'no-store',
            headers: { accept: 'text/event-stream' },
        })
        if (!res.ok || !res.body) throw new Error(`MCP bridge ${res.status}`)
        connected = true
        lastActive = 0
        if (typeof document === 'undefined' || document.visibilityState === 'visible') markActive()
        const feed = createSseParser((message) => {
            if (message.event !== 'call') return
            let call: BridgeCall
            try {
                call = JSON.parse(message.data)
            } catch {
                return
            }
            // One at a time: a write waits for its question.
            queue = queue.then(() => run(call))
        })
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                feed(decoder.decode(value, { stream: true }))
            }
        } finally {
            connected = false
        }
    }

    function markActive() {
        if (!connected || Date.now() - lastActive < ACTIVE_EVERY_MS) return
        lastActive = Date.now()
        void post('/api/mcp/bridge/active', { page: deps.pageId }).catch(() => {})
    }

    void (async () => {
        let failures = 0
        while (!stopped) {
            if (!await enabled()) {
                // Off: nothing to hold open until asked again.
                await wakeSignal
                continue
            }
            try {
                await listen()
                failures = 0
            } catch {
                failures++
            }
            if (!stopped) await wait(Math.min(30_000, 1000 * 2 ** failures), wakeSignal)
        }
    })()

    return {
        wake,
        markActive,
        stop() {
            stopped = true
            stream?.abort()
            wake()
        },
    }
}

/** This page's name to the server, for the calls and the settings page. */
export const mcpBridgePageId = v4()

/** A request to this server as the signed-in page. */
export async function mcpServerFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('risu-auth', await forageStorage.createAuth())
    return fetch(path, { ...init, headers })
}

let connection: BridgeConnection | null = null

/** Start offering this page's tools (node server pages). */
export function startExternalMcpBridge(): void {
    if (connection) return
    let host: Promise<ToolHost> | null = null
    connection = startMcpBridge({
        fetch: mcpServerFetch,
        pageId: mcpBridgePageId,
        host: () => host ??= (async () => {
            const [{ RisuAccessClient }, { externalWriteAccess }] = await Promise.all([
                import('./risuaccess'),
                import('./risuaccess/writeAccess'),
            ])
            return new RisuAccessClient({ writeAccess: externalWriteAccess })
        })(),
    })
    const active = () => connection?.markActive()
    window.addEventListener('pointerdown', active, { passive: true })
    window.addEventListener('keydown', active, { passive: true })
    window.addEventListener('focus', active)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        connection?.wake()
        active()
    })
}

export function wakeExternalMcpBridge(): void {
    connection?.wake()
}
