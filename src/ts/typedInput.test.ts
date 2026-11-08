import { describe, expect, it } from 'vitest'
import { carryTypedInput, isTypedInput, rememberTypedInput, typedText, typedTextOf, withoutSystemBlocks } from './typedInput'

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

// What was typed is kept when the input is sent, before the bot edits it
// (2026-11-09): the 명조 bot appends one-line [[SIM_…]] marks no pattern
// knew, so the input under the reply showed them.
const MARKS = '\n[[SIM_HSIN_GATE_INPUT:meet|k1]]\n[[SIM_HSIN_GATE_ENV:night|rain]]'

describe('the typed-input record', () => {
    it('shows what was typed, whatever the bot added on send', () => {
        const message = { role: 'user', time: 1, data: 'hello there' + MARKS } as { role: string, time: number, data: string, nodeOnlyTypedInputs?: Record<string, string> }
        expect(typedTextOf(message)).toContain('SIM_HSIN_GATE_INPUT')
        rememberTypedInput(message, 'hello there')
        expect(typedTextOf(message)).toBe('hello there')
        expect(isTypedInput(message)).toBe(true)
    })

    it('still finds it when the bot appends again later', () => {
        const message = { data: 'hi' + MARKS } as { data: string, nodeOnlyTypedInputs?: Record<string, string> }
        rememberTypedInput(message, 'hi')
        message.data += '\n[[SIM_USER_SCENE_INPUT:here|m|p|9]]'
        expect(typedTextOf(message)).toBe('hi')
    })

    it('falls back to the old pattern for inputs sent before the record', () => {
        expect(typedText('hi\n[SIM_REQUEST_CONTEXT]x[/SIM_REQUEST_CONTEXT]<!--sf:1-->')).toBe('hi')
    })

    it('follows an edit of the typed part, keeping the bot part', () => {
        const message = { data: 'hello there' + MARKS } as { data: string, nodeOnlyTypedInputs?: Record<string, string> }
        rememberTypedInput(message, 'hello there')
        const before = message.data
        message.data = 'hello again' + MARKS
        carryTypedInput(message, before)
        expect(typedTextOf(message)).toBe('hello again')
        // Stepping back to the version as sent shows its own typed text.
        message.data = before
        expect(typedTextOf(message)).toBe('hello there')
    })

    it('leaves no record for an edit that changed the bot part', () => {
        const message = { data: 'hello' + MARKS } as { data: string, nodeOnlyTypedInputs?: Record<string, string> }
        rememberTypedInput(message, 'hello')
        const before = message.data
        message.data = 'bye'
        carryTypedInput(message, before)
        expect(typedTextOf(message)).toBe('bye')
    })

    it('keeps the newest 20 records', () => {
        const message = { data: '' } as { data: string, nodeOnlyTypedInputs?: Record<string, string> }
        for (let i = 0; i < 25; i++) {
            message.data = 'v' + i + MARKS
            rememberTypedInput(message, 'v' + i)
        }
        expect(Object.keys(message.nodeOnlyTypedInputs!)).toHaveLength(20)
        expect(typedTextOf(message)).toBe('v24')
    })

    it('an empty typed send with only bot marks is not an input', () => {
        const message = { role: 'user', time: 1, data: MARKS.trim() } as { role: string, time: number, data: string, nodeOnlyTypedInputs?: Record<string, string> }
        rememberTypedInput(message, '')
        expect(isTypedInput(message)).toBe(false)
    })
})
