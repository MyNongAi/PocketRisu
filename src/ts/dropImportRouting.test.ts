import { describe, expect, it } from 'vitest'
import { classifyDroppedImport } from './dropImportRouting'
import { isModuleCharxName } from './shareTargetRouting'

describe('isModuleCharxName', () => {
    it('only matches the module CHARX suffix, regardless of case', () => {
        expect(isModuleCharxName('a.module.charx')).toBe(true)
        expect(isModuleCharxName('A.MODULE.CHARX')).toBe(true)
        expect(isModuleCharxName('a.charx')).toBe(false)
        expect(isModuleCharxName('module.charx.png')).toBe(false)
    })
})

describe('classifyDroppedImport', () => {
    it('always treats RISUM as a module', () => {
        expect(classifyDroppedImport('legacy.RISUM')).toBe('module')
        expect(classifyDroppedImport('legacy.risum', 'module')).toBe('module')
    })

    it('treats JS and TS as plugins on either destination', () => {
        for (const name of ['plugin.js', 'plugin.JS', 'plugin.ts']) {
            expect(classifyDroppedImport(name)).toBe('plugin')
            expect(classifyDroppedImport(name, 'module')).toBe('plugin')
        }
    })

    it('treats CHARX as a character on the general app surface', () => {
        expect(classifyDroppedImport('card.charx')).toBe('character')
        expect(classifyDroppedImport('card.module.charx')).toBe('module')
        expect(classifyDroppedImport('CARD.MODULE.CHARX')).toBe('module')
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
