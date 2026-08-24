import { describe, expect, it } from 'vitest'
import { resolveModuleEditTargetIndex } from './moduleEditing'

describe('resolveModuleEditTargetIndex', () => {
    it('follows the original object when duplicate ids exist', () => {
        const first = { id: 'same', name: 'First' }
        const second = { id: 'same', name: 'Second' }
        expect(resolveModuleEditTargetIndex([first, second], 'same', second)).toBe(1)
    })

    it('falls back to one stable id after an immutable array replacement', () => {
        expect(resolveModuleEditTargetIndex(
            [{ id: 'a' }, { id: 'target' }],
            'target',
            { id: 'target' },
        )).toBe(1)
    })

    it('refuses a missing or ambiguous target', () => {
        expect(resolveModuleEditTargetIndex([{ id: 'a' }], 'missing', null)).toBe(-1)
        expect(resolveModuleEditTargetIndex([{ id: 'a' }, { id: 'a' }], 'a', null)).toBe(-1)
    })
})
