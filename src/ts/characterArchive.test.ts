import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: { characters: [] as any[], nodeOnlyArchivedCharacters: [] as any[] },
    confirm: vi.fn(),
    archive: vi.fn(),
    save: vi.fn(async () => {}),
    error: vi.fn(),
}))
vi.mock('src/lang', () => ({ language: {
    deactivateCharacterConfirm: (name: string) => name,
    deactivateCharacterFailed: 'failed: ',
} }))
vi.mock('./alert', () => ({ alertConfirm: mocks.confirm, alertError: mocks.error, notifySuccess: vi.fn() }))
vi.mock('./characters', () => ({ changeChar: vi.fn(), deselectCharacter: vi.fn() }))
vi.mock('./globalApi.svelte', () => ({
    checkCharOrder: vi.fn(),
    forageStorage: { realStorage: { archiveCharacter: mocks.archive } },
    requestImmediateSave: mocks.save,
    requiresFullEncoderReload: { state: false },
}))
vi.mock('./stores.svelte', () => ({
    DBState: { db: mocks.db },
    loadingOverlayStore: { set: vi.fn() },
    selectedCharID: { subscribe: (fn: (value: number) => void) => { fn(-1); return () => {} }, set: vi.fn() },
}))
vi.mock('./storage/chatStorage', () => ({ convertStubsToPlaceholders: (value: unknown) => value }))
vi.mock('./storage/nodeStorage', () => ({ CharacterArchiveError: class extends Error {} }))
vi.mock('./gui/characterAssetCount', () => ({ getCharacterAssetCount: () => 1 }))
vi.mock('./gui/characterCatalogMetrics', () => ({ exactCharacterDefinitionFingerprint: () => 'fp' }))
vi.mock('./characterRecentOrder', () => ({ promoteRecentlyViewedCharacter: (value: unknown) => value }))

const { archiveCharacter } = await import('./characterArchive')

beforeEach(() => {
    vi.clearAllMocks()
    mocks.db.characters = [{ chaId: 'a', name: 'A' }, { chaId: 'b', name: 'B' }]
    mocks.db.nodeOnlyArchivedCharacters = []
})

describe('archive request coalescing', () => {
    it('shares a pending confirmation and releases it after cancellation', async () => {
        let resolve!: (value: boolean) => void
        mocks.confirm.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done }))
        const first = archiveCharacter(0)
        const second = archiveCharacter(0)
        expect(first).toBe(second)
        expect(mocks.confirm).toHaveBeenCalledTimes(1)
        resolve(false)
        expect(await first).toBe(false)
        expect(mocks.archive).not.toHaveBeenCalled()
        mocks.confirm.mockResolvedValueOnce(false)
        await archiveCharacter(0)
        expect(mocks.confirm).toHaveBeenCalledTimes(2)
    })

    it('archives once and preserves the unrelated card on double-click', async () => {
        let resolve!: (value: object) => void
        mocks.archive.mockImplementationOnce(() => new Promise(done => { resolve = done }))
        const first = archiveCharacter(0, { skipConfirm: true, trash: true, nonBlocking: true })
        const second = archiveCharacter(0, { skipConfirm: true, trash: true, nonBlocking: true })
        expect(first).toBe(second)
        await vi.waitFor(() => expect(mocks.archive).toHaveBeenCalledTimes(1))
        resolve({ chaId: 'a', archivedAt: 123 })
        expect(await first).toBe(true)
        expect(mocks.db.characters.map(card => card.chaId)).toEqual(['b'])
        expect(mocks.db.nodeOnlyArchivedCharacters).toHaveLength(1)
        expect(mocks.db.nodeOnlyArchivedCharacters[0].trashedAt).toBeGreaterThan(0)
    })

    it('preserves the live card after failure and permits a later retry', async () => {
        mocks.archive.mockRejectedValueOnce(new Error('offline'))
        expect(await archiveCharacter(0, { skipConfirm: true, trash: true, nonBlocking: true })).toBe(false)
        expect(mocks.db.characters).toHaveLength(2)
        expect(mocks.db.nodeOnlyArchivedCharacters).toHaveLength(0)
        mocks.archive.mockResolvedValueOnce({ chaId: 'a', archivedAt: 123 })
        expect(await archiveCharacter(0, { skipConfirm: true, trash: true, nonBlocking: true })).toBe(true)
        expect(mocks.archive).toHaveBeenCalledTimes(2)
    })
})
