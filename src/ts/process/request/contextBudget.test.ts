import { describe, test, expect } from 'vitest'
import { resolveModelPresetContextBudget } from './contextBudget'

describe('resolveModelPresetContextBudget', () => {
    test('empty value: default budget, capped by the profile context window', () => {
        expect(resolveModelPresetContextBudget({ name: 'p' }, undefined).maxContextTokens).toBe(65000)
        expect(resolveModelPresetContextBudget({ name: 'p' }, 200000).maxContextTokens).toBe(65000)
        expect(resolveModelPresetContextBudget({ name: 'p' }, 49152).maxContextTokens).toBe(49152)
        // The switch has no effect without an explicit value.
        expect(resolveModelPresetContextBudget({ name: 'p', ignoreContextWindowCap: true }, 49152).maxContextTokens).toBe(49152)
    })

    test('explicit value is capped unless the cap is ignored', () => {
        const capped = resolveModelPresetContextBudget({ name: 'p', maxContext: 200000 }, 49152)
        expect(capped.maxContextTokens).toBe(49152)
        expect(capped.source).toContain('cap 49152')
        expect(capped.source).toContain('preset budget 200000')

        const ignored = resolveModelPresetContextBudget({ name: 'p', maxContext: 200000, ignoreContextWindowCap: true }, 49152)
        expect(ignored.maxContextTokens).toBe(200000)
        expect(ignored.source).toContain('cap 49152 ignored')

        // A value under the cap is used as-is either way.
        expect(resolveModelPresetContextBudget({ name: 'p', maxContext: 30000 }, 49152).maxContextTokens).toBe(30000)
        expect(resolveModelPresetContextBudget({ name: 'p', maxContext: 30000, ignoreContextWindowCap: true }, 49152).source).not.toContain('ignored')
    })

    test('non-positive or missing window means no cap', () => {
        expect(resolveModelPresetContextBudget({ name: 'p', maxContext: 120000 }, 0).maxContextTokens).toBe(120000)
        expect(resolveModelPresetContextBudget({ name: 'p', maxContext: 0 }, undefined).maxContextTokens).toBe(65000)
    })

    test('empty value follows the chat bot max context, still capped by the window', () => {
        const follows = resolveModelPresetContextBudget({ name: 'p' }, 1048576, 200000)
        expect(follows.maxContextTokens).toBe(200000)
        expect(follows.source).toContain('chat bot max context 200000')
        expect(resolveModelPresetContextBudget({ name: 'p', maxContext: 0 }, undefined, 200000).maxContextTokens).toBe(200000)
        expect(resolveModelPresetContextBudget({ name: 'p' }, 128000, 200000).maxContextTokens).toBe(128000)
        // A value the preset sets wins; no chat bot value keeps the default.
        expect(resolveModelPresetContextBudget({ name: 'p', maxContext: 90000 }, undefined, 200000).maxContextTokens).toBe(90000)
        expect(resolveModelPresetContextBudget({ name: 'p' }, undefined, 0).maxContextTokens).toBe(65000)
    })
})
