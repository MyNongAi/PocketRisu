import { describe, expect, it } from 'vitest'
import type { Chat, character } from '../storage/database.svelte'
import { captureGenerationTarget, resolveGenerationTarget, writeBackToTarget } from './generationTarget'

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

// A button trigger's resulting chat (Chat.svelte handleButtonTriggerWithin).
describe('writing a trigger result back', () => {
    it("lands in the button's chat after the selection moved to another bot", () => {
        const a = chat('a')
        const b = chat('b')
        const charA = character('A', [a])
        const charB = character('B', [b])
        const owner = captureGenerationTarget(charA, a)
        const result = { ...a, message: [{ role: 'char', data: 'from-trigger' }] } as Chat
        const written = writeBackToTarget([charA, charB], owner, result)
        expect(written?.character).toBe(charA)
        expect(charA.chats[0].message).toMatchObject([{ data: 'from-trigger' }])
        expect(charB.chats[0]).toBe(b)
    })

    it('puts a live chat a Lua button returns back in its one slot', () => {
        const a = chat('a')
        const b = chat('b')
        const char = character('A', [a, b])
        const owner = captureGenerationTarget(char, a)
        writeBackToTarget([char], owner, a)
        expect(char.chats).toEqual([a, b])
    })

    it('follows a chat replaced by a same-id object meanwhile', () => {
        const a = chat('a')
        const char = character('A', [a])
        const owner = captureGenerationTarget(char, a)
        const replaced = chat('a')
        char.chats[0] = replaced
        const result = chat('a')
        expect(writeBackToTarget([char], owner, result)?.chat).toBe(result)
        expect(char.chats[0]).toBe(result)
    })

    it("writes nothing when the result is another chat's object", () => {
        const a = chat('a')
        const b = chat('b')
        const charA = character('A', [a])
        const charB = character('B', [b])
        const owner = captureGenerationTarget(charA, a)
        // A later Lua trigger ran on the chat selected meanwhile and returned it.
        expect(writeBackToTarget([charA, charB], owner, b)).toBeNull()
        expect(charA.chats[0]).toBe(a)
        expect(charB.chats[0]).toBe(b)
    })

    it('writes nothing when the chat is gone or unloaded', () => {
        const a = chat('a')
        const char = character('A', [a])
        const owner = captureGenerationTarget(char, a)
        char.chats[0] = { ...chat('a'), _placeholder: true } as Chat
        expect(writeBackToTarget([char], owner, chat('a'))).toBeNull()
        expect(char.chats[0]._placeholder).toBe(true)
        char.chats.splice(0, 1)
        expect(writeBackToTarget([char], owner, chat('a'))).toBeNull()
        expect(char.chats).toEqual([])
    })
})
