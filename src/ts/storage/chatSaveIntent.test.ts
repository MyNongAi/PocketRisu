import { describe, expect, it } from 'vitest'
import { classifyChatSaveIntent, retainConfirmedChats } from './chatSaveIntent'

describe('chat save intent', () => {
    it('classifies a chat absent from the confirmed catalog as create', () => {
        const baseline = new Map([['char-a', new Set(['old-chat'])]])
        expect(classifyChatSaveIntent(baseline, 'char-a', 'new-chat')).toBe('create')
        expect(classifyChatSaveIntent(baseline, 'char-new', 'new-chat')).toBe('create')
    })

    it('classifies a confirmed chat as update', () => {
        const baseline = new Map([['char-a', new Set(['old-chat'])]])
        expect(classifyChatSaveIntent(baseline, 'char-a', 'old-chat')).toBe('update')
    })

    it('fails closed when the confirmed catalog is unavailable', () => {
        expect(classifyChatSaveIntent(undefined, 'char-a', 'maybe-existing')).toBe('update')
    })
})

describe('retaining confirmed chats across a catalog save', () => {
    // Regression: the refresh used to replace the set with the local chat ids,
    // which marked a brand-new chat as confirmed before its body was ever sent.
    // The next save then went out as an 'update' and 404'd on its baseline.
    it('does not confirm a local chat whose body has not been saved', () => {
        const retained = retainConfirmedChats(new Set(['saved-chat']), ['saved-chat', 'brand-new-chat'])

        expect(retained.has('brand-new-chat')).toBe(false)
        expect(classifyChatSaveIntent(new Map([['char-a', retained]]), 'char-a', 'brand-new-chat')).toBe('create')
    })

    it('drops a chat that no longer exists locally', () => {
        const retained = retainConfirmedChats(new Set(['kept', 'deleted']), ['kept'])

        expect([...retained]).toEqual(['kept'])
    })

    // The whole point of the confirmed set is to keep already-saved chats on
    // the 'update' path, so their if-match precondition still guards a peer's
    // newer messages. Narrowing must not cost an existing chat that status.
    it('keeps a confirmed chat on the update path', () => {
        const retained = retainConfirmedChats(new Set(['saved-chat']), ['saved-chat', 'brand-new-chat'])

        expect(classifyChatSaveIntent(new Map([['char-a', retained]]), 'char-a', 'saved-chat')).toBe('update')
    })

    it('stays empty when nothing was confirmed yet', () => {
        expect([...retainConfirmedChats(undefined, ['a', 'b'])]).toEqual([])
    })
})
