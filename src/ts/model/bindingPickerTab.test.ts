import { describe, expect, it } from 'vitest'
import { bindingPickerTab } from './bindingPickerTab'

const pluginIds = ['pluginmodel:::installed']

describe('binding slot picker initial tab', () => {
    it('opens presets for empty and preset values', () => {
        expect(bindingPickerTab('', pluginIds)).toBe('preset')
        expect(bindingPickerTab('preset-1', pluginIds)).toBe('preset')
    })

    it('opens built-in models for global and other legacy slots', () => {
        expect(bindingPickerTab('@legacy', pluginIds)).toBe('base')
        expect(bindingPickerTab('@legacy:gemini-2.5-pro', pluginIds)).toBe('base')
        expect(bindingPickerTab('@legacy:pluginmodel:::removed', pluginIds)).toBe('base')
    })

    it('opens plugin models for an installed plugin slot', () => {
        expect(bindingPickerTab('@legacy:pluginmodel:::installed', pluginIds)).toBe('plugin')
        expect(bindingPickerTab('@legacy:pluginmodel:::installed', [])).toBe('base')
    })
})
