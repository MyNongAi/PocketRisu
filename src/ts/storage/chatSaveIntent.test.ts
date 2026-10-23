import { describe, expect, it } from 'vitest'
import { chatNeedsUpload, classifyChatSaveIntent, retainConfirmedChats } from './chatSaveIntent'

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

// The save loop's rule for a tracked chat (globalApi persistTrackedChanges).
describe('chat needs upload', () => {
    const facts = (over: Partial<Parameters<typeof chatNeedsUpload>[0]> = {}): Parameters<typeof chatNeedsUpload>[0] => ({
        confirmed: true,
        busy: false,
        state: 'clean',
        savedAsIs: () => true,
        ...over,
    })

    it('leaves out a confirmed, idle chat the server already holds as it is', () => {
        expect(chatNeedsUpload(facts())).toBe(false)
        // Not tracked by the hydration cache (made or loaded at boot here):
        // no marks to go by, so the content alone decides.
        expect(chatNeedsUpload(facts({ state: 'unknown' }))).toBe(false)
    })

    it('sends a chat whose content differs from what the server holds', () => {
        expect(chatNeedsUpload(facts({ savedAsIs: () => false }))).toBe(true)
        expect(chatNeedsUpload(facts({ state: 'unknown', savedAsIs: () => false }))).toBe(true)
    })

    it('sends anything in doubt without comparing the content', () => {
        let compared = 0
        const savedAsIs = () => { compared++; return true }
        expect(chatNeedsUpload(facts({ confirmed: false, savedAsIs }))).toBe(true)
        expect(chatNeedsUpload(facts({ busy: true, savedAsIs }))).toBe(true)
        expect(chatNeedsUpload(facts({ state: 'dirty', savedAsIs }))).toBe(true)
        expect(compared).toBe(0)
    })
})
