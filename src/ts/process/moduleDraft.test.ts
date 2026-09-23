import { describe, expect, it } from 'vitest'
import { cloneModuleDraft } from './moduleDraft'

describe('cloneModuleDraft', () => {
    it('keeps editor mutations detached from the stored module', () => {
        const stored = {
            id: 'module-1',
            name: 'Stored',
            lorebook: [{ key: 'island', content: 'old' }],
            assets: [['name', 'path', 'png']],
        }
        const draft = cloneModuleDraft(stored)

        draft.name = 'Draft'
        draft.lorebook[0].content = 'new'
        draft.assets[0][0] = 'renamed'

        expect(stored).toEqual({
            id: 'module-1',
            name: 'Stored',
            lorebook: [{ key: 'island', content: 'old' }],
            assets: [['name', 'path', 'png']],
        })
    })
})
