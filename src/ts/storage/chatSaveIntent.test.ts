import { describe, expect, it } from 'vitest'
import { classifyChatSaveIntent } from './chatSaveIntent'

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
