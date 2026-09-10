import { describe, expect, it } from 'vitest'
import { buildCharacterLoreComparisonStatuses, buildModuleLoreComparisonStatuses } from './loreBookComparison'
import type { loreBook } from '../storage/database.svelte'

function lore(comment: string, content: string): loreBook {
    return { comment, content, key: '', secondkey: '', insertorder: 100, mode: 'normal', alwaysActive: true, selective: false }
}

describe('candidate lorebook comparison', () => {
    it('marks exact title+content matches green and all other candidate lore yellow', () => {
        const same = lore('Profile', 'same\r\ntext')
        const changed = lore('Secret', 'old')
        const result = buildCharacterLoreComparisonStatuses({
            characters: [
                { chaId: 'web', name: 'Mary Sisters', globalLore: [same, changed] },
                { chaId: 'mobile', name: 'Mary  Sisters', globalLore: [lore('Profile', 'same\ntext'), lore('Secret', 'new')] },
            ],
        }, 'web')
        expect(result.get(same)).toBe('match')
        expect(result.get(changed)).toBe('different')
    })

    it('does not color ordinary characters without a similar peer', () => {
        const only = lore('Only', 'one')
        expect(buildCharacterLoreComparisonStatuses({
            characters: [{ chaId: 'one', name: 'Unique', globalLore: [only] }],
        }, 'one').size).toBe(0)
    })

    it('uses a recorded candidate module folder even after a module was renamed', () => {
        const same = lore('World', 'shared')
        const result = buildModuleLoreComparisonStatuses({
            characters: [],
            modules: [
                { id: 'a', name: 'Renamed A', folderId: 'candidate', lorebook: [same] },
                { id: 'b', name: 'Different B', folderId: 'candidate', lorebook: [lore('World', 'shared')] },
            ],
            moduleFolders: [{ id: 'candidate', duplicateCandidate: { kind: 'module' } }],
        }, 'a')
        expect(result.get(same)).toBe('match')
    })
})
