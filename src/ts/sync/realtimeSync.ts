// Live change feed client: keeps one server-sent event stream open and hands
// other devices' writes to the handlers (see server/node/sync-hub.cjs).
//
// The stream only speeds things up. Every handler may decline an event, and a
// dropped connection simply resumes from the last sequence seen; whatever this
// page misses is still caught by the save path's conflict handling.

import { createSseParser } from './sseParser'

export interface DbPatchEvent {
    type: 'db-patch'
    seq: number
    origin: string
    prevHash: string
    nextHash: string
    ops: any[]
}

export interface DbStaleEvent {
    type: 'db-stale'
    seq: number
    origin: string
    reason: string
}

export interface ChatEvent {
    type: 'chat'
    seq: number
    origin: string
    chaId: string
    chatId: string
    etag: string
}

export interface RealtimeHandlers {
    onDbPatch?: (event: DbPatchEvent) => void
    onDbStale?: (event: DbStaleEvent) => void
    onChat?: (event: ChatEvent) => void
    /** The server restarted or this page slept past its buffer: events were lost. */
    onResync?: () => void
}

export interface RealtimeDeps {
    openStream: (query: string, signal: AbortSignal) => Promise<Response>
    /** This page's write identity; its own events are skipped. */
    clientId: string
    /**
     * Where the feed stood when the database this page holds was read. The
     * first connection replays from there, so nothing written while a large
     * database was still decoding is missed.
     */
    initialCursor?: { instanceId: string, seq: number } | null
    /** No bytes (the server pings every 20s) for this long means a dead link. */
    idleTimeoutMs?: number
    backoffMs?: readonly number[]
}

export interface RealtimeConnection {
    stop(): void
    /** Reconnect now, e.g. after the page became visible again. */
    wake(): void
    readonly connected: boolean
}

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10000, 30000]

export function startRealtimeSync(handlers: RealtimeHandlers, deps: RealtimeDeps): RealtimeConnection {
    const idleTimeoutMs = deps.idleTimeoutMs ?? 50_000
    const backoff = deps.backoffMs ?? DEFAULT_BACKOFF

    let stopped = false
    let connected = false
    let instanceId: string | null = deps.initialCursor?.instanceId ?? null
    let lastSeq = deps.initialCursor?.seq ?? 0
    let attempt = 0
    let controller: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let running = false

    function armIdle() {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => controller?.abort(), idleTimeoutMs)
    }

    function dispatch(event: string, data: string) {
        let payload: any
        try {
            payload = JSON.parse(data)
        } catch {
            return
        }
        if (event === 'hello') {
            const sameServer = instanceId === payload.instanceId
            const lost = instanceId !== null && (!sameServer || payload.resync === true)
            instanceId = payload.instanceId
            // A first connection (or a resync) starts from now: history before
            // this point is already in the state the page loaded.
            if (!sameServer || payload.resync) lastSeq = payload.seq
            if (lost) handlers.onResync?.()
            return
        }
        if (typeof payload?.seq !== 'number' || payload.seq <= lastSeq) return
        lastSeq = payload.seq
        if (payload.origin && payload.origin === deps.clientId) return
        try {
            if (event === 'db-patch') handlers.onDbPatch?.(payload)
            else if (event === 'db-stale') handlers.onDbStale?.(payload)
            else if (event === 'chat') handlers.onChat?.(payload)
        } catch (error) {
            console.warn('[RealtimeSync] handler failed:', error)
        }
    }

    async function runOnce() {
        controller = new AbortController()
        const query = instanceId
            ? `instance=${encodeURIComponent(instanceId)}&since=${lastSeq}`
            : ''
        armIdle()
        const response = await deps.openStream(query, controller.signal)
        if (!response.ok || !response.body) {
            throw new Error(`sync stream failed: ${response.status}`)
        }
        connected = true
        attempt = 0
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const feed = createSseParser(({ event, data }) => dispatch(event, data))
        try {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                armIdle()
                feed(decoder.decode(value, { stream: true }))
            }
        } finally {
            connected = false
            try { reader.releaseLock() } catch { /* already released */ }
        }
    }

    async function loop() {
        if (running) return
        running = true
        try {
            while (!stopped) {
                try {
                    await runOnce()
                } catch (error) {
                    if (!stopped && !(error instanceof DOMException && error.name === 'AbortError')) {
                        console.warn('[RealtimeSync] stream ended:', error instanceof Error ? error.message : error)
                    }
                } finally {
                    if (idleTimer) clearTimeout(idleTimer)
                    idleTimer = null
                }
                if (stopped) break
                const delay = backoff[Math.min(attempt, backoff.length - 1)]
                attempt++
                await new Promise<void>((resolve) => {
                    retryTimer = setTimeout(() => {
                        retryTimer = null
                        resolve()
                    }, delay)
                    wakeWaiter = resolve
                })
                wakeWaiter = null
            }
        } finally {
            running = false
        }
    }

    let wakeWaiter: (() => void) | null = null

    void loop()

    return {
        stop() {
            stopped = true
            controller?.abort()
            if (retryTimer) clearTimeout(retryTimer)
            if (idleTimer) clearTimeout(idleTimer)
            wakeWaiter?.()
        },
        wake() {
            if (stopped || connected) return
            attempt = 0
            if (retryTimer) {
                clearTimeout(retryTimer)
                retryTimer = null
            }
            wakeWaiter?.()
        },
        get connected() {
            return connected
        },
    }
}
