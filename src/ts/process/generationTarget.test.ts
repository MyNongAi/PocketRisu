import { describe, expect, it } from 'vitest'
import type { Chat, character } from '../storage/database.svelte'
import { captureGenerationTarget, resolveGenerationTarget } from './generationTarget'

const chat = (id: string): Chat => ({ id, name: id, message: [] } as Chat)
const character = (chaId: string, chats: Chat[]): character => ({ chaId, chats } as character)

describe('generation target identity', () => {
    it('does not write a pre-send message into a chat page selected during an await', async () => {
        const a = chat('a')
        const b = chat('b')
        const char = character('char-1', [a, b])
        const target = captureGenerationTarget(char, a)

        await Promise.resolve()
        char.chatPage = 1
        const resolved = resolveGenerationTarget([char], target)
        resolved?.chat.message.push({ role: 'user', data: 'for-a' })

        expect(resolved?.chat).toBe(a)
        expect(a.message).toMatchObject([{ role: 'user', data: 'for-a' }])
        expect(b.message).toEqual([])
    })

    it('survives character and chat reordering by stable ids', () => {
        const a = chat('a')
        const original = character('char-1', [a])
        const target = captureGenerationTarget(original, a)
        const replacementA = chat('a')
        const replacementChar = character('char-1', [chat('other'), replacementA])
        const other = character('char-2', [])
        const resolved = resolveGenerationTarget([other, replacementChar], target)
        expect(resolved).toMatchObject({ characterIndex: 1, chatIndex: 1 })
        expect(resolved?.chat).toBe(replacementA)
    })

    it('fails closed when the target was deleted', () => {
        const a = chat('a')
        const char = character('char-1', [a])
        const target = captureGenerationTarget(char, a)
        expect(resolveGenerationTarget([character('char-1', [chat('b')])], target)).toBeNull()
    })

    it('fails closed on duplicate stable identities', () => {
        const a = chat('a')
        const original = character('char-1', [a])
        const target = captureGenerationTarget(original, a)
        expect(resolveGenerationTarget([
            character('char-1', [chat('a')]),
            character('char-1', [chat('a')]),
        ], target)).toBeNull()
    })

    it('assigns distinct stable ids to legacy chats before any await', () => {
        const first = { name: 'first', message: [] } as Chat
        const second = { name: 'second', message: [] } as Chat
        const char = character('char-1', [first, second])

        const firstTarget = captureGenerationTarget(char, first)
        const secondTarget = captureGenerationTarget(char, second)

        expect(firstTarget.chatId).toBeTruthy()
        expect(secondTarget.chatId).toBeTruthy()
        expect(firstTarget.chatId).not.toBe(secondTarget.chatId)
        expect(first.id).toBe(firstTarget.chatId)
        expect(second.id).toBe(secondTarget.chatId)
    })
})
