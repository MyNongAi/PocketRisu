// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'

vi.mock('svelte-sonner', () => ({ toast: { dismiss: vi.fn(), custom: vi.fn() } }))
vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: { characters: [] } }, selIdState: { selId: 0 } }))
vi.mock('src/ts/status/requestActions', () => ({ openChatById: vi.fn() }))
vi.mock('src/ts/status/requestStop', () => ({ stopRequestReply: vi.fn() }))

import RequestStatusToast from './RequestStatusToast.svelte'
import { clearStatus, startStatus } from 'src/ts/status/requestStatus'

const mounted: ReturnType<typeof mount>[] = []

function card(id: string) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(RequestStatusToast, { target, props: { id } }))
    flushSync()
    return target
}

afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component)
    clearStatus('memory-1')
    clearStatus('main-1')
    document.body.innerHTML = ''
})

describe('a request status card', () => {
    test('a memory (HypaV3) summary reads in red, a reply does not', () => {
        startStatus('memory-1', { kind: 'memory', label: 'flash', phase: 'responding', now: Date.now() })
        startStatus('main-1', { kind: 'main', label: 'argon', phase: 'responding', now: Date.now() })

        const memory = card('memory-1')
        expect(memory.querySelector('.rs-phase')?.classList.contains('text-draculared')).toBe(true)
        expect(memory.querySelector('.rs-chip')?.classList.contains('rs-chip-memory')).toBe(true)

        const reply = card('main-1')
        expect(reply.querySelector('.rs-phase')?.classList.contains('text-primary')).toBe(true)
        expect(reply.querySelector('.rs-chip')?.classList.contains('rs-chip-memory')).toBe(false)
    })
})
