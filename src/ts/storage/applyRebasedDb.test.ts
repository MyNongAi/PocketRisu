import { describe, expect, it } from 'vitest'
import { applyMergedDbInPlace, changedPartsFromReport, reconcileInto } from './applyRebasedDb'

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
        return { db: { characters: [bot, other], characterOrder: ['bot', 'other'], language: 'ko', fillByBoot: true } as Record<string, any>, bot, other, loaded, loadedMessages }
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
        // a default this page filled in at boot stays
        expect(db.fillByBoot).toBe(true)
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

    it('with a report, looks only at the parts it names', () => {
        const { db, bot, other } = liveDb()
        applyMergedDbInPlace(db, {
            characters: [
                { chaId: 'bot', name: 'Changed but not named', chats: [] },
                { chaId: 'other', name: 'Other (renamed)', chats: [] },
            ],
            characterOrder: ['bot', 'other'],
            language: 'en',
        }, { roots: new Set(['characterOrder']), characters: new Set(['other']) })
        expect(bot.name).toBe('Bot')
        expect(bot.chats).toHaveLength(2)
        expect(other.name).toBe('Other (renamed)')
        expect(db.language).toBe('ko')
    })
})

describe('changedPartsFromReport', () => {
    const empty = { mismatched: [], onlyLocal: [], onlyRemote: [] }
    it('names every differing root key and character', () => {
        const parts = changedPartsFromReport({
            roots: { mismatched: ['characterOrder'], onlyLocal: [], onlyRemote: ['statics'] },
            characters: { mismatched: ['a'], onlyLocal: ['b'], onlyRemote: [] },
            duplicateCharIds: [],
            serverDuplicateCharIds: [],
        })
        expect([...parts!.roots!]).toEqual(['characterOrder', 'statics'])
        expect([...parts!.characters!]).toEqual(['a', 'b'])
    })

    it('cannot tell with duplicate ids or no report', () => {
        expect(changedPartsFromReport(null)).toBeNull()
        expect(changedPartsFromReport({ roots: empty, characters: empty, duplicateCharIds: ['x'], serverDuplicateCharIds: [] })).toBeNull()
    })
})
