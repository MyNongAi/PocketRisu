import { describe, expect, it } from 'vitest'
import { applyMergedDbInPlace, applyRemoteChangesInPlace, reconcileInto } from './applyRebasedDb'

describe('reconcileInto', () => {
    it('keeps every object whose content is the same, and changes only what differs', () => {
        const unchanged = { deep: { a: 1 } }
        const target = { keep: unchanged, edit: { n: 1, gone: true }, list: [1, 2, 3] }
        const source = { keep: { deep: { a: 1 } }, edit: { n: 2 }, list: [1, 2], added: 'x' }
        const result = reconcileInto(target, source)
        expect(result).toBe(target)
        expect(target.keep).toBe(unchanged)
        expect(target).toEqual(source)
    })

    it('pairs items by id, so moved and kept entries keep their objects', () => {
        const a = { id: 'a', v: 1 }
        const b = { id: 'b', v: 2 }
        const target = [a, b]
        reconcileInto(target, [{ id: 'b', v: 2 }, { id: 'c', v: 3 }, { id: 'a', v: 9 }])
        expect(target.map((x) => x.id)).toEqual(['b', 'c', 'a'])
        expect(target[0]).toBe(b)
        expect(target[2]).toBe(a)
        expect(a.v).toBe(9)
    })
})

describe('applyMergedDbInPlace', () => {
    function liveDb() {
        const loadedMessages = [{ chatId: 'm1', role: 'user', data: 'hi' }]
        const loaded = { id: 'c1', name: 'Chat', message: loadedMessages, note: '', localLore: [] }
        const placeholder = { id: 'c2', name: 'Old', _placeholder: true, message: [] }
        const bot = { chaId: 'bot', name: 'Bot', desc: 'same', chats: [loaded, placeholder], chatPage: 0 }
        const other = { chaId: 'other', name: 'Other', chats: [] }
        return { db: { characters: [bot, other], characterOrder: ['bot', 'other'], language: 'ko', removedElsewhere: { on: true }, pluginCustomStorage: { kept: 1 } } as Record<string, any>, bot, other, loaded, loadedMessages }
    }

    it('keeps the open chat body and object; only its catalog fields follow the server', () => {
        const { db, bot, loaded, loadedMessages } = liveDb()
        const merged = {
            characters: [
                { chaId: 'bot', name: 'Bot', desc: 'same', chatPage: 0, chats: [
                    { id: 'c1', name: 'Renamed elsewhere', _placeholder: true, message: [] },
                    { id: 'c2', name: 'Old', _placeholder: true, message: [] },
                    { id: 'c3', name: 'New elsewhere', _placeholder: true, message: [] },
                ] },
                { chaId: 'other', name: 'Other', chats: [] },
            ],
            characterOrder: ['bot', 'other'],
            language: 'ko',
        }
        applyMergedDbInPlace(db, merged)
        expect(db.characters[0]).toBe(bot)
        expect(bot.chats[0]).toBe(loaded)
        expect(loaded.message).toBe(loadedMessages)
        expect(loaded.name).toBe('Renamed elsewhere')
        expect(bot.chats.map((chat: any) => chat.id)).toEqual(['c1', 'c2', 'c3'])
    })

    it("drops a root key removed on another device, so the next save doesn't add it back (the review, 2026-10-21)", () => {
        const { db } = liveDb()
        applyMergedDbInPlace(db, { characters: db.characters, characterOrder: ['bot', 'other'], language: 'ko' })
        expect('removedElsewhere' in db).toBe(false)
        // never synced through the save's diff, so the server's copy says nothing about it
        expect(db.pluginCustomStorage).toEqual({ kept: 1 })
    })

    it('brings in a character added elsewhere and drops one deactivated elsewhere, in the server order', () => {
        const { db, bot } = liveDb()
        const added = { chaId: 'new', name: 'New', chats: [] }
        applyMergedDbInPlace(db, {
            characters: [added, { chaId: 'bot', name: 'Bot', desc: 'same', chatPage: 0, chats: bot.chats }],
            characterOrder: ['new', 'bot'],
        })
        expect(db.characters.map((c: any) => c.chaId)).toEqual(['new', 'bot'])
        expect(db.characters[1]).toBe(bot)
        expect(db.characterOrder).toEqual(['new', 'bot'])
    })

    it('takes in every change the server holds, also ones newer than the conflict', () => {
        const { db, bot, other } = liveDb()
        applyMergedDbInPlace(db, {
            characters: [
                { chaId: 'bot', name: 'Changed later', desc: 'same', chatPage: 0, chats: [...bot.chats, { id: 'c9', name: 'Added later', _placeholder: true, message: [] }] },
                { chaId: 'other', name: 'Other (renamed)', chats: [] },
            ],
            characterOrder: ['bot', 'other'],
            language: 'en',
        })
        expect(bot.name).toBe('Changed later')
        expect(bot.chats.map((chat: any) => chat.id)).toEqual(['c1', 'c2', 'c9'])
        expect(other.name).toBe('Other (renamed)')
        expect(db.language).toBe('en')
    })
})

describe('applyRemoteChangesInPlace', () => {
    it('writes only the changed root keys and characters, keeping every other object', () => {
        const loadedMessages = [{ role: 'user', data: 'hi' }]
        const loaded = { id: 'c1', name: 'Chat', message: loadedMessages }
        const bot = { chaId: 'bot', name: 'Bot', chats: [loaded], chatPage: 0 }
        const other = { chaId: 'other', name: 'Other', chats: [] }
        const persona = { name: 'P' }
        const db: Record<string, any> = { characters: [bot, other], temperature: 70, persona, gone: 1, keptUnmentioned: { x: 1 } }
        applyRemoteChangesInPlace(db, {
            roots: { temperature: 80 },
            deleteRoots: ['gone'],
            characters: [{ ...bot, name: 'Bot renamed', chats: [{ id: 'c1', name: 'Renamed elsewhere', _placeholder: true, message: [] }] }, other],
        })
        expect(db.temperature).toBe(80)
        expect('gone' in db).toBe(false)
        expect(db.persona).toBe(persona)
        expect(db.keptUnmentioned).toEqual({ x: 1 })
        expect(db.characters[0]).toBe(bot)
        expect(bot.name).toBe('Bot renamed')
        expect(bot.chats[0]).toBe(loaded)
        expect(loaded.message).toBe(loadedMessages)
        expect(loaded.name).toBe('Renamed elsewhere')
        expect(db.characters[1]).toBe(other)
    })

    it('takes a new order and new characters, and leaves characters alone when none are given', () => {
        const a = { chaId: 'a', chats: [] }
        const b = { chaId: 'b', chats: [] }
        const db: Record<string, any> = { characters: [a, b] }
        const added = { chaId: 'new', chats: [] }
        applyRemoteChangesInPlace(db, { roots: {}, deleteRoots: [], characters: [b, added, a] })
        expect(db.characters.map((c: any) => c.chaId)).toEqual(['b', 'new', 'a'])
        expect(db.characters[0]).toBe(b)
        applyRemoteChangesInPlace(db, { roots: {}, deleteRoots: [], characters: null })
        expect(db.characters.map((c: any) => c.chaId)).toEqual(['b', 'new', 'a'])
    })
})
