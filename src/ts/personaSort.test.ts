import { describe, expect, it } from 'vitest'
import { appliedTimesAfterDrop, compareRecentlyApplied, sortPersonaGroups } from './personaSort'

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

describe('a drop in the recent sort stays where it was put (2026-11-07)', () => {
    type P = { lastAppliedAt?: number }
    const applied = (personas: P[], times: Map<number, number>) =>
        personas.map((persona, index) => times.has(index) ? { ...persona, lastAppliedAt: times.get(index) } : persona)
    const sortedIn = (personas: P[], indexes: number[]) => [...indexes].sort(compareRecentlyApplied(personas))
    const rows = (indexes: number[], folderId?: string) => indexes.map((index) => ({ index, folderId }))

    it('changes nothing when the rows are already in order', () => {
        const personas = [{ lastAppliedAt: 100 }, { lastAppliedAt: 90 }, {}, {}]
        expect(appliedTimesAfterDrop(rows([0, 1, 2, 3]), personas).size).toBe(0)
    })

    it('gives the moved persona a time between its new neighbors', () => {
        const personas = [{ lastAppliedAt: 100 }, { lastAppliedAt: 90 }, { lastAppliedAt: 80 }, { lastAppliedAt: 70 }]
        const times = appliedTimesAfterDrop(rows([0, 3, 1, 2]), personas)
        expect([...times.keys()]).toEqual([3])
        expect(times.get(3)).toBe(95)
        expect(sortedIn(applied(personas, times), [0, 1, 2, 3])).toEqual([0, 3, 1, 2])
    })

    it('moves a persona to the bottom', () => {
        const personas = [{ lastAppliedAt: 100 }, { lastAppliedAt: 90 }, { lastAppliedAt: 80 }]
        const times = appliedTimesAfterDrop(rows([1, 2, 0]), personas)
        expect(times.size).toBe(1)
        expect(sortedIn(applied(personas, times), [0, 1, 2])).toEqual([1, 2, 0])
    })

    it('lifts a never-applied persona among the others without touching them', () => {
        const personas = [{ lastAppliedAt: 100 }, {}, {}, {}]
        const times = appliedTimesAfterDrop(rows([0, 3, 1, 2]), personas)
        expect([...times.keys()]).toEqual([3])
        expect(sortedIn(applied(personas, times), [0, 1, 2, 3])).toEqual([0, 3, 1, 2])
    })

    it('makes room between two never-applied personas', () => {
        const personas = [{ lastAppliedAt: 100 }, {}, {}, {}]
        const times = appliedTimesAfterDrop(rows([0, 1, 3, 2]), personas)
        expect(times.has(0)).toBe(false)
        expect(sortedIn(applied(personas, times), [0, 1, 2, 3])).toEqual([0, 1, 3, 2])
    })

    it('reads each folder on its own: folders keep their own order', () => {
        // The folder 'f' is shown above the loose rows though its personas are older.
        const personas = [{ lastAppliedAt: 10 }, { lastAppliedAt: 20 }, { lastAppliedAt: 100 }, { lastAppliedAt: 90 }]
        expect(appliedTimesAfterDrop([...rows([1, 0], 'f'), ...rows([2, 3])], personas).size).toBe(0)
        const times = appliedTimesAfterDrop([...rows([1, 0], 'f'), ...rows([3, 2])], personas)
        expect(times.size).toBe(1)
        expect(sortedIn(applied(personas, times), [2, 3])).toEqual([3, 2])
    })

    it('a persona dropped into another folder takes its place there', () => {
        const personas = [{ lastAppliedAt: 100 }, { lastAppliedAt: 50 }, { lastAppliedAt: 40 }]
        const times = appliedTimesAfterDrop([...rows([1, 0, 2], 'f')], personas)
        expect(sortedIn(applied(personas, times), [0, 1, 2])).toEqual([1, 0, 2])
    })

    it('always reproduces the dropped order (seeded shuffles, with ties)', () => {
        let seed = 7
        const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
        for (let round = 0; round < 300; round++) {
            const n = 2 + Math.floor(random() * 12)
            const personas: P[] = Array.from({ length: n }, () => random() < 0.4 ? {} : { lastAppliedAt: Math.floor(random() * 5) * 10 })
            const order = sortedIn(personas, personas.map((_, i) => i))
            // Move one row, or shuffle a few.
            const shown = [...order]
            const moves = 1 + Math.floor(random() * 3)
            for (let m = 0; m < moves; m++) {
                const [row] = shown.splice(Math.floor(random() * shown.length), 1)
                shown.splice(Math.floor(random() * (shown.length + 1)), 0, row)
            }
            const times = appliedTimesAfterDrop(rows(shown), personas)
            expect(sortedIn(applied(personas, times), order)).toEqual(shown)
            if (moves === 1) expect(times.size).toBeLessThanOrEqual(n)
        }
    })
})
