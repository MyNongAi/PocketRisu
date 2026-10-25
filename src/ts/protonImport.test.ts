import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('src/lang', () => ({
    language: {
        protonInspecting: 'reading',
        protonImportFailed: 'failed',
        protonPasswordPrompt: 'enter password',
        protonPasswordWrong: 'wrong password',
    },
}))
const alertInput = vi.fn()
const alertError = vi.fn()
vi.mock('./alert', () => ({
    alertClear: () => {},
    alertWait: () => {},
    notifyLoading: () => () => {},
    alertError: (m: string) => alertError(m),
    alertInput: (...a: unknown[]) => alertInput(...a),
    notifySuccess: () => {},
}))
const inspectProtonShare = vi.fn()
vi.mock('./protonShareClient', async () => {
    const actual = await vi.importActual<typeof import('./protonShareClient')>('./protonShareClient')
    return {
        ...actual,
        inspectProtonShare: (...a: unknown[]) => inspectProtonShare(...a),
        downloadProtonEntry: vi.fn(),
        stageProtonEntry: (...a: unknown[]) => stageProtonEntry(...a),
    }
})
const stageProtonEntry = vi.fn()
const journal = { id: '11111111-2222-4333-8444-555555555555', journaled: true }
const openImportJournal = vi.fn(async () => journal)
const closeImportJournal = vi.fn(async (..._a: unknown[]) => {})
const runImportTransaction = vi.fn(async (_report: unknown, work: (scope: unknown) => Promise<unknown>, _deps?: unknown, _opened?: unknown) => work('transaction'))
vi.mock('./importTransaction', () => ({
    openImportJournal: () => openImportJournal(),
    closeImportJournal: (...a: unknown[]) => closeImportJournal(...a),
    runImportTransaction: (...a: Parameters<typeof runImportTransaction>) => runImportTransaction(...a),
}))
vi.mock('./globalApi.svelte', () => ({ forageStorage: {} }))
vi.mock('./importProgress', () => ({ runPrefetchedImportBatch: vi.fn() }))
vi.mock('./protonBrowser.svelte', () => ({ openProtonBrowser: vi.fn() }))
vi.mock('./shareTargetRouting', () => ({ classifySharedImport: vi.fn() }))
vi.mock('./characterCards', () => ({ importCharacterProcess: vi.fn() }))
vi.mock('./process/modules', () => ({ importModuleFile: vi.fn() }))
vi.mock('./storage/database.svelte', () => ({ importPreset: vi.fn() }))

const { ProtonRequestError } = await import('./protonShareClient')
const { openProtonShare, fetchProtonFile, importProtonFile, discardProtonFile } = await import('./protonImport')
const { stagedAssetRef } = await import('./stagedAssets')

const LINK = 'https://drive.proton.me/urls/ABC123#key'
const LISTING = { kind: 'file', name: 'bot.charx', entries: [], trail: [] }
const needsPassword = () => new ProtonRequestError('This link needs the password its owner set', 401)

describe('openProtonShare', () => {
    beforeEach(() => vi.clearAllMocks())

    test('an open link reads straight away without a prompt', async () => {
        inspectProtonShare.mockResolvedValueOnce(LISTING)
        await expect(openProtonShare(LINK)).resolves.toEqual({ info: LISTING, password: '' })
        expect(alertInput).not.toHaveBeenCalled()
    })

    test('a password-protected link asks for the password (masked) and keeps it for later calls', async () => {
        inspectProtonShare.mockRejectedValueOnce(needsPassword()).mockResolvedValueOnce(LISTING)
        alertInput.mockResolvedValueOnce('secret')
        await expect(openProtonShare(LINK)).resolves.toEqual({ info: LISTING, password: 'secret' })
        expect(alertInput).toHaveBeenCalledWith('enter password', [], '', { hideText: true })
        expect(inspectProtonShare.mock.calls[1]).toEqual([LINK, 'secret'])
    })

    test('a refused password asks again, saying it was wrong', async () => {
        inspectProtonShare
            .mockRejectedValueOnce(needsPassword())
            .mockRejectedValueOnce(new ProtonRequestError('Incorrect login credentials', 502))
            .mockResolvedValueOnce(LISTING)
        alertInput.mockResolvedValueOnce('wrong').mockResolvedValueOnce('right')
        await expect(openProtonShare(LINK)).resolves.toEqual({ info: LISTING, password: 'right' })
        expect(alertInput.mock.calls[1][0]).toContain('wrong password')
        expect(alertError).not.toHaveBeenCalled()
    })

    test('cancelling the prompt stops without an error', async () => {
        inspectProtonShare.mockRejectedValueOnce(needsPassword())
        alertInput.mockResolvedValueOnce('')
        await expect(openProtonShare(LINK)).resolves.toBeNull()
        expect(alertError).not.toHaveBeenCalled()
    })

    test('a link that fails for another reason is reported, not prompted', async () => {
        inspectProtonShare.mockRejectedValueOnce(new ProtonRequestError('Proton has no such link', 404))
        await expect(openProtonShare(LINK)).resolves.toBeNull()
        expect(alertInput).not.toHaveBeenCalled()
        expect(alertError).toHaveBeenCalledWith('failed\nProton has no such link')
    })

    test('a subject heads the prompt when the link came from somewhere else', async () => {
        inspectProtonShare.mockRejectedValueOnce(needsPassword()).mockResolvedValueOnce(LISTING)
        alertInput.mockResolvedValueOnce('pw')
        await openProtonShare(LINK, '', 'Companion module\nlink')
        expect(alertInput.mock.calls[0][0]).toBe('Companion module\nlink\n\nenter password')
    })
})

describe('a share file fetched for import (staged on the server)', () => {
    const NONCE = 'abcdefabcdefabcdefabcdefabcdef12'
    const TARGET = { path: [], expectedSize: 10 }
    beforeEach(() => vi.clearAllMocks())

    test('a staged reply keeps the journal open; its import runs on it with the stubs accepted', async () => {
        stageProtonEntry.mockResolvedValueOnce({ name: 'bot.charx', data: new Uint8Array([1]), stagedNonce: NONCE })
        const file = await fetchProtonFile(LINK, 'pw', TARGET, () => {})
        expect(stageProtonEntry.mock.calls[0]).toEqual([LINK, 'pw', TARGET, expect.any(Function), journal.id])
        expect(file.staged).toEqual({ nonce: NONCE, journal })
        expect(closeImportJournal).not.toHaveBeenCalled()

        const stub = new TextEncoder().encode(`PRSTAGE1:${NONCE}:assets/${'b'.repeat(64)}.png\n`)
        const result = await importProtonFile(file, () => {}, async (scope) => [scope, stagedAssetRef(stub)])
        expect(result).toEqual(['transaction', `assets/${'b'.repeat(64)}.png`])
        expect(runImportTransaction.mock.calls[0][3]).toBe(journal)
        expect(stagedAssetRef(stub)).toBeUndefined()
    })

    test('a file sent whole closes the journal without undoing, and imports as before', async () => {
        stageProtonEntry.mockResolvedValueOnce({ name: 'preset.risup', data: new Uint8Array([2]) })
        const file = await fetchProtonFile(LINK, '', TARGET, () => {})
        expect(file.staged).toBeUndefined()
        expect(closeImportJournal).toHaveBeenCalledWith(journal, false)
        await expect(importProtonFile(file, () => {}, async (scope) => scope)).resolves.toBeUndefined()
        expect(runImportTransaction).not.toHaveBeenCalled()
    })

    test('a failed download undoes what the server stored, and fails', async () => {
        stageProtonEntry.mockRejectedValueOnce(new ProtonRequestError('Proton has no such link', 404))
        await expect(fetchProtonFile(LINK, '', TARGET, () => {})).rejects.toThrow('Proton has no such link')
        expect(closeImportJournal).toHaveBeenCalledWith(journal, true)
    })

    test('a staged file dropped before its import takes its assets back', async () => {
        await discardProtonFile({ name: 'bot.charx', data: new Uint8Array(), staged: { nonce: NONCE, journal } })
        expect(closeImportJournal).toHaveBeenCalledWith(journal, true)
        await discardProtonFile({ name: 'preset.risup', data: new Uint8Array() })
        expect(closeImportJournal).toHaveBeenCalledTimes(1)
    })
})