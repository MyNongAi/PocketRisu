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
    }
})
vi.mock('./globalApi.svelte', () => ({ forageStorage: {} }))
vi.mock('./importProgress', () => ({ runPrefetchedImportBatch: vi.fn() }))
vi.mock('./protonBrowser.svelte', () => ({ openProtonBrowser: vi.fn() }))
vi.mock('./shareTargetRouting', () => ({ classifySharedImport: vi.fn() }))
vi.mock('./characterCards', () => ({ importCharacterProcess: vi.fn() }))
vi.mock('./process/modules', () => ({ importModuleFile: vi.fn() }))
vi.mock('./storage/database.svelte', () => ({ importPreset: vi.fn() }))

const { ProtonRequestError } = await import('./protonShareClient')
const { openProtonShare } = await import('./protonImport')

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
