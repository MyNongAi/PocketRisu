import { describe, expect, it } from 'vitest'
import { isTypedInput, withoutSystemBlocks } from './typedInput'

describe('withoutSystemBlocks', () => {
    it('drops a block a bot appended to the input', () => {
        expect(withoutSystemBlocks('Go to class\n[SIM_REQUEST_CONTEXT]\na\nb\n[/SIM_REQUEST_CONTEXT]')).toBe('Go to class')
        expect(withoutSystemBlocks('hi\n[SIM_MAIN_ASSET_CONTEXT:3]x[/SIM_MAIN_ASSET_CONTEXT]\n')).toBe('hi')
    })

    it('keeps what a user writes in brackets', () => {
        // No underscore in the name, or no closing tag: the user's own text.
        expect(withoutSystemBlocks('[OOC] stop here [/OOC]')).toBe('[OOC] stop here [/OOC]')
        expect(withoutSystemBlocks('[NOTE_ONE] open only')).toBe('[NOTE_ONE] open only')
        expect(withoutSystemBlocks('[a_b]x[/a_b]')).toBe('[a_b]x[/a_b]')
    })
})

describe('isTypedInput', () => {
    it('is an input sent from the input box, with something typed in it', () => {
        expect(isTypedInput({ role: 'user', time: 1, data: 'hello' })).toBe(true)
        expect(isTypedInput({ role: 'user', time: 1, data: 'hello\n[SIM_REQUEST_CONTEXT]x[/SIM_REQUEST_CONTEXT]' })).toBe(true)
    })

    it('is not a message a script added, an empty send, or a bot block alone', () => {
        expect(isTypedInput({ role: 'user', data: '[ACADEMY_REQUEST:2:1:19]' })).toBe(false)
        expect(isTypedInput({ role: 'user', data: '*says nothing*' })).toBe(false)
        expect(isTypedInput({ role: 'user', time: 1, data: '*says nothing*' })).toBe(false)
        expect(isTypedInput({ role: 'user', time: 1, data: '[SIM_REQUEST_CONTEXT]x[/SIM_REQUEST_CONTEXT]' })).toBe(false)
        expect(isTypedInput({ role: 'char', time: 1, data: 'reply' })).toBe(false)
        expect(isTypedInput(undefined)).toBe(false)
    })
})
