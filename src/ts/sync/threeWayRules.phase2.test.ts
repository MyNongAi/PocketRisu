import { describe, expect, it } from 'vitest'

import { mergeCharacter3, mergeChatCatalog, mergeIdSequence, weaveIds } from './threeWayRules'

// A chat in the baseline's form, as chatToStub writes it.
const stubOf = (chat: any) => {
    const stub: any = { id: chat.id, name: chat.name ?? '', _stub: true }
    for (const field of ['lastDate', 'folderId', 'modules']) if (field in chat) stub[field] = chat[field]
    return stub
}
const body = (id: string, over: Record<string, any> = {}) => ({ id, name: id.toUpperCase(), message: [{ role: 'user', data: id }], ...over })
const placeholder = (stub: any) => ({ ...stub, _stub: undefined, message: [], _placeholder: true })
const same = (value: unknown) => value

function catalog(b: any[], l: any[], r: any[], busy: string[] = []) {
    return mergeChatCatalog({
        b, l, r,
        isBusy: (chatId) => busy.includes(chatId),
        stubView: stubOf,
        normalize: same,
        toPlaceholder: placeholder,
    })
}
const ids = (chats: any[]) => chats.map((chat) => chat.id)

describe('weaveIds', () => {
    it("puts each of the other side's ids after its nearest placed neighbour", () => {
        expect(weaveIds(['a', 'b', 'c'], ['x', 'a', 'y', 'c', 'z'])).toEqual(['x', 'a', 'y', 'b', 'c', 'z'])
        expect(weaveIds([], ['a', 'b'])).toEqual(['a', 'b'])
    })
})

describe('mergeIdSequence', () => {
    it('takes the order of the side that reordered, with the other side\'s additions', () => {
        expect(mergeIdSequence(['a', 'b', 'c'], ['c', 'b', 'a'], ['a', 'n', 'b', 'c'])).toEqual(['c', 'b', 'a', 'n'])
        expect(mergeIdSequence(['a', 'b', 'c'], ['a', 'b', 'c', 'l'], ['b', 'a', 'c'])).toEqual(['b', 'a', 'c', 'l'])
        // Additions alone are no reorder.
        expect(mergeIdSequence(['a', 'b'], ['l', 'a', 'b'], ['a', 'b', 'r'])).toEqual(['l', 'a', 'b', 'r'])
    })

    it('is null only when both reordered differently', () => {
        expect(mergeIdSequence(['a', 'b', 'c'], ['c', 'b', 'a'], ['b', 'a', 'c'])).toBeNull()
        expect(mergeIdSequence(['a', 'b', 'c'], ['c', 'b', 'a'], ['c', 'b', 'a'])).toEqual(['c', 'b', 'a'])
    })
})

describe('mergeChatCatalog', () => {
    const base = [stubOf(body('a')), stubOf(body('b'))]

    it('keeps a chat all three have', () => {
        const out = catalog(base, [body('a'), body('b')], [stubOf(body('a')), stubOf(body('b'))])!
        expect(ids(out.chats)).toEqual(['a', 'b'])
        expect(out.chats[0].message).toHaveLength(1)
        expect(out.conflicts).toEqual([])
    })

    it('drops a chat the server removed and this page left alone', () => {
        const out = catalog(base, [body('a'), body('b')], [stubOf(body('a'))])!
        expect(ids(out.chats)).toEqual(['a'])
        expect(out.conflicts).toEqual([])
    })

    it('keeps a chat the server removed while this page changed it or is using it, when its body is here', () => {
        const renamed = catalog(base, [body('a'), body('b', { name: 'mine' })], [stubOf(body('a'))])!
        expect(ids(renamed.chats)).toEqual(['a', 'b'])
        expect(renamed.conflicts).toEqual(['chat-removed-edited'])

        const busy = catalog(base, [body('a'), body('b')], [stubOf(body('a'))], ['b'])!
        expect(ids(busy.chats)).toEqual(['a', 'b'])

        // A placeholder has no body to save again.
        const unloaded = catalog(base, [body('a'), placeholder(stubOf(body('b', { name: 'mine' })))], [stubOf(body('a'))])!
        expect(ids(unloaded.chats)).toEqual(['a'])
        expect(unloaded.conflicts).toEqual(['chat-removed-edited'])
    })

    it('drops a chat removed here that the server left alone, and keeps one the server changed', () => {
        expect(ids(catalog(base, [body('a')], [stubOf(body('a')), stubOf(body('b'))])!.chats)).toEqual(['a'])
        const changed = catalog(base, [body('a')], [stubOf(body('a')), stubOf(body('b', { name: 'theirs' }))])!
        expect(ids(changed.chats)).toEqual(['a', 'b'])
        expect(changed.chats[1]._placeholder).toBe(true)
        expect(changed.conflicts).toEqual(['chat-edited-removed'])
    })

    it("keeps both sides' new chats, the server's as placeholders", () => {
        const out = catalog(base, [body('l'), body('a'), body('b')], [stubOf(body('a')), stubOf(body('r')), stubOf(body('b'))])!
        expect(ids(out.chats)).toEqual(['l', 'a', 'r', 'b'])
        expect(out.chats[0].message).toHaveLength(1)
        expect(out.chats[2]._placeholder).toBe(true)
    })

    it('merges catalog fields: one side changed takes it, both take this page\'s, lastDate the later', () => {
        const b = [stubOf(body('a', { lastDate: 10 })), stubOf(body('b')), stubOf(body('c'))]
        const l = [body('a', { lastDate: 30 }), body('b'), body('c', { name: 'mine' })]
        const r = [stubOf(body('a', { lastDate: 20 })), stubOf(body('b', { name: 'theirs', folderId: 'f' })), stubOf(body('c', { name: 'theirs' }))]
        const out = catalog(b, l, r)!
        expect(out.chats[0].lastDate).toBe(30)
        expect(out.chats[1]).toMatchObject({ name: 'theirs', folderId: 'f' })
        expect(out.chats[1].message).toHaveLength(1)
        expect(out.chats[2].name).toBe('mine')
        expect(out.conflicts).toEqual(['chat-field:name'])
    })

    it('is null when a list has a chat without a unique id', () => {
        expect(catalog(base, [body('a'), body('a')], [stubOf(body('a'))])).toBeNull()
        expect(catalog(base, [body('a'), { name: 'no id' }], [stubOf(body('a'))])).toBeNull()
    })
})

describe('mergeCharacter3', () => {
    const chats = [body('a'), body('b')]
    const baseChar = { chaId: 'x', name: 'X', desc: 'base', note: 'base', lastInteraction: 5, chatPage: 0, chats: chats.map(stubOf) }
    const viewOf = (char: any) => ({ ...char, chats: char.chats.map(stubOf) })

    function merge(local: any, server: any, over: Partial<{ selected: boolean, hold: string }> = {}) {
        return mergeCharacter3({
            base: baseChar,
            local,
            localView: viewOf(local),
            server,
            selected: over.selected ?? false,
            hold: over.hold,
            isChatBusy: () => false,
            chatStubView: stubOf,
            normalize: same,
            toPlaceholder: placeholder,
        })!
    }

    it('takes each field from the side that changed it, this page\'s when both did', () => {
        const local = { ...baseChar, desc: 'mine', note: 'mine', lastInteraction: 9, chats: [body('a'), body('b')] }
        const server = { ...baseChar, name: 'Theirs', note: 'theirs', lastInteraction: 7, chats: chats.map(stubOf) }
        const out = merge(local, server)
        expect(out.character).toMatchObject({ name: 'Theirs', desc: 'mine', note: 'mine', lastInteraction: 9 })
        expect(out.conflicts).toEqual(['char-field:note'])
    })

    it("keeps another device's new chat, and an unchanged character takes the server's version", () => {
        const local = { ...baseChar, chats: [body('a'), body('b')] }
        const server = { ...baseChar, desc: 'theirs', chatPage: 0, chats: [stubOf(body('n')), ...chats.map(stubOf)] }
        const out = merge(local, server)
        expect(out.character.desc).toBe('theirs')
        expect(ids(out.character.chats)).toEqual(['n', 'a', 'b'])
        expect(out.character.chats[0]._placeholder).toBe(true)
        expect(out.conflicts).toEqual([])
    })

    it('keeps the selected character on its open chat by id, and holds it when the server points elsewhere', () => {
        const local = { ...baseChar, chatPage: 0, chats: [body('a'), body('b')] }
        // The server added a chat in front and opened b.
        const server = { ...baseChar, chatPage: 2, chats: [stubOf(body('n')), ...chats.map(stubOf)] }
        const selected = merge(local, server, { selected: true })
        expect(selected.character.chatPage).toBe(1)
        expect(selected.hold).toBe('a')
        const other = merge(local, server)
        expect(other.character.chatPage).toBe(2)
        expect(other.hold).toBeNull()
    })

    it('a chat opened here since the sync is a move, saved as is (no hold)', () => {
        const local = { ...baseChar, chatPage: 1, chats: [body('a'), body('b')] }
        const out = merge(local, { ...baseChar, chats: chats.map(stubOf) })
        expect(out.character.chatPage).toBe(1)
        expect(out.hold).toBeNull()
    })

    it("reports the selected character's open chat removed on the server", () => {
        const local = { ...baseChar, chatPage: 1, chats: [body('a'), body('b')] }
        const base = { ...baseChar, chatPage: 1 }
        const out = mergeCharacter3({
            base, local, localView: viewOf(local), server: { ...base, chatPage: 0, chats: [stubOf(body('a'))] },
            selected: true, hold: undefined, isChatBusy: () => false, chatStubView: stubOf, normalize: same, toPlaceholder: placeholder,
        })!
        expect(ids(out.character.chats)).toEqual(['a'])
        expect(out.character.chatPage).toBe(0)
        expect(out.removedOpenChat).toBe(true)
    })

    it('is null when the chats cannot be merged by id', () => {
        const local = { ...baseChar, chats: [body('a'), body('a')] }
        expect(mergeCharacter3({
            base: baseChar, local, localView: viewOf(local), server: { ...baseChar },
            selected: false, hold: undefined, isChatBusy: () => false, chatStubView: stubOf, normalize: same, toPlaceholder: placeholder,
        })).toBeNull()
    })
})
