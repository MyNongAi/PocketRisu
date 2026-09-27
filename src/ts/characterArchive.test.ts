import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { get } from 'svelte/store'

// Deactivate → activate before the deactivation's save reached the server:
// the server still lists the character as active (409 ARCHIVE_ALREADY_ACTIVE).
// Activation used to drop the stub then, and the save that followed deleted
// the character from the database. And deactivation must not ask the server
// to archive before every earlier edit has actually been saved.

class CharacterArchiveError extends Error {
    code: string
    chats: string[]
    constructor(code: string, message: string, chats: string[] = []) {
        super(message)
        this.code = code
        this.chats = chats
    }
}

const flushSaves = vi.fn<() => Promise<boolean>>()
const trackCharacterForSave = vi.fn()
const requestImmediateSave = vi.fn()
const storage = {
    activateCharacter: vi.fn(),
    archiveCharacter: vi.fn(),
    archiveCharacters: vi.fn(),
}
const overlay = vi.fn()
const deselectCharacter = vi.fn()
const changeChar = vi.fn()
const alertConfirm = vi.fn(async (..._args: unknown[]) => true)
const alertError = vi.fn()
const promoteRecentlyViewedCharacter = vi.fn((order: unknown, _chaId?: string, _favoriteIds?: Set<string>) => order)
const checkCharOrder = vi.fn()
const state: { db: any } = { db: null }

vi.mock('./globalApi.svelte', () => ({
    checkCharOrder: () => checkCharOrder(),
    flushSaves: () => flushSaves(),
    forageStorage: { get realStorage() { return storage } },
    requestImmediateSave: () => requestImmediateSave(),
    requiresFullEncoderReload: { state: false },
    trackCharacterForSave: (id: string) => trackCharacterForSave(id),
}))
const { writable } = await import('svelte/store')
const selectedCharID = writable(-1)
vi.mock('./stores.svelte', async () => {
    return {
        DBState: { get db() { return state.db } },
        loadingOverlayStore: { set: (v: any) => overlay(v) },
        selectedCharID,
    }
})
vi.mock('./alert', () => ({
    alertConfirm: (...args: unknown[]) => alertConfirm(...args),
    alertError: (...args: unknown[]) => alertError(...args),
    notifyError: () => {},
    notifySuccess: () => {},
}))
vi.mock('./characters', () => ({ changeChar: (...args: unknown[]) => changeChar(...args), deselectCharacter: () => deselectCharacter() }))
vi.mock('./storage/chatStorage', () => ({ convertStubsToPlaceholders: (chats: any[]) => chats }))
vi.mock('./storage/nodeStorage', () => ({ CharacterArchiveError }))
vi.mock('./gui/characterAssetCount', () => ({ getCharacterAssetCount: () => 1 }))
vi.mock('./gui/characterCatalogMetrics', () => ({ exactCharacterDefinitionFingerprint: () => 'fp' }))
vi.mock('./characterRecentOrder', async (importOriginal) => ({
    ...await importOriginal<typeof import('./characterRecentOrder')>(),
    promoteRecentlyViewedCharacter: (...args: Parameters<typeof promoteRecentlyViewedCharacter>) => promoteRecentlyViewedCharacter(...args),
}))
vi.mock('src/lang', () => ({
    language: new Proxy({}, { get: (_t, key) => typeof key === 'string' && /(Confirm|Progress)$/.test(key) ? () => String(key) : String(key) }),
}))

const {
    activateCharacter, archiveCharacter, archiveCharacters, promptActivateCharacter, restoreTrashedCharacter, trashDeactivatedCharacter,
} = await import('./characterArchive')

const stub = { chaId: 'c1', name: 'One', archivedAt: 1000 }
const restored = () => ({ chaId: 'c1', name: 'One', chats: [{ id: 'x', name: 'Chat', _stub: true }] })

beforeEach(() => {
    vi.clearAllMocks()
    alertConfirm.mockReset()
    flushSaves.mockResolvedValue(true)
})

describe('activateCharacter', () => {
    test('waits for the pending save and retries when the server still has the character active', async () => {
        state.db = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        storage.activateCharacter
            .mockRejectedValueOnce(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'Character is already active'))
            .mockResolvedValueOnce(restored())
        expect(await activateCharacter('c1')).toBe(0)
        expect(flushSaves).toHaveBeenCalledTimes(1)
        expect(storage.activateCharacter).toHaveBeenNthCalledWith(2, 'c1', 1000)
        expect(state.db.characters.map((c: any) => c.chaId)).toEqual(['c1'])
        expect(state.db.nodeOnlyArchivedCharacters).toEqual([])
    })

    test('keeps the stub when the server still reports it active after saving', async () => {
        state.db = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        storage.activateCharacter.mockRejectedValue(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'Character is already active'))
        await expect(activateCharacter('c1')).rejects.toMatchObject({ code: 'ARCHIVE_ALREADY_ACTIVE' })
        expect(state.db.nodeOnlyArchivedCharacters).toEqual([stub])
        expect(state.db.characters).toEqual([])
    })

    test('keeps the stub when the pending save cannot be completed', async () => {
        state.db = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        flushSaves.mockResolvedValue(false)
        storage.activateCharacter.mockRejectedValue(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'Character is already active'))
        await expect(activateCharacter('c1')).rejects.toMatchObject({ code: 'ARCHIVE_ALREADY_ACTIVE' })
        expect(storage.activateCharacter).toHaveBeenCalledTimes(1)
        expect(state.db.nodeOnlyArchivedCharacters).toEqual([stub])
    })

    test('works on the database object current after the save, not the one it started with', async () => {
        const before = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        const after = { characters: [], nodeOnlyArchivedCharacters: [{ ...stub }] }
        state.db = before
        storage.activateCharacter
            .mockRejectedValueOnce(new CharacterArchiveError('ARCHIVE_ALREADY_ACTIVE', 'x'))
            .mockResolvedValueOnce(restored())
        flushSaves.mockImplementation(async () => { state.db = after; return true })
        await activateCharacter('c1')
        expect(after.characters.map((c: any) => c.chaId)).toEqual(['c1'])
        expect(after.nodeOnlyArchivedCharacters).toEqual([])
    })

    test('promotes the reactivated character in the recent order', async () => {
        const order = ['c0', 'c1']
        state.db = { characters: [{ chaId: 'c0', name: 'Zero', favorite: true }], characterOrder: order, nodeOnlyArchivedCharacters: [{ ...stub }] }
        storage.activateCharacter.mockResolvedValueOnce(restored())
        expect(await activateCharacter('c1')).toBe(1)
        expect(promoteRecentlyViewedCharacter).toHaveBeenCalledWith(order, 'c1', new Set(['c0']))
    })

    test('an automatically deactivated character opens without asking first', async () => {
        state.db = { characters: [], characterOrder: [], nodeOnlyArchivedCharacters: [{ ...stub, autoDeactivatedAt: 5 }] }
        storage.activateCharacter.mockResolvedValueOnce(restored())
        expect(await promptActivateCharacter('c1')).toBe(true)
        expect(alertConfirm).not.toHaveBeenCalled()
        expect(changeChar).toHaveBeenCalledWith(0, {})
    })
})

describe('archiveCharacter', () => {
    test('does not archive while earlier edits are still unsaved', async () => {
        state.db = { characters: [{ chaId: 'c1', name: 'One', chats: [] }], nodeOnlyArchivedCharacters: [] }
        flushSaves.mockResolvedValue(false)
        expect(await archiveCharacter(0, { skipConfirm: true })).toBe(false)
        expect(storage.archiveCharacter).not.toHaveBeenCalled()
        expect(state.db.characters).toHaveLength(1)
    })

    test('gives an id-less chat an id and saves it before the server builds the payload', async () => {
        const chat: any = { name: 'Chat 1', message: [{ role: 'user', data: 'hi' }] }
        const placeholder: any = { id: 'p', name: 'Old', message: [], _placeholder: true }
        state.db = { characters: [{ chaId: 'c1', name: 'One', chats: [chat, placeholder] }], nodeOnlyArchivedCharacters: [] }
        const order: string[] = []
        trackCharacterForSave.mockImplementation(() => order.push('track'))
        flushSaves.mockImplementation(async () => { order.push('flush'); return true })
        storage.archiveCharacter.mockImplementation(async () => { order.push('archive'); return { ...stub } })
        expect(await archiveCharacter(0, { skipConfirm: true })).toBe(true)
        expect(typeof chat.id).toBe('string')
        expect(chat.id.length).toBeGreaterThan(0)
        expect(placeholder.id).toBe('p')
        expect(trackCharacterForSave).toHaveBeenCalledWith('c1')
        expect(order.slice(0, 3)).toEqual(['track', 'flush', 'archive'])
        expect(state.db.characters).toEqual([])
        expect(state.db.nodeOnlyArchivedCharacters.map((s: any) => s.chaId)).toEqual(['c1'])
    })

    test('waits for the transition to be saved before reporting success', async () => {
        state.db = { characters: [{ chaId: 'c1', name: 'One', chats: [] }], nodeOnlyArchivedCharacters: [] }
        storage.archiveCharacter.mockResolvedValue({ ...stub })
        await archiveCharacter(0, { skipConfirm: true })
        // Once before the server call, once after moving the character.
        expect(flushSaves).toHaveBeenCalledTimes(2)
        expect(requestImmediateSave).not.toHaveBeenCalled()
    })

    test('keeps the catalog metadata on the stub', async () => {
        state.db = {
            characters: [{ chaId: 'c1', name: 'One', chats: [], titleColor: 'red', sourceInfo: { label: 'Src' } }],
            nodeOnlyArchivedCharacters: [],
        }
        storage.archiveCharacter.mockResolvedValue({ ...stub })
        expect(await archiveCharacter(0, { skipConfirm: true })).toBe(true)
        const saved = state.db.nodeOnlyArchivedCharacters[0]
        expect(saved).toMatchObject({ chaId: 'c1', assetCount: 1, titleColor: 'red', sourceInfo: { label: 'Src' }, exactDefinitionFingerprint: 'fp' })
        expect(saved.autoDeactivatedAt).toBeUndefined()
    })

    test('marks an automatic deactivation and skips the fingerprint for the trash', async () => {
        state.db = { characters: [{ chaId: 'c1', name: 'One', chats: [] }, { chaId: 'c2', name: 'Two', chats: [] }], nodeOnlyArchivedCharacters: [] }
        storage.archiveCharacter
            .mockResolvedValueOnce({ ...stub })
            .mockResolvedValueOnce({ chaId: 'c2', name: 'Two', archivedAt: 1 })
        expect(await archiveCharacter(0, { skipConfirm: true, silent: true, automatic: true })).toBe(true)
        expect(await archiveCharacter(0, { skipConfirm: true, trash: true })).toBe(true)
        const [auto, trashed] = state.db.nodeOnlyArchivedCharacters
        expect(auto.autoDeactivatedAt).toBeGreaterThan(0)
        expect(trashed.trashedAt).toBeGreaterThan(0)
        expect(trashed.exactDefinitionFingerprint).toBeUndefined()
        expect(trashed.assetCount).toBe(1)
    })
})

describe('archive request coalescing', () => {
    beforeEach(() => {
        state.db = { characters: [{ chaId: 'a', name: 'A', chats: [] }, { chaId: 'b', name: 'B', chats: [] }], nodeOnlyArchivedCharacters: [] }
    })

    test('shares a pending confirmation and releases it after cancellation', async () => {
        let resolve!: (value: boolean) => void
        alertConfirm.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done }))
        const first = archiveCharacter(0)
        const second = archiveCharacter(0)
        expect(first).toBe(second)
        expect(alertConfirm).toHaveBeenCalledTimes(1)
        resolve(false)
        expect(await first).toBe(false)
        expect(storage.archiveCharacter).not.toHaveBeenCalled()
        alertConfirm.mockResolvedValueOnce(false)
        await archiveCharacter(0)
        expect(alertConfirm).toHaveBeenCalledTimes(2)
    })

    test('archives once and preserves the unrelated card on double-click', async () => {
        let resolve!: (value: object) => void
        storage.archiveCharacter.mockImplementationOnce(() => new Promise(done => { resolve = done }))
        const first = archiveCharacter(0, { skipConfirm: true, trash: true, nonBlocking: true })
        const second = archiveCharacter(0, { skipConfirm: true, trash: true, nonBlocking: true })
        expect(first).toBe(second)
        await vi.waitFor(() => expect(storage.archiveCharacter).toHaveBeenCalledTimes(1))
        resolve({ chaId: 'a', archivedAt: 123 })
        expect(await first).toBe(true)
        expect(state.db.characters.map((card: any) => card.chaId)).toEqual(['b'])
        expect(state.db.nodeOnlyArchivedCharacters).toHaveLength(1)
        expect(state.db.nodeOnlyArchivedCharacters[0].trashedAt).toBeGreaterThan(0)
        // nonBlocking: no overlay covers the chat while the trash move is written.
        expect(overlay).not.toHaveBeenCalled()
    })

    test('preserves the live card after failure and permits a later retry', async () => {
        storage.archiveCharacter.mockRejectedValueOnce(new Error('offline'))
        expect(await archiveCharacter(0, { skipConfirm: true, trash: true, nonBlocking: true })).toBe(false)
        expect(state.db.characters).toHaveLength(2)
        expect(state.db.nodeOnlyArchivedCharacters).toHaveLength(0)
        storage.archiveCharacter.mockResolvedValueOnce({ chaId: 'a', archivedAt: 123 })
        expect(await archiveCharacter(0, { skipConfirm: true, trash: true, nonBlocking: true })).toBe(true)
        expect(storage.archiveCharacter).toHaveBeenCalledTimes(2)
    })
})

describe('archiveCharacters (bulk)', () => {
    const chars = (n: number) => Array.from({ length: n }, (_, i) => ({ chaId: `c${i}`, name: `C${i}`, chats: [] }))
    const okFor = (ids: string[]) => ids.map((chaId) => ({ chaId, ok: true, stub: { chaId, name: chaId, archivedAt: 1 } }))

    test('sends chunks of 20 and saves after each, with one save before the first', async () => {
        state.db = { characters: chars(45), nodeOnlyArchivedCharacters: [] }
        const order: string[] = []
        flushSaves.mockImplementation(async () => { order.push('flush'); return true })
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => { order.push(`batch${ids.length}`); return okFor(ids) })
        const out = await archiveCharacters(state.db.characters.map((c: any) => c.chaId), { trash: true })
        expect(order).toEqual(['flush', 'batch20', 'flush', 'batch20', 'flush', 'batch5', 'flush'])
        expect(storage.archiveCharacters).toHaveBeenCalledWith(expect.any(Array), { acceptLostChats: true })
        expect(out).toMatchObject({ done: 45, failed: [], lost: [], stopped: false })
        expect(state.db.characters).toEqual([])
        expect(state.db.nodeOnlyArchivedCharacters).toHaveLength(45)
        expect(state.db.nodeOnlyArchivedCharacters.every((s: any) => typeof s.trashedAt === 'number')).toBe(true)
        expect(overlay).toHaveBeenLastCalledWith({ active: false, text: '', onCancel: null })
    })

    test('moves only the characters the server archived', async () => {
        state.db = { characters: chars(3), nodeOnlyArchivedCharacters: [] }
        storage.archiveCharacters.mockResolvedValue([
            { chaId: 'c0', ok: true, stub: { chaId: 'c0' } },
            { chaId: 'c1', ok: false, code: 'ARCHIVE_VERIFY_FAILED', error: 'bad' },
            { chaId: 'c2', ok: false, code: 'ARCHIVE_CHATS_UNAVAILABLE', error: 'lost', chats: ['X'] },
        ])
        const out = await archiveCharacters(['c0', 'c1', 'c2'])
        expect(storage.archiveCharacters).toHaveBeenCalledWith(['c0', 'c1', 'c2'], { acceptLostChats: false })
        expect(state.db.characters.map((c: any) => c.chaId)).toEqual(['c1', 'c2'])
        expect(out.done).toBe(1)
        expect(out.failed).toEqual([{ chaId: 'c1', name: 'C1', reason: 'bad' }])
        expect(out.lost).toEqual([{ chaId: 'c2', name: 'C2', chats: ['X'] }])
    })

    test('stops before the next chunk when a save does not land', async () => {
        state.db = { characters: chars(30), nodeOnlyArchivedCharacters: [] }
        flushSaves.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => okFor(ids))
        const out = await archiveCharacters(state.db.characters.map((c: any) => c.chaId))
        expect(storage.archiveCharacters).toHaveBeenCalledTimes(1)
        expect(out).toMatchObject({ done: 20, stopped: true })
        expect(state.db.characters).toHaveLength(10)
    })

    test('does not start while earlier edits are unsaved', async () => {
        state.db = { characters: chars(2), nodeOnlyArchivedCharacters: [] }
        flushSaves.mockResolvedValue(false)
        await expect(archiveCharacters(['c0', 'c1'])).rejects.toThrow()
        expect(storage.archiveCharacters).not.toHaveBeenCalled()
        expect(state.db.characters).toHaveLength(2)
        expect(overlay).toHaveBeenLastCalledWith({ active: false, text: '', onCancel: null })
    })

    test('refuses a second run while one is in progress', async () => {
        state.db = { characters: chars(2), nodeOnlyArchivedCharacters: [] }
        let release!: () => void
        storage.archiveCharacters.mockImplementation((ids: string[]) => new Promise((r) => { release = () => r(okFor(ids)) }))
        const first = archiveCharacters(['c0'])
        await expect(archiveCharacters(['c1'])).rejects.toThrow('bulkArchiveBusy')
        await vi.waitFor(() => expect(storage.archiveCharacters).toHaveBeenCalledTimes(1))
        release()
        await first
        // Free again once the first run has finished.
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => okFor(ids))
        expect(await archiveCharacters(['c1'])).toMatchObject({ done: 1 })
    })

    test('keeps the selected character selected by id, and deselects an archived one', async () => {
        state.db = { characters: chars(4), nodeOnlyArchivedCharacters: [] }
        selectedCharID.set(3)
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => okFor(ids))
        await archiveCharacters(['c0', 'c1'])
        expect(get(selectedCharID)).toBe(1)
        expect(state.db.characters[1].chaId).toBe('c3')
        await archiveCharacters(['c3'])
        expect(deselectCharacter).toHaveBeenCalled()
        selectedCharID.set(-1)
    })

    test('keeps the same catalog metadata on each stub as a single deactivation', async () => {
        state.db = { characters: chars(2).map((c) => ({ ...c, titleColor: 'blue' })), nodeOnlyArchivedCharacters: [] }
        storage.archiveCharacters.mockImplementation(async (ids: string[]) => okFor(ids))
        await archiveCharacters(['c0'])
        await archiveCharacters(['c1'], { trash: true })
        const [deactivated, trashed] = state.db.nodeOnlyArchivedCharacters
        expect(deactivated).toMatchObject({ chaId: 'c0', assetCount: 1, titleColor: 'blue', exactDefinitionFingerprint: 'fp' })
        expect(trashed).toMatchObject({ chaId: 'c1', assetCount: 1, titleColor: 'blue' })
        expect(trashed.exactDefinitionFingerprint).toBeUndefined()
    })
})

describe('trash keeps the folder', () => {
    // checkCharOrder is mocked out here; the real one drops trashed ids from
    // every folder, which `leaveOrder` stands in for.
    const leaveOrder = (chaId: string) => {
        for (const e of state.db.characterOrder) if (typeof e !== 'string') e.data = e.data.filter((id: string) => id !== chaId)
    }

    test('restoring puts the character back into the folder it was trashed from', () => {
        state.db = {
            characters: [],
            characterOrder: ['top', { id: 'F', name: 'F', data: ['c1', 'c2'], color: '' }],
            nodeOnlyArchivedCharacters: [{ ...stub }, { chaId: 'top', name: 'Top', archivedAt: 1 }],
        }
        expect(trashDeactivatedCharacter('c1')).toBe(true)
        expect(trashDeactivatedCharacter('top')).toBe(true)
        expect(state.db.nodeOnlyArchivedCharacters[0].trashedFromFolder).toBe('F')
        expect(state.db.nodeOnlyArchivedCharacters[1].trashedFromFolder).toBeUndefined()
        leaveOrder('c1')

        expect(restoreTrashedCharacter('c1')).toBe(true)
        expect(state.db.characterOrder[1].data).toEqual(['c2', 'c1'])
        expect(state.db.nodeOnlyArchivedCharacters[0].trashedAt).toBeUndefined()
        expect(state.db.nodeOnlyArchivedCharacters[0].trashedFromFolder).toBeUndefined()
    })

    test('a folder deleted meanwhile is not recreated', () => {
        state.db = {
            characters: [],
            characterOrder: [{ id: 'F', name: 'F', data: ['c1'], color: '' }],
            nodeOnlyArchivedCharacters: [{ ...stub }],
        }
        trashDeactivatedCharacter('c1')
        state.db.characterOrder = []
        expect(restoreTrashedCharacter('c1')).toBe(true)
        expect(state.db.characterOrder).toEqual([])
    })

    test('bulk trash records the folder of each character', async () => {
        state.db = {
            characters: [{ chaId: 'a', name: 'A', chats: [] }, { chaId: 'b', name: 'B', chats: [] }],
            characterOrder: ['a', { id: 'F', name: 'F', data: ['b'], color: '' }],
            nodeOnlyArchivedCharacters: [],
        }
        storage.archiveCharacters.mockResolvedValue([
            { chaId: 'a', ok: true, stub: { chaId: 'a', archivedAt: 1 } },
            { chaId: 'b', ok: true, stub: { chaId: 'b', archivedAt: 1 } },
        ])
        await archiveCharacters(['a', 'b'], { trash: true })
        const byId = Object.fromEntries(state.db.nodeOnlyArchivedCharacters.map((s: any) => [s.chaId, s]))
        expect(byId.a.trashedFromFolder).toBeUndefined()
        expect(byId.b.trashedFromFolder).toBe('F')
    })
})

const { applyCharacterOrderCheck } = await import('./characterOrderCheck')
const { DEACTIVATED_FOLDER_IDS } = await import('./deactivatedCharacterFolders')
const actual = await vi.importActual<typeof import('./characterRecentOrder')>('./characterRecentOrder')

describe('idle-age folders on the real deactivation and reactivation paths', () => {
    const DAY = 24 * 60 * 60 * 1000
    const card = (chaId: string, extra: Record<string, unknown> = {}) => ({ chaId, name: chaId, chats: [], ...extra })
    const archivedStub = (chaId: string, idleDays: number) => ({ chaId, name: chaId, archivedAt: 1, lastInteraction: Date.now() - idleDays * DAY })
    const age = (days: 7 | 15 | 30 | 60, data: string[]) => expect.objectContaining({ id: DEACTIVATED_FOLDER_IDS[days], data })
    // Departures the real deselectCharacter would record (it promotes that card).
    let departures: (string | undefined)[] = []

    beforeEach(() => {
        departures = []
        checkCharOrder.mockImplementation(() => applyCharacterOrderCheck(state.db))
        promoteRecentlyViewedCharacter.mockImplementation(actual.promoteRecentlyViewedCharacter as any)
        deselectCharacter.mockImplementation(() => {
            const departed = state.db.characters[get(selectedCharID)]?.chaId
            departures.push(departed)
            if (departed) state.db.characterOrder = actual.promoteRecentlyViewedCharacter(state.db.characterOrder, departed)
            selectedCharID.set(-1)
        })
    })
    afterEach(() => {
        checkCharOrder.mockImplementation(() => {})
        promoteRecentlyViewedCharacter.mockImplementation((order) => order)
        deselectCharacter.mockImplementation(() => {})
        selectedCharID.set(-1)
    })

    test('deactivating the open character promotes no other card (the next one used to rise)', async () => {
        state.db = { characters: [card('a'), card('b'), card('c')], characterOrder: ['c', 'a', 'b'], nodeOnlyArchivedCharacters: [] }
        selectedCharID.set(0)
        storage.archiveCharacter.mockResolvedValueOnce(archivedStub('a', 1))
        expect(await archiveCharacter(0, { skipConfirm: true })).toBe(true)
        expect(departures).toEqual([undefined])
        expect(get(selectedCharID)).toBe(-1)
        expect(state.db.characterOrder).toEqual(['c', 'b', age(7, ['a'])])
    })

    test('bulk deactivation of the open character promotes no other card either', async () => {
        state.db = { characters: [card('a'), card('b'), card('c')], characterOrder: ['c', 'a', 'b'], nodeOnlyArchivedCharacters: [] }
        selectedCharID.set(0)
        storage.archiveCharacters.mockResolvedValueOnce([{ chaId: 'a', ok: true, stub: archivedStub('a', 1) }])
        expect(await archiveCharacters(['a'])).toMatchObject({ done: 1 })
        expect(departures).toEqual([undefined])
        expect(state.db.characterOrder).toEqual(['c', 'b', age(7, ['a'])])
    })

    test('bulk deactivation ends in the right place: loose cards by age, a folder that became fully deactivated in the zone', async () => {
        state.db = {
            characters: [card('a'), card('b'), card('c'), card('d')],
            characterOrder: ['a', { id: 'F', name: 'F', color: 'red', data: ['b', 'c'] }, 'd'],
            nodeOnlyArchivedCharacters: [],
        }
        storage.archiveCharacters.mockResolvedValueOnce([
            { chaId: 'a', ok: true, stub: archivedStub('a', 20) },
            { chaId: 'b', ok: true, stub: archivedStub('b', 1) },
            { chaId: 'c', ok: true, stub: archivedStub('c', 70) },
        ])
        expect(await archiveCharacters(['a', 'b', 'c'])).toMatchObject({ done: 3 })
        expect(checkCharOrder).toHaveBeenCalledTimes(1)
        expect(state.db.characterOrder).toEqual(['d', { id: 'F', name: 'F', color: 'red', data: ['b', 'c'] }, age(15, ['a'])])
    })

    test('reactivating a card from a fully deactivated folder lifts the whole folder to the top', async () => {
        const box = { id: 'box', name: 'Box', color: 'blue', data: ['s1', 's2'] }
        state.db = {
            characters: [card('fav', { favorite: true }), card('a')],
            characterOrder: ['fav', 'a', box, 'x'],
            nodeOnlyArchivedCharacters: [archivedStub('s1', 20), archivedStub('s2', 3), archivedStub('x', 40)],
        }
        applyCharacterOrderCheck(state.db)
        expect(state.db.characterOrder).toEqual(['fav', 'a', box, age(30, ['x'])])
        storage.activateCharacter.mockResolvedValueOnce(card('s1'))
        expect(await activateCharacter('s1')).toBe(2)
        expect(state.db.characterOrder).toEqual(['fav', box, 'a', age(30, ['x'])])
    })

    test('reactivating a loose card takes it out of its age folder to the top', async () => {
        state.db = {
            characters: [card('fav', { favorite: true }), card('a')],
            characterOrder: ['fav', 'a', 's', 't'],
            nodeOnlyArchivedCharacters: [archivedStub('s', 20), archivedStub('t', 21)],
        }
        applyCharacterOrderCheck(state.db)
        storage.activateCharacter.mockResolvedValueOnce(card('s'))
        await activateCharacter('s')
        expect(state.db.characterOrder).toEqual(['fav', 's', 'a', age(15, ['t'])])
    })
})
