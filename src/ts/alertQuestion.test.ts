import { afterEach, describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'

vi.mock(import('./storage/database.svelte'), () => ({
    getDatabase: () => ({ modules: [] }),
    getCurrentChat: () => null,
    getCurrentCharacter: () => null,
    nodeOnlyVer: 'test',
} as any))

const { alertMinimizedStore, alertStore } = await import('./stores.svelte')
const { alertConfirm, alertConfirmMulti, alertInput, alertNormal, doingAlert } = await import('./alert')

const answer = (msg: string) => alertStore.set({ type: 'none', msg })
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

afterEach(() => {
    alertStore.set({ type: 'none', msg: '' })
    alertMinimizedStore.set(false)
})

describe('question alerts tucked away by a tap outside', () => {
    test('stay unanswered until the user answers them', async () => {
        let result: number | undefined
        void alertConfirmMulti('Import this large CHARX as what?', ['bot', 'module']).then((value) => { result = value })
        alertMinimizedStore.set(true)
        await settle()
        expect(result).toBeUndefined()
        expect(get(alertStore).type).toBe('confirmMulti')
        expect(doingAlert()).toBe(false)

        alertMinimizedStore.set(false)
        answer('1')
        await vi.waitFor(() => expect(result).toBe(1))
    })

    test('an alert in front of a question neither answers it nor loses it', async () => {
        let result: boolean | undefined
        void alertConfirm('Allow low-level access?', { stayOpen: true }).then((value) => { result = value })
        alertMinimizedStore.set(true)

        // Something else takes the screen and is closed with its own answer.
        alertNormal('Saved')
        expect(get(alertMinimizedStore)).toBe(false)
        answer('')
        await settle()
        expect(result).toBeUndefined()
        expect(get(alertStore)).toMatchObject({ type: 'ask', msg: 'Allow low-level access?' })

        answer('yes')
        await vi.waitFor(() => expect(result).toBe(true))
    })

    test('two questions each get their own answer', async () => {
        let first: boolean | undefined
        let second: string | undefined
        void alertConfirm('First?').then((value) => { first = value })
        alertMinimizedStore.set(true)
        void alertInput('Folder name').then((value) => { second = value })
        expect(get(alertStore).type).toBe('input')

        answer('Maps')
        await vi.waitFor(() => expect(second).toBe('Maps'))
        expect(first).toBeUndefined()
        await vi.waitFor(() => expect(get(alertStore).type).toBe('ask'))

        answer('no')
        await vi.waitFor(() => expect(first).toBe(false))
    })
})
