import { describe, expect, test } from 'vitest'
import { flushSync } from 'svelte'
import { foldStartFor, followChatFold, type ChatFoldTarget } from './chatFold.svelte'

const messages = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({ role: 'char', data: `${prefix}${i}`, chatId: `${prefix}${i}` }))

function setup() {
    const state = $state({
        selId: 0,
        characters: [
            { chaId: 'P', chatPage: 0, chats: [{ id: 'X', message: messages('p', 10) }, { id: 'Z', message: messages('z', 2) }] },
            { chaId: 'Q', chatPage: 0, chats: [{ id: 'Y', message: messages('q', 2) }] },
        ] as any[],
    })
    const fold = $state<{ data: ChatFoldTarget | null }>({ data: null })
    const index = $state({ index: -1 })
    const stop = $effect.root(() => {
        followChatFold(fold, index, () => state.characters[state.selId])
    })
    // Stands in for the save watchers: an effect root made after the fold's.
    let sentinelRuns = 0
    const stopSentinel = $effect.root(() => {
        $effect(() => {
            const character = state.characters[state.selId]
            void character?.chats?.[character.chatPage]?.message?.length
            sentinelRuns++
        })
    })
    flushSync()
    fold.data = { targetCharacterId: 'P', targetChatId: 'X', targetMessageId: 'p7' }
    flushSync()
    return {
        state,
        fold,
        index,
        runs: () => sentinelRuns,
        stop: () => { stop(); stopSentinel() },
    }
}

describe('folded chat view', () => {
    test('points at the folded message of the selected chat', () => {
        const { index, stop } = setup()
        expect(index.index).toBe(7)
        stop()
    })

    const moves: Array<[string, (state: any) => void]> = [
        ['another bot', (state) => { state.selId = 1 }],
        ['no bot', (state) => { state.selId = -1 }],
        ['a shorter chat of the same bot', (state) => { state.characters[0].chatPage = 1 }],
        ['a chat page past the end', (state) => { state.characters[0].chatPage = 5 }],
    ]
    for (const [name, move] of moves) {
        test(`drops the fold, without throwing, when the selection moves to ${name}`, () => {
            const { state, fold, index, runs, stop } = setup()
            move(state)
            expect(() => flushSync()).not.toThrow()
            expect(fold.data).toBeNull()
            expect(index.index).toBe(-1)

            // Effects queued after the fold's still run on later changes.
            const before = runs()
            const character = state.characters[state.selId]
            character?.chats?.[character.chatPage]?.message?.push({ role: 'user', data: 'new', chatId: 'new' })
            state.selId = 0
            state.characters[0].chatPage = 0
            flushSync()
            expect(runs()).toBeGreaterThan(before)
            stop()
        })
    }
})

describe('foldStartFor', () => {
    const fold: ChatFoldTarget = { targetCharacterId: 'P', targetChatId: 'X', targetMessageId: 'p7' }
    test('starts at the fold for its own chat', () => {
        expect(foldStartFor(7, fold, 'X', 10)).toBe(7)
    })
    test('ignores an index past the end of the chat on screen', () => {
        expect(foldStartFor(7, fold, 'X', 2)).toBe(-1)
    })
    test('ignores a fold made for another chat', () => {
        expect(foldStartFor(1, fold, 'Z', 2)).toBe(-1)
    })
    test('ignores no fold', () => {
        expect(foldStartFor(-1, fold, 'X', 10)).toBe(-1)
        expect(foldStartFor(3, null, 'X', 10)).toBe(-1)
    })
})
