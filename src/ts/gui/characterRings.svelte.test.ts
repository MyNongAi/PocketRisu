import { describe, expect, test, vi } from 'vitest'
import { flushSync } from 'svelte'

const state = vi.hoisted(() => ({ db: null as any, selected: null as any }))
vi.mock('../stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    state.selected = writable(-1)
    return { DBState: { get db() { return state.db } }, selectedCharID: state.selected }
})

const { finishedReplies, clearFinishedReply } = await import('./chatReplyStatus')
const { charactersHoldingChats, characterRings } = await import('./characterRings.svelte')

describe('the bot list borders', () => {
    test('a bot holds a check when one of its chats does', () => {
        const characters = [
            { chaId: 'a', chats: [{ id: 'a1' }, { id: 'a2' }] },
            { chaId: 'b', chats: [{ id: 'b1' }] },
            null,
            { chaId: 'c' },
        ]
        expect([...charactersHoldingChats(new Set(['a2', 'gone']), characters)]).toEqual(['a'])
        expect(charactersHoldingChats(new Set(), characters).size).toBe(0)
    })

    test('yellow round the bot on screen, green round one whose reply came in, and they follow along', () => {
        const db = $state({ characters: [
            { chaId: 'a', chats: [{ id: 'a1' }] },
            { chaId: 'b', chats: [{ id: 'b1' }, { id: 'b2' }] },
        ] })
        state.db = db
        finishedReplies.set(new Set())
        const seen: Record<string, string | null> = {}
        const stop = $effect.root(() => {
            $effect(() => {
                seen.a = characterRings.of('a')
                seen.b = characterRings.of('b')
            })
        })
        flushSync()
        expect(seen).toEqual({ a: null, b: null })

        state.selected.set(0)
        finishedReplies.set(new Set(['b2']))
        flushSync()
        expect(seen).toEqual({ a: 'current', b: 'replied' })

        // Opening the bot: yellow wins over its own check.
        state.selected.set(1)
        flushSync()
        expect(seen).toEqual({ a: null, b: 'current' })

        state.selected.set(0)
        clearFinishedReply('b2')
        flushSync()
        expect(seen).toEqual({ a: 'current', b: null })

        // A chat made after its reply was marked (another device) still counts.
        finishedReplies.set(new Set(['b3']))
        flushSync()
        expect(seen.b).toBeNull()
        db.characters[1].chats.push({ id: 'b3' })
        flushSync()
        expect(seen.b).toBe('replied')

        expect(characterRings.of(undefined)).toBeNull()
        stop()
    })
})
