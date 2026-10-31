import { describe, expect, it } from 'vitest'
import { sortPersonaGroups } from './personaSort'

const folder = (id: string, parent?: string) => ({ id, name: id, nodeOnlyParentFolderId: parent }) as never

describe('persona groups in the shared sort', () => {
    const personas = [{ lastAppliedAt: 10 }, { lastAppliedAt: 50 }, {}, { lastAppliedAt: 30 }, { lastAppliedAt: 40 }]
    const folders = [folder('a'), folder('b'), folder('c', 'a')]
    const groups = [
        { folder: null, indexes: [0, 2] },
        { folder: folders[0], indexes: [3] },
        { folder: folders[1], indexes: [4] },
        { folder: folders[2], indexes: [1] },
    ]

    it('keeps the registered order', () => {
        expect(sortPersonaGroups(groups, personas, folders, 'registered')).toEqual(groups)
    })

    it('puts the last applied first, a folder as recent as the folders inside it', () => {
        const sorted = sortPersonaGroups(groups, personas, folders, 'recent')
        // c (50) is inside a: a counts 50, ahead of b (40) and the uncategorized (10).
        expect(sorted.map((group) => group.folder?.id ?? '')).toEqual(['a', 'c', 'b', ''])
        expect(sorted.find((group) => !group.folder)?.indexes).toEqual([0, 2])
        // The input is left as it was.
        expect(groups[0].indexes).toEqual([0, 2])
    })
})
