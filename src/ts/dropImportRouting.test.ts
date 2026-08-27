import { describe, expect, it } from 'vitest'
import { classifyDroppedImport } from './dropImportRouting'

describe('classifyDroppedImport', () => {
    it('always treats RISUM as a module', () => {
        expect(classifyDroppedImport('legacy.RISUM')).toBe('module')
        expect(classifyDroppedImport('legacy.risum', 'module')).toBe('module')
    })

    it('treats CHARX as a character on the general app surface', () => {
        expect(classifyDroppedImport('card.charx')).toBe('character')
    })

    it('treats CHARX as a module on the module catalog surface', () => {
        expect(classifyDroppedImport('card.CHARX', 'module')).toBe('module')
    })

    it('keeps presets and ordinary character cards on their existing routes', () => {
        expect(classifyDroppedImport('preset.risup')).toBe('preset')
        expect(classifyDroppedImport('preset.risupreset', 'module')).toBe('preset')
        expect(classifyDroppedImport('card.png', 'module')).toBe('character')
    })
})
