import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSseParser } from './sseParser'
import { startRealtimeSync, type RealtimeConnection } from './realtimeSync'

describe('createSseParser', () => {
    it('reassembles frames split across chunks and skips comments', () => {
        const seen: any[] = []
        const feed = createSseParser((message) => seen.push(message))
        feed('retry: 3000\n\n: ping\n\nid: 4\nevent: chat\nda')
        feed('ta: {"a":1}\n')
        expect(seen).toEqual([])
        feed('\nevent: hello\r\ndata: x\r\ndata: y\r\n\r\n')
        expect(seen).toEqual([
            { event: 'chat', data: '{"a":1}', id: '4' },
            { event: 'hello', data: 'x\ny', id: undefined },
        ])
    })
})

/** A controllable stream standing in for the server. */
function fakeServer() {
    const connections: { query: string, push: (text: string) => void, close: () => void }[] = []
    const openStream = vi.fn(async (query: string, signal: AbortSignal) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>
        const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
        const encoder = new TextEncoder()
        const connection = {
            query,
            push: (text: string) => controller.enqueue(encoder.encode(text)),
            close: () => { try { controller.close() } catch { /* closed */ } },
        }
        signal.addEventListener('abort', () => {
            try { controller.error(new DOMException('aborted', 'AbortError')) } catch { /* closed */ }
        })
        connections.push(connection)
        return new Response(body, { status: 200 })
    })
    const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
    return { connections, openStream, event }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

let connection: RealtimeConnection | null = null
afterEach(() => {
    connection?.stop()
    connection = null
})

describe('startRealtimeSync', () => {
    it('routes other devices\' events and skips this page\'s own writes', async () => {
        const server = fakeServer()
        const onChat = vi.fn()
        const onDbPatch = vi.fn()
        connection = startRealtimeSync({ onChat, onDbPatch }, { openStream: server.openStream, clientId: 'me', backoffMs: [5] })
        await settle()

        const [first] = server.connections
        expect(first.query).toBe('')
        first.push(server.event('hello', { instanceId: 'srv', seq: 7, resync: false }))
        first.push(server.event('chat', { seq: 8, origin: 'phone', chaId: 'c', chatId: 'x', etag: 'e' }))
        first.push(server.event('chat', { seq: 9, origin: 'me', chaId: 'c', chatId: 'y', etag: 'e' }))
        first.push(server.event('db-patch', { seq: 10, origin: 'phone', ops: [], prevHash: 'a', nextHash: 'b' }))
        await settle()

        expect(connection.connected).toBe(true)
        expect(onChat).toHaveBeenCalledTimes(1)
        expect(onChat.mock.calls[0][0]).toMatchObject({ chatId: 'x' })
        expect(onDbPatch).toHaveBeenCalledTimes(1)
    })

    it('resumes from the last sequence after a drop and ignores replays it already has', async () => {
        const server = fakeServer()
        const onChat = vi.fn()
        const onResync = vi.fn()
        connection = startRealtimeSync({ onChat, onResync }, { openStream: server.openStream, clientId: 'me', backoffMs: [5] })
        await settle()
        server.connections[0].push(server.event('hello', { instanceId: 'srv', seq: 3, resync: false }))
        server.connections[0].push(server.event('chat', { seq: 4, origin: 'phone', chatId: 'x' }))
        await settle()
        server.connections[0].close()
        await settle()
        await settle()

        const second = server.connections[1]
        expect(second.query).toBe('instance=srv&since=4')
        second.push(server.event('hello', { instanceId: 'srv', seq: 5, resync: false }))
        second.push(server.event('chat', { seq: 4, origin: 'phone', chatId: 'x' }))
        second.push(server.event('chat', { seq: 5, origin: 'phone', chatId: 'y' }))
        await settle()

        expect(onChat.mock.calls.map((call) => call[0].chatId)).toEqual(['x', 'y'])
        expect(onResync).not.toHaveBeenCalled()
    })

    it('starts from the position of the database copy the page loaded', async () => {
        const server = fakeServer()
        const onChat = vi.fn()
        connection = startRealtimeSync({ onChat }, {
            openStream: server.openStream,
            clientId: 'me',
            backoffMs: [5],
            initialCursor: { instanceId: 'srv', seq: 12 },
        })
        await settle()

        expect(server.connections[0].query).toBe('instance=srv&since=12')
        server.connections[0].push(server.event('hello', { instanceId: 'srv', seq: 14, resync: false }))
        server.connections[0].push(server.event('chat', { seq: 13, origin: 'phone', chatId: 'written-while-decoding' }))
        await settle()

        expect(onChat.mock.calls.map((call) => call[0].chatId)).toEqual(['written-while-decoding'])
    })

    it('reports lost history when the server restarted', async () => {
        const server = fakeServer()
        const onResync = vi.fn()
        const onChat = vi.fn()
        connection = startRealtimeSync({ onResync, onChat }, { openStream: server.openStream, clientId: 'me', backoffMs: [5] })
        await settle()
        server.connections[0].push(server.event('hello', { instanceId: 'old', seq: 50, resync: false }))
        await settle()
        server.connections[0].close()
        await settle()
        await settle()

        server.connections[1].push(server.event('hello', { instanceId: 'new', seq: 2, resync: true }))
        server.connections[1].push(server.event('chat', { seq: 3, origin: 'phone', chatId: 'z' }))
        await settle()

        expect(onResync).toHaveBeenCalledTimes(1)
        // Sequences restart with the new server; its events must still arrive.
        expect(onChat.mock.calls.map((call) => call[0].chatId)).toEqual(['z'])
    })

    it('reconnects when the link goes silent', async () => {
        const server = fakeServer()
        connection = startRealtimeSync({}, { openStream: server.openStream, clientId: 'me', backoffMs: [5], idleTimeoutMs: 30 })
        await settle()
        server.connections[0].push(server.event('hello', { instanceId: 'srv', seq: 0, resync: false }))
        await new Promise((resolve) => setTimeout(resolve, 80))
        expect(server.connections.length).toBeGreaterThanOrEqual(2)
    })
})
