import { describe, expect, it } from 'vitest'
import { useUtilityEditPrompt } from './editPrompt'

describe('built-in edit prompt choice', () => {
    it('uses the utility template when edit mode is on and the switch is off by default', () => {
        expect(useUtilityEditPrompt(true)).toBe(true)
        expect(useUtilityEditPrompt(true, false)).toBe(true)
    })

    it('keeps the normal prompt when the switch is on', () => {
        expect(useUtilityEditPrompt(true, true)).toBe(false)
    })

    it('keeps the normal prompt without the built-in edit module', () => {
        expect(useUtilityEditPrompt(false, false)).toBe(false)
        expect(useUtilityEditPrompt(false, true)).toBe(false)
    })
})
