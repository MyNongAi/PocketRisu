import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createSyncHub } = require('./sync-hub.cjs')

class FakeResponse extends EventEmitter {
    chunks: string[] = []
    status = 0
    headers: Record<string, string> = {}
    ended = false
    writableLength = 0
    writeHead(status: number, headers: Record<string, string>) {
        this.status = status
        this.headers = headers
    }
    flushHeaders() {}
    write(chunk: string) {
        this.chunks.push(chunk)
        return true
    }
    end() {
        this.ended = true
    }
    events() {
        return this.chunks.join('').split('\n\n').filter(Boolean).flatMap((frame) => {
            const name = /^event: (.+)$/m.exec(frame)?.[1]
            const data = /^data: (.+)$/m.exec(frame)?.[1]
            return name && data ? [{ name, data: JSON.parse(data) }] : []
        })
    }
}

describe('sync hub', () => {
    it('streams live events to every subscriber as server-sent events', () => {
        const hub = createSyncHub({ heartbeatMs: 60_000 })
        const a = new FakeResponse()
        const b = new FakeResponse()
        hub.subscribe(a)
        hub.subscribe(b)

        hub.publish({ type: 'chat', origin: 'phone', chaId: 'c1', chatId: 'x', etag: 'e1' })

        expect(a.status).toBe(200)
        expect(a.headers['Content-Type']).toMatch(/text\/event-stream/)
        expect(a.headers['X-Accel-Buffering']).toBe('no')
        for (const res of [a, b]) {
            const [hello, chat] = res.events()
            expect(hello).toEqual({ name: 'hello', data: { instanceId: hub.instanceId, seq: 0, resync: false } })
            expect(chat.name).toBe('chat')
            expect(chat.data).toMatchObject({ seq: 1, origin: 'phone', chaId: 'c1', chatId: 'x', etag: 'e1' })
        }
        hub.closeAll()
    })

    it('replays what a reconnecting client missed, and only that', () => {
        const hub = createSyncHub({ heartbeatMs: 60_000 })
        hub.publish({ type: 'chat', chatId: 'one' })
        hub.publish({ type: 'chat', chatId: 'two' })
        hub.publish({ type: 'chat', chatId: 'three' })

        const res = new FakeResponse()
        hub.subscribe(res, { since: 1, instance: hub.instanceId })

        const events = res.events()
        expect(events[0].data.resync).toBe(false)
        expect(events.slice(1).map((event) => event.data.chatId)).toEqual(['two', 'three'])
        hub.closeAll()
    })

    it('asks for a resync after a restart or when the gap is no longer buffered', () => {
        const hub = createSyncHub({ heartbeatMs: 60_000, maxEvents: 2 })
        for (const chatId of ['a', 'b', 'c', 'd']) hub.publish({ type: 'chat', chatId })

        const restarted = new FakeResponse()
        hub.subscribe(restarted, { since: 3, instance: 'an-older-server' })
        expect(restarted.events()).toHaveLength(1)
        expect(restarted.events()[0].data.resync).toBe(true)

        const tooOld = new FakeResponse()
        hub.subscribe(tooOld, { since: 1, instance: hub.instanceId })
        expect(tooOld.events()[0].data.resync).toBe(true)
        expect(tooOld.events()).toHaveLength(1)

        const justInside = new FakeResponse()
        hub.subscribe(justInside, { since: 2, instance: hub.instanceId })
        expect(justInside.events().slice(1).map((event) => event.data.chatId)).toEqual(['c', 'd'])
        hub.closeAll()
    })

    it('turns an oversized patch into a stale notice instead of streaming it', () => {
        const hub = createSyncHub({ heartbeatMs: 60_000, maxEventBytes: 1024 })
        const res = new FakeResponse()
        hub.subscribe(res)

        hub.publish({ type: 'db-patch', origin: 'phone', prevHash: 'a', nextHash: 'b', ops: [{ op: 'add', path: '/x', value: 'y'.repeat(4096) }] })

        const [, event] = res.events()
        expect(event.name).toBe('db-stale')
        expect(event.data).toMatchObject({ reason: 'too-large', origin: 'phone', nextHash: 'b', seq: 1 })
        hub.closeAll()
    })

    it('drops a subscriber that closes or stops reading', () => {
        const hub = createSyncHub({ heartbeatMs: 60_000, maxClientBacklogBytes: 10 })
        const gone = new FakeResponse()
        hub.subscribe(gone)
        expect(hub.clientCount).toBe(1)
        gone.emit('close')
        expect(hub.clientCount).toBe(0)

        const slow = new FakeResponse()
        hub.subscribe(slow)
        slow.writableLength = 11
        hub.publish({ type: 'chat', chatId: 'x' })
        expect(hub.clientCount).toBe(0)
        expect(slow.ended).toBe(true)
    })
})
