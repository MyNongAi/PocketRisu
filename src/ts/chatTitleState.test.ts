import { describe, expect, it } from 'vitest'
import { ageManualChatTitle, chatTitleClass, chatTitleState, clearChatTitleManual, markChatTitleManual, type ChatTitleHolder } from './chatTitleState'

describe('chatTitleState', () => {
    it('goes auto -> manual (green) -> stale (yellow) -> auto when cleared', () => {
        const bot: ChatTitleHolder = { chats: [{ id: 'a' }, { id: 'b' }] }
        expect(chatTitleState(bot, 'a')).toBe('auto')
        expect(chatTitleClass('auto')).toBe('')
        ageManualChatTitle(bot, 'a') // an automatic title does not age
        expect(chatTitleState(bot, 'a')).toBe('auto')
        markChatTitleManual(bot, 'a')
        expect(chatTitleState(bot, 'a')).toBe('manual')
        expect(chatTitleClass('manual')).toBe('text-green-400')
        ageManualChatTitle(bot, 'a')
        expect(chatTitleState(bot, 'a')).toBe('stale')
        expect(chatTitleClass('stale')).toBe('text-yellow-400')
        markChatTitleManual(bot, 'a') // renamed again: fresh
        expect(chatTitleState(bot, 'a')).toBe('manual')
        clearChatTitleManual(bot, 'a')
        expect(chatTitleState(bot, 'a')).toBe('auto')
        expect(bot.nodeOnlyChatTitles).toBeUndefined()
        expect(chatTitleState(bot, 'b')).toBe('auto')
    })

    it('forgets chats that no longer exist when it writes', () => {
        const bot: ChatTitleHolder = { chats: [{ id: 'a' }], nodeOnlyChatTitles: { gone: 'manual', a: 'stale' } }
        markChatTitleManual(bot, 'a')
        expect(bot.nodeOnlyChatTitles).toEqual({ a: 'manual' })
    })
})
