import { describe, expect, it } from 'vitest'
import { defaultCBSRegisterArg, registerCBS, type matcherArg, type RegisterCallback } from './cbs'

describe('CBS request-local context', () => {
    it('uses the captured character, chat and persona instead of the selected UI fallback', () => {
        const callbacks = new Map<string, RegisterCallback>()
        const selectedChat = { message: [{ role: 'char', data: 'wrong chat' }], fmIndex: 0 }
        const selectedCharacter = {
            name: 'Wrong Bot',
            nickname: '',
            chatPage: 0,
            chats: [selectedChat],
            globalLore: [],
        }
        registerCBS({
            ...defaultCBSRegisterArg,
            registerFunction: (definition) => {
                if(definition.callback !== 'doc_only') callbacks.set(definition.name, definition.callback)
            },
            getDatabase: () => ({ characters: [selectedCharacter] }) as any,
            getSelectedCharID: () => 0,
            getUserName: () => 'Wrong User',
            getPersonaPrompt: () => 'Wrong Persona',
        })

        const targetChat = {
            message: [{ role: 'user', data: 'captured message' }],
            fmIndex: -1,
            localLore: [],
        }
        const targetCharacter = {
            name: 'Captured Bot',
            nickname: 'Captured Nickname',
            chatPage: 0,
            chats: [targetChat],
            globalLore: [],
        }
        const context:matcherArg = {
            chara: targetCharacter as any,
            chat: targetChat as any,
            userName: 'Captured User',
            personaPrompt: 'Captured Persona',
            modules: [],
            cbsConditions: {},
            chatID: -1,
            db: { characters: [selectedCharacter] } as any,
            rmVar: false,
        }
        const call = (name:string) => callbacks.get(name)?.('', context, [], null)

        expect(call('char')).toBe('Captured Bot')
        expect(call('user')).toBe('Captured User')
        expect(call('lastmessage')).toBe('captured message')
        expect(call('persona')).toBe('Captured Persona')
        expect(call('firstmsgindex')).toBe('-1')
    })
})
