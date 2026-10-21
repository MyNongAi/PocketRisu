import { describe, expect, it } from 'vitest'
import { alreadyLanded, catchUp, findChainEvent, queueNewestChat } from './remoteQueue'

const patch = (seq: number, prevHash: string, nextHash: string, instanceId = 'i1') => ({ seq, prevHash, nextHash, instanceId })

describe('queueNewestChat', () => {
    it('keeps one event per chat, the newest, at the end', () => {
        const queue = [{ chaId: 'a', chatId: '1', etag: 'e1' }, { chaId: 'a', chatId: '2', etag: 'x' }]
        queueNewestChat(queue, { chaId: 'a', chatId: '1', etag: 'e2' })
        expect(queue).toEqual([{ chaId: 'a', chatId: '2', etag: 'x' }, { chaId: 'a', chatId: '1', etag: 'e2' }])
    })
})

describe('findChainEvent', () => {
    it('finds the patch starting at the baseline, dropping ones it already holds', () => {
        const queue = [patch(1, 'h0', 'h1'), patch(2, 'h1', 'h2'), patch(3, 'h2', 'h3')]
        expect(findChainEvent(queue, 'h2', { instanceId: 'i1', seq: 1 })).toBe(queue[1])
        expect(queue.map((e) => e.seq)).toEqual([2, 3])
        expect(findChainEvent(queue, 'zz', null)).toBeUndefined()
    })

    it('does not drop patches numbered by another server instance', () => {
        expect(alreadyLanded(patch(1, 'a', 'b', 'old'), { instanceId: 'new', seq: 5 })).toBe(false)
        expect(alreadyLanded(patch(5, 'a', 'b', 'new'), { instanceId: 'new', seq: 5 })).toBe(true)
        expect(alreadyLanded(patch(5, 'a', 'b'), null)).toBe(false)
    })
})

describe('catchUp', () => {
    const run = (queue: any[], target: string, land: (e: any) => string, usable = true) => {
        let hash = 'h0'
        let clock = 0
        return catchUp({
            target,
            queue,
            hash: () => hash,
            cursor: () => null,
            land: async (e) => { const r = land(e); if (r === 'applied') hash = e.nextHash; return r },
            usable: () => usable,
            deadlineMs: 1500,
            sleep: async (ms) => { clock += ms },
            now: () => clock,
        }).then((ok) => ({ ok, hash }))
    }

    it('lands queued patches in chain order up to the server hash', async () => {
        const queue = [patch(2, 'h1', 'h2'), patch(1, 'h0', 'h1')]
        expect(await run(queue, 'h2', () => 'applied')).toEqual({ ok: true, hash: 'h2' })
        expect(queue).toEqual([])
    })

    it('gives up on a gap the stream cannot fill, or a patch that does not land', async () => {
        expect((await run([patch(2, 'h1', 'h2')], 'h2', () => 'applied')).ok).toBe(false)
        expect((await run([patch(1, 'h0', 'h1')], 'h1', () => 'conflict')).ok).toBe(false)
        expect((await run([], 'h1', () => 'applied', false)).ok).toBe(false)
    })

    it('retries a patch while the page is busy, within the deadline', async () => {
        let tries = 0
        const result = await run([patch(1, 'h0', 'h1')], 'h1', () => (++tries < 3 ? 'busy' : 'applied'))
        expect(result).toEqual({ ok: true, hash: 'h1' })
        expect(tries).toBe(3)
    })
})
