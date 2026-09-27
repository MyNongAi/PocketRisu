import { describe, expect, it } from 'vitest'
import type { ArchivedCharacterStub, folder } from './storage/database.svelte'
import {
    DEACTIVATED_FOLDER_IDS,
    arrangeDeactivatedFolders,
    canMoveOrderEntry,
    deactivatedCharacterIds,
    deactivatedFolderDaysFor,
    deactivatedTailStart,
    isDeactivatedGroupingEnabled,
    isDeactivatedSystemFolder,
    isFullyDeactivatedFolder,
    isManagerFolderOpen,
    placeReactivatedCharacter,
    railFolderView,
    type DeactivatedFolderDays,
    type DeactivatedOrderEntry,
} from './deactivatedCharacterFolders'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0)

function stub(chaId: string, idleDays: number | null, extra: Partial<ArchivedCharacterStub> = {}): ArchivedCharacterStub {
    return {
        chaId,
        name: chaId.toUpperCase(),
        image: '',
        tags: [],
        lastInteraction: idleDays === null ? 0 : NOW - idleDays * DAY,
        archivedAt: 1,
        bytes: 1,
        chatCount: 0,
        chatIds: [],
        ...extra,
    }
}

function userFolder(id: string, data: string[], extra: Partial<folder> = {}): folder {
    return { id, name: id, color: '', data, ...extra }
}

function age(days: DeactivatedFolderDays, data: string[]): folder {
    return { id: DEACTIVATED_FOLDER_IDS[days], name: 'x', color: '', data, nodeOnlySystem: 'deactivated' }
}

function systemIds(order: DeactivatedOrderEntry[]): string[] {
    return order.filter((entry): entry is folder => isDeactivatedSystemFolder(entry)).map((entry) => entry.id)
}

function membersOf(order: DeactivatedOrderEntry[], folderId: string): string[] | undefined {
    return order.find((entry): entry is folder => typeof entry !== 'string' && entry.id === folderId)?.data
}

function arrange(order: DeactivatedOrderEntry[], stubs: ArchivedCharacterStub[], active: string[], now = NOW, enabled = true) {
    return arrangeDeactivatedFolders({ order, stubs, activeIds: new Set(active), enabled, now })
}

describe('deactivatedFolderDaysFor — bucket boundaries', () => {
    it.each([
        [0, 7],
        [15 * DAY - 1, 7],
        [15 * DAY, 15],
        [30 * DAY - 1, 15],
        [30 * DAY, 30],
        [60 * DAY - 1, 30],
        [60 * DAY, 60],
        [900 * DAY, 60],
    ])('idle %d ms → %d-day folder', (idle, days) => {
        expect(deactivatedFolderDaysFor(NOW - idle, NOW)).toBe(days)
    })

    it('files a character used moments ago (manual deactivation) under 7 days', () => {
        expect(deactivatedFolderDaysFor(NOW - 60_000, NOW)).toBe(7)
    })

    it('treats a missing, zero or invalid lastInteraction as never used (60+)', () => {
        for (const value of [0, undefined, null, NaN, -5, 'abc']) {
            expect(deactivatedFolderDaysFor(value, NOW)).toBe(60)
        }
    })

    it('treats a future timestamp (clock skew) as fresh', () => {
        expect(deactivatedFolderDaysFor(NOW + DAY, NOW)).toBe(7)
    })
})

describe('isDeactivatedGroupingEnabled', () => {
    it('defaults to on for undefined and only turns off for an explicit false', () => {
        expect(isDeactivatedGroupingEnabled({})).toBe(true)
        expect(isDeactivatedGroupingEnabled(undefined)).toBe(true)
        expect(isDeactivatedGroupingEnabled({ nodeOnlyGroupDeactivatedCharacters: true })).toBe(true)
        expect(isDeactivatedGroupingEnabled({ nodeOnlyGroupDeactivatedCharacters: false })).toBe(false)
    })
})

describe('arrangeDeactivatedFolders — enabled', () => {
    it('gathers loose stubs into the buckets, last and in 7→60 order', () => {
        const order: DeactivatedOrderEntry[] = ['s60', 'a', 's7', 'b', 's30', 's15']
        const stubs = [stub('s7', 1), stub('s15', 20), stub('s30', 45), stub('s60', null)]
        const next = arrange(order, stubs, ['a', 'b'])
        expect(next.slice(0, 2)).toEqual(['a', 'b'])
        expect(systemIds(next)).toEqual([
            DEACTIVATED_FOLDER_IDS[7], DEACTIVATED_FOLDER_IDS[15], DEACTIVATED_FOLDER_IDS[30], DEACTIVATED_FOLDER_IDS[60],
        ])
        expect(next.slice(2)).toEqual(systemIds(next).map((id) => expect.objectContaining({
            id, nodeOnlySystem: 'deactivated',
        })))
        expect(membersOf(next, DEACTIVATED_FOLDER_IDS[15])).toEqual(['s15'])
    })

    it('never pulls a stub out of a user folder, nor dissolves or empties one', () => {
        const mixed = userFolder('mixed', ['a', 's1', 'b'], { color: 'red', imgFile: 'cover.png' })
        const pair = userFolder('pair', ['a2', 's2'])
        const order: DeactivatedOrderEntry[] = [mixed, 'c', pair]
        const next = arrange(order, [stub('s1', 3), stub('s2', 90)], ['a', 'b', 'c', 'a2'])
        expect(next).toEqual([mixed, 'c', pair])
        expect(systemIds(next)).toEqual([])
    })

    it('moves a fully deactivated user folder into the zone, just above the age folders, as it is', () => {
        const box = userFolder('box', ['s1', 's2'], { color: 'blue', imgFile: 'box.png', nodeOnlyIcon: 'star', nodeOnlyDisplay: 'image' })
        const order: DeactivatedOrderEntry[] = [box, 'a', 'loose']
        const next = arrange(order, [stub('s1', 3), stub('s2', 40), stub('loose', 20)], ['a'])
        expect(next).toEqual(['a', box, expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[15], data: ['loose'] })])
        expect(next[1]).toBe(box)
    })

    it('keeps a favorite, an empty, and a partly active folder where they are', () => {
        const favorite = userFolder('fav', ['s1', 's2'], { favorite: true })
        const empty = userFolder('empty', [])
        const partly = userFolder('partly', ['s3', 'a'])
        const order: DeactivatedOrderEntry[] = [favorite, empty, partly, 'b']
        const next = arrange(order, [stub('s1', 1), stub('s2', 1), stub('s3', 1)], ['a', 'b'])
        expect(next).toEqual(order)
    })

    it('orders the zone by newest member, then folder id', () => {
        const older = userFolder('older', ['o1', 'o2'])
        const newer = userFolder('newer', ['n1', 'n2'])
        const tieB = userFolder('tie-b', ['t1', 't2'])
        const tieA = userFolder('tie-a', ['t3', 't4'])
        const stubs = [
            stub('o1', 70), stub('o2', 50),
            stub('n1', 90), stub('n2', 2),
            stub('t1', 10), stub('t2', 30), stub('t3', 10), stub('t4', 60),
        ]
        const next = arrange([older, tieB, 'a', newer, tieA], stubs, ['a'])
        expect(next.map((entry) => typeof entry === 'string' ? entry : entry.id)).toEqual([
            'a', 'newer', 'tie-a', 'tie-b', 'older',
        ])
    })

    it('a folder leaves the zone as soon as a member is active again', () => {
        const box = userFolder('box', ['s1', 's2'])
        const zoned = arrange([box, 'a'], [stub('s1', 3), stub('s2', 4)], ['a'])
        expect(zoned).toEqual(['a', box])
        // s1 is active again: the folder stays where it is (no longer sorted as zone).
        const next = arrange([userFolder('z', ['z1', 'z2']), ...zoned], [stub('s2', 4), stub('z1', 1), stub('z2', 1)], ['a', 's1'])
        expect(next.map((entry) => typeof entry === 'string' ? entry : entry.id)).toEqual(['a', 'box', 'z'])
    })

    it('sorts age-folder members by lastInteraction descending, then chaId', () => {
        const stubs = [stub('b2', 70), stub('a1', 70), stub('z', 65), stub('never', null), stub('x', 100)]
        const next = arrange([], stubs, [])
        expect(membersOf(next, DEACTIVATED_FOLDER_IDS[60])).toEqual(['z', 'a1', 'b2', 'x', 'never'])
    })

    it('creates only folders that have members', () => {
        expect(arrange(['a'], [stub('s', 20)], ['a'])).toEqual([
            'a', expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[15], data: ['s'] }),
        ])
    })

    it('moves an active character out of an age folder to just above the zone', () => {
        const box = userFolder('box', ['s1', 's2'])
        const next = arrange(['a', box, age(7, ['b', 's'])], [stub('s', 1), stub('s1', 1), stub('s2', 1)], ['a', 'b'])
        expect(next).toEqual(['a', 'b', box, expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[7], data: ['s'] })])
    })

    it('re-buckets monotonically: never into a younger folder than the one a stub sits in', () => {
        const stubs = [stub('s', 14), stub('t', 29)]
        const first = arrange(['s', 't'], stubs, [])
        expect(systemIds(first)).toEqual([DEACTIVATED_FOLDER_IDS[7], DEACTIVATED_FOLDER_IDS[15]])
        // Two days later both cross a boundary.
        const later = arrange(first, stubs, [], NOW + 2 * DAY)
        expect(membersOf(later, DEACTIVATED_FOLDER_IDS[15])).toEqual(['s'])
        expect(membersOf(later, DEACTIVATED_FOLDER_IDS[30])).toEqual(['t'])
        // A device whose clock is three days behind computes the younger buckets, but keeps the older ones.
        expect(arrange(later, stubs, [], NOW - DAY)).toEqual(later)
    })

    it('re-buckets the members of a retired draft-era 3-day folder', () => {
        const retired: folder = { id: 'nodeonly-deactivated-3d', name: 'Inactive 3d', color: '', data: ['s', 't'], nodeOnlySystem: 'deactivated' }
        expect(isDeactivatedSystemFolder(retired)).toBe(true)
        const next = arrange(['a', retired], [stub('s', 1), stub('t', 20)], ['a'])
        expect(next).toEqual([
            'a',
            expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[7], data: ['s'] }),
            expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[15], data: ['t'] }),
        ])
    })

    it('files a stub missing from the order, and drops a loose or age-folder duplicate of a stub kept in a user folder', () => {
        const kept = userFolder('kept', ['a', 's'])
        const next = arrange([kept, 's', age(60, ['s', 'm2'])], [stub('s', 1), stub('m1', 20), stub('m2', 80)], ['a'])
        expect(next).toEqual([
            kept,
            expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[15], data: ['m1'] }),
            expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[60], data: ['m2'] }),
        ])
    })

    it('ignores trashed stubs and stubs whose character is active again', () => {
        const next = arrange(['a'], [stub('t', 1, { trashedAt: 5 }), stub('a', 1)], ['a'])
        expect(next).toEqual(['a'])
    })

    it('normalizes a stored age folder (name, marker, favorite, similarity) but keeps its other fields', () => {
        const stored = {
            id: DEACTIVATED_FOLDER_IDS[7], name: '제멋대로', color: 'red', data: ['s'], favorite: true,
            duplicateCandidate: { kind: 'character', key: 'x' }, nodeOnlyDisplay: 'name',
        } as folder
        expect(arrange([stored], [stub('s', 1)], [])).toEqual([{
            id: DEACTIVATED_FOLDER_IDS[7], name: 'Inactive 7d', color: 'red', data: ['s'],
            nodeOnlyDisplay: 'name', nodeOnlySystem: 'deactivated',
        }])
    })

    it('is deterministic and idempotent for a given now, and never mutates its input', () => {
        const order: DeactivatedOrderEntry[] = [userFolder('f', ['s1', 's2']), 'a', 's3', userFolder('g', ['a2', 's4'])]
        const stubs = [stub('s1', 3), stub('s2', 40), stub('s3', 61), stub('s4', 1)]
        const before = JSON.stringify(order)
        const once = arrange(order, stubs, ['a', 'a2'])
        expect(JSON.stringify(order)).toBe(before)
        expect(arrange(once, stubs, ['a', 'a2'])).toEqual(once)
        expect(arrange(JSON.parse(before), stubs, ['a', 'a2'])).toEqual(once)
    })
})

describe('arrangeDeactivatedFolders — disabled', () => {
    it('dissolves the age folders to the end of the top level and moves nothing else', () => {
        const zoneFolder = userFolder('box', ['z1', 'z2'])
        const order: DeactivatedOrderEntry[] = ['a', userFolder('f1', ['b', 's0']), zoneFolder, age(7, ['s1', 's2']), age(60, ['s3'])]
        const stubs = [stub('s0', 1), stub('s1', 1), stub('s2', 1), stub('s3', null), stub('z1', 1), stub('z2', 1)]
        expect(arrange(order, stubs, ['a', 'b'], NOW, false)).toEqual([
            'a', userFolder('f1', ['b', 's0']), zoneFolder, 's1', 's2', 's3',
        ])
    })

    it('leaves an order without age folders alone', () => {
        const order: DeactivatedOrderEntry[] = [userFolder('box', ['s1', 's2']), 'a', 's3']
        expect(arrange(order, [stub('s1', 1), stub('s2', 1), stub('s3', 1)], ['a'], NOW, false)).toEqual(order)
    })
})

describe('placeReactivatedCharacter', () => {
    it('takes a card out of its age folder to the top level just above the age folders', () => {
        const box = userFolder('box', ['z1', 'z2'])
        expect(placeReactivatedCharacter(['a', box, age(7, ['t']), age(60, ['s'])], 's')).toEqual([
            'a', box, 's', age(7, ['t']),
        ])
        expect(placeReactivatedCharacter(['a', age(7, ['s', 't'])], 's')).toEqual(['a', 's', age(7, ['t'])])
    })

    it('adds a missing card at the same place', () => {
        expect(placeReactivatedCharacter(['a', age(7, ['t'])], 's')).toEqual(['a', 's', age(7, ['t'])])
        expect(placeReactivatedCharacter(['a'], 's')).toEqual(['a', 's'])
    })

    it('leaves a card inside a user folder (or at the top level) where it is', () => {
        const order = ['a', userFolder('f1', ['b', 's'])]
        expect(placeReactivatedCharacter(order, 's')).toEqual(order)
        expect(placeReactivatedCharacter(['s', 'a'], 's')).toEqual(['s', 'a'])
    })
})

describe('manual moves near the managed tail', () => {
    const isDeactivated = (id: string) => id.startsWith('s')
    const order: DeactivatedOrderEntry[] = [
        'a', userFolder('f', ['b', 's0']), 'c', userFolder('zone', ['s1', 's2']), age(7, ['s3', 's4']), age(60, ['s5']),
    ]

    it('finds where the zone and age folders start', () => {
        expect(deactivatedTailStart(order, isDeactivated)).toBe(3)
        expect(deactivatedTailStart(['a', 'b'], isDeactivated)).toBe(2)
        expect(isFullyDeactivatedFolder(order[3], isDeactivated)).toBe(true)
        expect(isFullyDeactivatedFolder(order[1], isDeactivated)).toBe(false)
    })

    it('hides "move down" into the tail and every top-level move inside it', () => {
        expect(canMoveOrderEntry(order, 'a', 1, isDeactivated, true)).toBe(true)
        expect(canMoveOrderEntry(order, 'c', -1, isDeactivated, true)).toBe(true)
        expect(canMoveOrderEntry(order, 'c', 1, isDeactivated, true)).toBe(false)
        expect(canMoveOrderEntry(order, 'zone', -1, isDeactivated, true)).toBe(false)
        expect(canMoveOrderEntry(order, 'zone', 1, isDeactivated, true)).toBe(false)
        expect(canMoveOrderEntry(order, DEACTIVATED_FOLDER_IDS[7], -1, isDeactivated, true)).toBe(false)
    })

    it('keeps moves inside a user folder, zone folders included, and none inside an age folder', () => {
        expect(canMoveOrderEntry(order, 'b', 1, isDeactivated, true)).toBe(true)
        expect(canMoveOrderEntry(order, 's1', 1, isDeactivated, true)).toBe(true)
        expect(canMoveOrderEntry(order, 's3', 1, isDeactivated, true)).toBe(false)
        expect(canMoveOrderEntry(order, 's4', -1, isDeactivated, true)).toBe(false)
    })

    it('allows everything with grouping off, and the last entry of a list without a tail', () => {
        expect(canMoveOrderEntry(order, 'c', 1, isDeactivated, false)).toBe(true)
        expect(canMoveOrderEntry(order, 'zone', 1, isDeactivated, false)).toBe(true)
        expect(canMoveOrderEntry(['a', 'b'], 'b', 1, isDeactivated, true)).toBe(true)
    })
})

describe('railFolderView — the hide option in the rail', () => {
    const stubs = deactivatedCharacterIds([stub('s1', 1), stub('s2', 1), stub('gone', 1, { trashedAt: 1 }), null as any])
    const isDeactivated = (id: string) => stubs.has(id)
    const ageFolder = age(15, ['s1'])
    const allStubs = userFolder('all', ['s1', 's2'])
    const mixed = userFolder('mixed', ['a', 's1'])
    const empty = userFolder('empty', [])

    it('skips the age folders and folders holding only deactivated characters when hiding', () => {
        expect(stubs).toEqual(new Set(['s1', 's2']))
        expect(railFolderView(ageFolder, true, isDeactivated)).toBeNull()
        expect(railFolderView(allStubs, true, isDeactivated)).toBeNull()
        expect(railFolderView(mixed, true, isDeactivated)).toEqual({})
        expect(railFolderView(empty, true, isDeactivated)).toEqual({})
    })

    it('shows them again when not hiding, the age folder with its bucket for the localized label', () => {
        expect(railFolderView(ageFolder, false, isDeactivated)).toEqual({ days: 15 })
        expect(railFolderView(allStubs, false, isDeactivated)).toEqual({})
        expect(railFolderView({ ...ageFolder, id: 'nodeonly-deactivated-3d' }, false, isDeactivated)).toEqual({ days: 7 })
    })
})

describe('age folder labels', () => {
    it('are localized whatever name is stored', async () => {
        const { languageKorean } = await import('src/lang/ko')
        const { languageEnglish } = await import('src/lang/en')
        expect([7, 15, 30, 60].map((days) => languageKorean.deactivatedFolderName(days)))
            .toEqual(['비활성 7일', '비활성 15일', '비활성 30일', '비활성 60일+'])
        expect([7, 15, 30, 60].map((days) => languageEnglish.deactivatedFolderName(days)))
            .toEqual(['Inactive 7d', 'Inactive 15d', 'Inactive 30d', 'Inactive 60d+'])
        const stored = arrange(['s'], [stub('s', 1)], [], NOW)[0] as folder
        expect(stored.name).toBe('Inactive 7d')
        expect(languageKorean.deactivatedFolderName(railFolderView({ ...stored, name: 'renamed' }, false, () => true)!.days!)).toBe('비활성 7일')
    })
})

describe('isManagerFolderOpen — search and filter expansion', () => {
    const isDeactivated = (id: string) => id.startsWith('s')
    const regular = userFolder('f', ['a', 's1'])
    const fullyDeactivated = userFolder('z', ['s1', 's2'])
    const ageFolder = age(60, ['s'])

    it('uses the stored flag, read inverted for age folders, without a search', () => {
        expect(isManagerFolderOpen(regular, false, false, 3, isDeactivated)).toBe(true)
        expect(isManagerFolderOpen(regular, true, false, 3, isDeactivated)).toBe(false)
        expect(isManagerFolderOpen(fullyDeactivated, true, false, 3, isDeactivated)).toBe(false)
        expect(isManagerFolderOpen(ageFolder, false, false, 3, isDeactivated)).toBe(false)
        expect(isManagerFolderOpen(ageFolder, true, false, 3, isDeactivated)).toBe(true)
    })

    it('opens age and fully deactivated folders holding a match while a search or filter narrows the list', () => {
        expect(isManagerFolderOpen(ageFolder, false, true, 1, isDeactivated)).toBe(true)
        expect(isManagerFolderOpen(fullyDeactivated, true, true, 1, isDeactivated)).toBe(true)
        expect(isManagerFolderOpen(ageFolder, false, true, 0, isDeactivated)).toBe(false)
        // A regular folder keeps the state the user gave it.
        expect(isManagerFolderOpen(regular, true, true, 1, isDeactivated)).toBe(false)
    })
})
