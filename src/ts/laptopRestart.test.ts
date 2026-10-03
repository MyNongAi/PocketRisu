import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'auth-token' },
}))

import { laptopRestart, reloadThroughLaptop, type LaptopRestartDeps } from './laptopRestart.svelte'

type Reply = { status: number; body?: unknown } | 'refused'

/** A laptop whose answers are scripted per poll round. */
function harness(options: {
    restart: Reply
    log?: (round: number) => Reply
    up: (round: number) => boolean
}) {
    let clock = 0
    let round = 0
    const calls: string[] = []
    const reload = vi.fn()
    const reply = (r: Reply) => {
        if (r === 'refused') return Promise.reject(new TypeError('Failed to fetch'))
        return Promise.resolve(new Response(JSON.stringify(r.body ?? {}), { status: r.status }))
    }
    const deps: LaptopRestartDeps = {
        now: () => clock,
        sleep: async (ms) => { clock += ms; round++ },
        reload,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            calls.push(`${init?.method ?? 'GET'} ${url}`)
            if (url === '/api/laptop/restart') return reply(options.restart)
            if (url.startsWith('/build-id.txt')) return options.up(round) ? reply({ status: 200 }) : reply('refused')
            if (url.includes('/log?from=')) return reply(options.log ? options.log(round) : 'refused')
            throw new Error(`unexpected ${url}`)
        }) as typeof fetch,
    }
    return { deps, reload, calls }
}

describe('reloadThroughLaptop', () => {
    beforeEach(() => {
        laptopRestart.phase = 'idle'
    })

    it('just reloads when the server has no switch', async () => {
        const h = harness({ restart: { status: 503 }, up: () => true })
        await reloadThroughLaptop(h.deps)
        expect(h.reload).toHaveBeenCalledOnce()
        expect(laptopRestart.phase).toBe('idle')
    })

    it('follows the launcher log and reloads once the run ended and the server answers', async () => {
        const log = (round: number): Reply => {
            if (round === 1) return { status: 200, body: { text: '﻿20:09:12 실행 시작\nFrom https://github.com/x\n', next: 50, running: true } }
            if (round === 2) return { status: 200, body: { text: '20:09:13 서버 끄는 중...\n', next: 80, running: true } }
            return { status: 200, body: { text: round === 4 ? '20:09:42 서버가 켜졌습니다.\n' : '', next: 120, running: round < 4 } }
        }
        const h = harness({ restart: { status: 202, body: { log: '/pocketrisu-control' } }, log, up: (round) => round !== 2 && round !== 3 })
        await reloadThroughLaptop(h.deps)
        expect(h.reload).toHaveBeenCalledOnce()
        expect(laptopRestart.lines).toEqual(['20:09:12 실행 시작', '20:09:13 서버 끄는 중...', '20:09:42 서버가 켜졌습니다.'])
        expect(h.calls).toContain('GET /pocketrisu-control/log?from=50')
        expect(h.calls).toContain('GET /pocketrisu-control/log?from=80')
    })

    it('keeps the warnings on screen instead of reloading', async () => {
        const log = (round: number): Reply => round === 1
            ? { status: 200, body: { text: '20:09:15 [Warning] 업데이트를 건너뜁니다\n', next: 40, running: true } }
            : { status: 200, body: { text: '', next: 40, running: false } }
        const h = harness({ restart: { status: 202, body: { log: 'http://127.0.0.1:6010' } }, log, up: () => true })
        await reloadThroughLaptop(h.deps)
        expect(h.reload).not.toHaveBeenCalled()
        expect(laptopRestart.phase).toBe('warned')
        expect(laptopRestart.warnings).toEqual(['20:09:15 [Warning] 업데이트를 건너뜁니다'])
    })

    it('without the log, waits for the server to go down and come back', async () => {
        const h = harness({ restart: { status: 202, body: { log: '/pocketrisu-control' } }, up: (round) => round < 3 || round > 6 })
        await reloadThroughLaptop(h.deps)
        expect(h.reload).toHaveBeenCalledOnce()
        expect(h.calls.filter((c) => c.startsWith('GET /build-id.txt')).length).toBe(7)
    })

    it('gives up after 15 minutes', async () => {
        const h = harness({ restart: { status: 202, body: { log: '/pocketrisu-control' } }, up: () => false })
        await reloadThroughLaptop(h.deps)
        expect(h.reload).not.toHaveBeenCalled()
        expect(laptopRestart.phase).toBe('failed')
    })
})
