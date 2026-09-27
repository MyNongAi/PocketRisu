import { describe, expect, it } from 'vitest'
import type { ArchivedCharacterStub, character, folder } from './storage/database.svelte'
import { applyCharacterOrderCheck, type CharacterOrderDatabase } from './characterOrderCheck'
import { DEACTIVATED_FOLDER_IDS, isDeactivatedSystemFolder, placeReactivatedCharacter } from './deactivatedCharacterFolders'
import { promoteRecentlyViewedCharacter } from './characterRecentOrder'
import type { OrderEntry } from './characterOrder'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0)

function char(chaId: string, extra: Partial<character> = {}): character {
    return { chaId, name: chaId, lastInteraction: NOW, ...extra } as character
}

function stub(chaId: string, idleDays: number | null, extra: Partial<ArchivedCharacterStub> = {}): ArchivedCharacterStub {
    return {
        chaId, name: chaId, image: '', tags: [], lastInteraction: idleDays === null ? 0 : NOW - idleDays * DAY,
        archivedAt: 1, bytes: 1, chatCount: 0, chatIds: [], ...extra,
    }
}

function userFolder(id: string, data: string[], extra: Partial<folder> = {}): folder {
    return { id, name: id, color: '', data, ...extra }
}

/** A database whose writes are counted, standing in for the reactive DB (every write there schedules a save). */
function trackedDb(initial: CharacterOrderDatabase) {
    const writes: string[] = []
    let order = initial.characterOrder
    let hidden = initial.nodeOnlyHiddenCharacterIds
    let stubs = initial.nodeOnlyArchivedCharacters
    const db = {
        characters: initial.characters,
        nodeOnlyGroupDeactivatedCharacters: initial.nodeOnlyGroupDeactivatedCharacters,
        get characterOrder() { return order },
        set characterOrder(value) { writes.push('characterOrder'); order = value },
        get nodeOnlyHiddenCharacterIds() { return hidden },
        set nodeOnlyHiddenCharacterIds(value) { writes.push('hidden'); hidden = value },
        get nodeOnlyArchivedCharacters() { return stubs },
        set nodeOnlyArchivedCharacters(value) { writes.push('stubs'); stubs = value },
    } as CharacterOrderDatabase
    return { db, writes }
}

function ids(order: OrderEntry[] | undefined): string[] {
    return (order ?? []).map((entry) => typeof entry === 'string' ? entry : entry.id)
}

function folderData(order: OrderEntry[] | undefined, id: string): string[] | undefined {
    return (order ?? []).find((entry): entry is folder => typeof entry !== 'string' && entry.id === id)?.data
}

/** What activateCharacter does to the order: the real placement and promotion, then the real check. */
function reactivate(db: CharacterOrderDatabase, chaId: string, now = NOW) {
    db.nodeOnlyArchivedCharacters = (db.nodeOnlyArchivedCharacters ?? []).filter((s) => s.chaId !== chaId)
    db.characters.push(char(chaId))
    const favorites = new Set(db.characters.filter((c) => c.favorite).map((c) => c.chaId))
    db.characterOrder = promoteRecentlyViewedCharacter(placeReactivatedCharacter(db.characterOrder ?? [], chaId), chaId, favorites)
    applyCharacterOrderCheck(db, { now })
}

describe('checkCharOrder with deactivated characters in idle-age folders', () => {
    it('files loose stubs by age on the first run and leaves stubs in user folders alone', () => {
        const db: CharacterOrderDatabase = {
            characters: [char('a'), char('b'), char('c')],
            characterOrder: ['a', userFolder('f1', ['b', 's1', 'c']), 's2', 's3'],
            nodeOnlyArchivedCharacters: [stub('s1', 10), stub('s2', 90), stub('s3', 20)],
        }
        const stubsBefore = JSON.stringify(db.nodeOnlyArchivedCharacters)
        expect(applyCharacterOrderCheck(db, { now: NOW })).toBe(true)
        expect(db.characterOrder).toEqual([
            'a',
            userFolder('f1', ['b', 's1', 'c']),
            expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[15], data: ['s3'], name: 'Inactive 15d', nodeOnlySystem: 'deactivated' }),
            expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[60], data: ['s2'], name: 'Inactive 60d+' }),
        ])
        // Nothing is written to the stubs any more.
        expect(JSON.stringify(db.nodeOnlyArchivedCharacters)).toBe(stubsBefore)
    })

    it('is idempotent: a second run writes nothing, so it schedules no save', () => {
        const { db, writes } = trackedDb({
            characters: [char('a'), char('b', { favorite: true })],
            characterOrder: ['a', userFolder('f1', ['s1', 'b', 'x']), 's2', userFolder('z', ['s3', 's4'])],
            nodeOnlyArchivedCharacters: [stub('s1', 3), stub('s2', 40), stub('s3', 1), stub('s4', 70), stub('t', 1, { trashedAt: 9 })],
            nodeOnlyHiddenCharacterIds: ['a'],
        })
        expect(applyCharacterOrderCheck(db, { now: NOW })).toBe(true)
        expect(writes).toEqual(['characterOrder'])
        expect(ids(db.characterOrder)).toEqual(['f1', 'a', 'z', DEACTIVATED_FOLDER_IDS[30]])
        const orderAfterFirst = JSON.stringify(db.characterOrder)

        writes.length = 0
        expect(applyCharacterOrderCheck(db, { now: NOW })).toBe(false)
        expect(applyCharacterOrderCheck(db, { now: NOW + 60_000 })).toBe(false)
        expect(writes).toEqual([])
        expect(JSON.stringify(db.characterOrder)).toBe(orderAfterFirst)
    })

    it('keeps favorites first, then the rest, then the zone, then the age folders in 7→60 order', () => {
        const db: CharacterOrderDatabase = {
            characters: [char('a'), char('fav', { favorite: true }), char('b'), char('c')],
            characterOrder: [
                's60', userFolder('zone', ['z1', 'z2']), 's7', 'a', userFolder('pinned', ['b', 'c', 'x'], { favorite: true }), 's30', 'fav',
                userFolder('pinned-stubs', ['p1', 'p2'], { favorite: true }),
            ],
            nodeOnlyArchivedCharacters: [
                stub('s7', 2), stub('s30', 31), stub('s60', 61), stub('z1', 5), stub('z2', 6), stub('p1', 70), stub('p2', 80),
            ],
        }
        applyCharacterOrderCheck(db, { now: NOW })
        expect(ids(db.characterOrder)).toEqual([
            'pinned', 'fav', 'pinned-stubs', 'a', 'zone',
            DEACTIVATED_FOLDER_IDS[7], DEACTIVATED_FOLDER_IDS[30], DEACTIVATED_FOLDER_IDS[60],
        ])
    })

    it('moves a fully deactivated folder down as a unit, and lifts it to the top when a member is reactivated', () => {
        const box = userFolder('box', ['s1', 's2'], { color: 'blue', imgFile: 'box.png', nodeOnlyIcon: 'star' })
        const db: CharacterOrderDatabase = {
            characters: [char('fav', { favorite: true }), char('a'), char('b')],
            characterOrder: ['fav', box, 'a', 'b', 'loose'],
            nodeOnlyArchivedCharacters: [stub('s1', 20), stub('s2', 3), stub('loose', 40)],
        }
        applyCharacterOrderCheck(db, { now: NOW })
        expect(db.characterOrder).toEqual([
            'fav', 'a', 'b', box, expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[30], data: ['loose'] }),
        ])

        // Opening s1 (the dimmed card inside the folder) reactivates it.
        reactivate(db, 's1')
        expect(db.characterOrder).toEqual([
            'fav', { ...box, data: ['s1', 's2'] }, 'a', 'b', expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[30] }),
        ])
        expect(applyCharacterOrderCheck(db, { now: NOW })).toBe(false)
    })

    it('reactivating a loose stub puts it at the top level and promotes it', () => {
        const db: CharacterOrderDatabase = {
            characters: [char('fav', { favorite: true }), char('a')],
            characterOrder: ['fav', 'a', 's', 't'],
            nodeOnlyArchivedCharacters: [stub('s', 20), stub('t', 21)],
        }
        applyCharacterOrderCheck(db, { now: NOW })
        expect(ids(db.characterOrder)).toEqual(['fav', 'a', DEACTIVATED_FOLDER_IDS[15]])
        reactivate(db, 's')
        expect(db.characterOrder).toEqual(['fav', 's', 'a', expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[15], data: ['t'] })])
    })

    it('drops an age folder once its last stub is trashed or removed (enforcement only)', () => {
        const db: CharacterOrderDatabase = {
            characters: [char('a')],
            characterOrder: ['a', 's', 'u'],
            nodeOnlyArchivedCharacters: [stub('s', 1), stub('u', 70)],
        }
        applyCharacterOrderCheck(db, { now: NOW })
        expect(ids(db.characterOrder)).toEqual(['a', DEACTIVATED_FOLDER_IDS[7], DEACTIVATED_FOLDER_IDS[60]])

        db.nodeOnlyArchivedCharacters![0].trashedAt = NOW
        expect(applyCharacterOrderCheck(db, { now: NOW })).toBe(true)
        expect(ids(db.characterOrder)).toEqual(['a', DEACTIVATED_FOLDER_IDS[60]])

        db.nodeOnlyArchivedCharacters = db.nodeOnlyArchivedCharacters!.filter((s) => s.chaId !== 'u')
        expect(applyCharacterOrderCheck(db, { now: NOW })).toBe(true)
        expect(db.characterOrder).toEqual(['a'])
    })

    it('re-buckets stubs as time passes, and never back', () => {
        const db: CharacterOrderDatabase = {
            characters: [char('a')],
            characterOrder: ['a', 's1', 's2'],
            nodeOnlyArchivedCharacters: [stub('s1', 14), stub('s2', 29)],
        }
        applyCharacterOrderCheck(db, { now: NOW })
        expect(ids(db.characterOrder)).toEqual(['a', DEACTIVATED_FOLDER_IDS[7], DEACTIVATED_FOLDER_IDS[15]])
        expect(applyCharacterOrderCheck(db, { now: NOW + 2 * DAY })).toBe(true)
        expect(ids(db.characterOrder)).toEqual(['a', DEACTIVATED_FOLDER_IDS[15], DEACTIVATED_FOLDER_IDS[30]])
        // A device with a clock two days behind leaves them there.
        expect(applyCharacterOrderCheck(db, { now: NOW })).toBe(false)
    })

    it('moves an active character dragged into an age folder back out', () => {
        const db: CharacterOrderDatabase = {
            characters: [char('a')],
            characterOrder: ['a', 's'],
            nodeOnlyArchivedCharacters: [stub('s', 1)],
        }
        applyCharacterOrderCheck(db, { now: NOW })
        const system = db.characterOrder![1] as folder
        expect(system.id).toBe(DEACTIVATED_FOLDER_IDS[7])
        // A new character dropped (or synced) into the age folder.
        db.characters.push(char('b'))
        db.characterOrder = ['a', { ...system, data: ['s', 'b'] }]
        applyCharacterOrderCheck(db, { now: NOW })
        expect(db.characterOrder).toEqual(['a', 'b', expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[7], data: ['s'] })])
    })

    it('a folder left with one deactivated member dissolves and the stub lands in its age folder in the same run', () => {
        const { db, writes } = trackedDb({
            characters: [char('a')],
            characterOrder: ['a', userFolder('pair', ['s1', 's2'])],
            nodeOnlyArchivedCharacters: [stub('s1', 1), stub('s2', 40, { trashedAt: NOW })],
        })
        applyCharacterOrderCheck(db, { now: NOW })
        expect(db.characterOrder).toEqual(['a', expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[7], data: ['s1'] })])
        writes.length = 0
        expect(applyCharacterOrderCheck(db, { now: NOW })).toBe(false)
        expect(writes).toEqual([])
    })

    it('keeps trashed stubs out of the order, and a restored one lands in its bucket', () => {
        const db: CharacterOrderDatabase = {
            characters: [char('a'), char('a2')],
            characterOrder: ['a', userFolder('f', ['a2', 's', 'a3'])],
            nodeOnlyArchivedCharacters: [stub('s', 20, { trashedAt: NOW })],
        }
        db.characters.push(char('a3'))
        applyCharacterOrderCheck(db, { now: NOW })
        expect(db.characterOrder).toEqual(['a', userFolder('f', ['a2', 'a3'])])

        delete db.nodeOnlyArchivedCharacters![0].trashedAt
        applyCharacterOrderCheck(db, { now: NOW })
        expect(db.characterOrder).toEqual(['a', userFolder('f', ['a2', 'a3']), expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[15], data: ['s'] })])
    })

    it('setting off dissolves the age folders to the end of the list and stops moving folders', () => {
        const zone = userFolder('zone', ['z1', 'z2'])
        const db: CharacterOrderDatabase = {
            characters: [char('a'), char('b'), char('c')],
            characterOrder: [zone, 'a', userFolder('f1', ['b', 's1', 'c']), 's2', 's3'],
            nodeOnlyArchivedCharacters: [stub('s1', 10), stub('s2', 90), stub('s3', 1), stub('z1', 1), stub('z2', 2)],
        }
        applyCharacterOrderCheck(db, { now: NOW })
        expect(ids(db.characterOrder)).toEqual(['a', 'f1', 'zone', DEACTIVATED_FOLDER_IDS[7], DEACTIVATED_FOLDER_IDS[60]])

        db.nodeOnlyGroupDeactivatedCharacters = false
        expect(applyCharacterOrderCheck(db, { now: NOW })).toBe(true)
        expect(db.characterOrder).toEqual(['a', userFolder('f1', ['b', 's1', 'c']), zone, 's3', 's2'])
        // Off stays off: a folder that is fully deactivated elsewhere is not moved, no age folders come back.
        db.characterOrder = [zone, ...db.characterOrder!.filter((entry) => typeof entry === 'string' || entry.id !== 'zone')]
        expect(applyCharacterOrderCheck(db, { now: NOW + 30 * DAY })).toBe(false)
        expect(ids(db.characterOrder)).toEqual(['zone', 'a', 'f1', 's3', 's2'])

        db.nodeOnlyGroupDeactivatedCharacters = true
        applyCharacterOrderCheck(db, { now: NOW })
        expect(ids(db.characterOrder)).toEqual(['a', 'f1', 'zone', DEACTIVATED_FOLDER_IDS[7], DEACTIVATED_FOLDER_IDS[60]])
    })

    it('appends a new character just above the zone', () => {
        const db: CharacterOrderDatabase = {
            characters: [char('a')],
            characterOrder: ['a', 's', userFolder('zone', ['z1', 'z2'])],
            nodeOnlyArchivedCharacters: [stub('s', 1), stub('z1', 1), stub('z2', 1)],
        }
        applyCharacterOrderCheck(db, { now: NOW })
        db.characters.push(char('new'))
        applyCharacterOrderCheck(db, { now: NOW })
        expect(ids(db.characterOrder)).toEqual(['a', 'new', 'zone', DEACTIVATED_FOLDER_IDS[7]])
    })

    it('still prunes hidden ids and dissolves regular singleton folders', () => {
        const { db, writes } = trackedDb({
            characters: [char('a'), char('b')],
            characterOrder: ['a', userFolder('f', ['b', 'gone'])],
            nodeOnlyArchivedCharacters: [],
            nodeOnlyHiddenCharacterIds: ['a', 'gone'],
        })
        applyCharacterOrderCheck(db, { now: NOW })
        expect(db.characterOrder).toEqual(['a', 'b'])
        expect(db.nodeOnlyHiddenCharacterIds).toEqual(['a'])
        expect(writes.sort()).toEqual(['characterOrder', 'hidden'])
        expect(db.characterOrder!.some((entry) => isDeactivatedSystemFolder(entry))).toBe(false)
    })
})
