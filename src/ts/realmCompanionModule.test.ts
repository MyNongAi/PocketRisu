import { beforeEach, describe, expect, test, vi } from 'vitest'

const db = { modules: [] as any[], characters: [] as any[] }
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => db }))
vi.mock('src/lang', () => ({
    language: {
        realmCompanionModuleTask: 'task',
        realmCompanionModulePaired: (n: number) => `paired ${n}`,
        realmCompanionModuleFailed: 'failed',
        importProgress: { importing: 'importing' },
    },
}))
const notifySuccess = vi.fn()
const notifyError = vi.fn()
vi.mock('./alert', () => ({
    notifySuccess: (m: string) => notifySuccess(m),
    notifyError: (m: string) => notifyError(m),
}))
vi.mock('./importProgress', () => ({ runImportTask: (_name: string, fn: (report: () => void) => unknown) => fn(() => {}) }))
const inspectProtonShare = vi.fn()
const downloadProtonEntry = vi.fn()
vi.mock('./protonShareClient', () => ({
    inspectProtonShare: (...a: unknown[]) => inspectProtonShare(...a),
    downloadProtonEntry: (...a: unknown[]) => downloadProtonEntry(...a),
    isProtonPasswordRequired: (error: any) => error?.status === 401,
}))
const openProtonShare = vi.fn()
const importProtonShare = vi.fn()
vi.mock('./protonImport', () => ({
    openProtonShare: (...a: unknown[]) => openProtonShare(...a),
    importProtonShare: (...a: unknown[]) => importProtonShare(...a),
}))
const importModuleFile = vi.fn()
const rerenderChatForModules = vi.fn()
vi.mock('./process/modules', () => ({ importModuleFile: (...a: unknown[]) => importModuleFile(...a), rerenderChatForModules: () => rerenderChatForModules(), syncLinkedFolders: () => false }))

const {
    findProtonShareLinks, isCompanionModuleFile, pairModulesWithCharacter, importRealmCompanionModules,
} = await import('./realmCompanionModule')

const LINK = 'https://drive.proton.me/urls/ABC123#keyPart_-9'

describe('findProtonShareLinks', () => {
    test('finds share links with their key, normalized and deduplicated', () => {
        const text = `에셋 모듈: ${LINK}. 미러 ${LINK}/?utm=x 그리고 (${LINK})`
        expect(findProtonShareLinks(text)).toEqual([LINK])
    })
    test('ignores links without a key, other hosts and other paths', () => {
        expect(findProtonShareLinks('https://drive.proton.me/urls/ABC123 https://example.com/urls/A#b https://drive.proton.me/folder/x#y')).toEqual([])
    })
})

describe('module file choice', () => {
    test('RISUM and *.module.charx are modules; a plain CHARX or PNG is the bot', () => {
        expect(isCompanionModuleFile('assets.risum')).toBe(true)
        expect(isCompanionModuleFile('Assets.Module.CHARX')).toBe(true)
        expect(isCompanionModuleFile('bot.charx')).toBe(false)
        expect(isCompanionModuleFile('bot.png')).toBe(false)
        // Only these two download without asking; anything else opens the browser.
        expect(isCompanionModuleFile('Combatant Modification Simulator Image Module.charx')).toBe(false)
    })
    test('pairing appends new ids once', () => {
        const character: { modules?: string[] } = { modules: ['a'] }
        expect(pairModulesWithCharacter(character, ['a', 'b', 'b'])).toBe(1)
        expect(character.modules).toEqual(['a', 'b'])
    })
})

describe('importRealmCompanionModules', () => {
    beforeEach(() => {
        db.modules = []
        db.characters = [{ chaId: 'c1', modules: [] }]
        vi.clearAllMocks()
    })

    test('downloads the linked module, marks its source and pairs it with the character', async () => {
        inspectProtonShare.mockResolvedValue({ kind: 'file', name: 'assets.risum', entries: [], trail: [] })
        downloadProtonEntry.mockResolvedValue({ name: 'assets.risum', data: new Uint8Array([1]) })
        importModuleFile.mockImplementation(async () => { const m = { id: 'm1', name: 'assets' }; db.modules.push(m); return m })
        await importRealmCompanionModules('c1', [`desc ${LINK}`, undefined])
        expect(downloadProtonEntry).toHaveBeenCalledTimes(1)
        expect(db.modules[0].nodeOnlyProtonShare).toBe(LINK)
        expect(db.characters[0].modules).toEqual(['m1'])
        expect(notifySuccess).toHaveBeenCalledWith('paired 1')
        // The open chat re-renders so the module's images show without a reload.
        expect(rerenderChatForModules).toHaveBeenCalled()
    })

    test('a module already downloaded from the link is paired without downloading again', async () => {
        db.modules = [{ id: 'old', nodeOnlyProtonShare: LINK }]
        await importRealmCompanionModules('c1', [LINK])
        expect(inspectProtonShare).not.toHaveBeenCalled()
        expect(db.characters[0].modules).toEqual(['old'])
    })

    test('no link or too many links changes nothing', async () => {
        await importRealmCompanionModules('c1', ['no links here'])
        const many = ['A1', 'A2', 'A3', 'A4'].map((id) => `https://drive.proton.me/urls/${id}#k`).join(' ')
        await importRealmCompanionModules('c1', [many])
        expect(inspectProtonShare).not.toHaveBeenCalled()
        expect(db.characters[0].modules).toEqual([])
        expect(notifySuccess).not.toHaveBeenCalled()
    })

    test('a file that is not plainly a module opens in the browser; closing it changes nothing', async () => {
        const share = { kind: 'file', name: 'Combatant Image Module.charx', entries: [{ size: 600 * 1024 * 1024 }], trail: [] }
        inspectProtonShare.mockResolvedValue(share)
        importProtonShare.mockResolvedValue(undefined)
        await importRealmCompanionModules('c1', [LINK])
        expect(importProtonShare).toHaveBeenCalledWith(LINK, '', share, 'module', expect.any(Function), { browse: true })
        expect(downloadProtonEntry).not.toHaveBeenCalled()
        expect(db.characters[0].modules).toEqual([])
        expect(notifySuccess).not.toHaveBeenCalled()
    })

    test('a file picked in the browser imports as a module and is paired', async () => {
        inspectProtonShare.mockResolvedValue({ kind: 'file', name: 'bot.charx', entries: [], trail: [] })
        importProtonShare.mockImplementation(async (_l: string, _p: string, _s: unknown, _o: string, onModule: (m: unknown) => void) => {
            const m = { id: 'm3', name: 'bot' }
            db.modules.push(m)
            onModule(m)
        })
        await importRealmCompanionModules('c1', [LINK])
        expect(db.characters[0].modules).toEqual(['m3'])
        expect(db.modules[0].nodeOnlyProtonShare).toBe(LINK)
    })

    test('a password-protected link asks for the password and downloads with it', async () => {
        inspectProtonShare.mockRejectedValue(Object.assign(new Error('This link needs the password its owner set'), { status: 401 }))
        openProtonShare.mockResolvedValue({ info: { kind: 'file', name: 'assets.risum', entries: [], trail: [] }, password: 'pw' })
        downloadProtonEntry.mockResolvedValue({ name: 'assets.risum', data: new Uint8Array([1]) })
        importModuleFile.mockImplementation(async () => { const m = { id: 'm2', name: 'assets' }; db.modules.push(m); return m })
        await importRealmCompanionModules('c1', [LINK])
        expect(openProtonShare).toHaveBeenCalledWith(LINK, '', expect.stringContaining(LINK))
        expect(downloadProtonEntry.mock.calls[0][1]).toBe('pw')
        expect(db.characters[0].modules).toEqual(['m2'])
    })

    test('cancelling the password prompt skips the link quietly', async () => {
        inspectProtonShare.mockRejectedValue(Object.assign(new Error('needs password'), { status: 401 }))
        openProtonShare.mockResolvedValue(null)
        await importRealmCompanionModules('c1', [LINK])
        expect(downloadProtonEntry).not.toHaveBeenCalled()
        expect(notifyError).not.toHaveBeenCalled()
        expect(db.characters[0].modules).toEqual([])
    })

    test('a failure is reported, not thrown', async () => {
        inspectProtonShare.mockRejectedValue(new Error('password required'))
        await expect(importRealmCompanionModules('c1', [LINK])).resolves.toBeUndefined()
        expect(notifyError).toHaveBeenCalledWith('failed: password required')
    })
})

describe('a folder share', () => {
    beforeEach(() => {
        db.modules = []
        db.characters = [{ chaId: 'c1', modules: [] }]
        vi.clearAllMocks()
    })

    test('opens the folder browser as a module import and pairs what it imports', async () => {
        const share = { kind: 'folder', name: 'pack', entries: [], trail: [] }
        inspectProtonShare.mockResolvedValue(share)
        importProtonShare.mockImplementation(async (_link: string, _pw: string, _share: unknown, origin: string, onModule: (m: unknown) => void) => {
            expect(origin).toBe('module')
            const m = { id: 'picked' }
            db.modules.push(m)
            onModule(m)
        })
        await importRealmCompanionModules('c1', [LINK])
        expect(importProtonShare).toHaveBeenCalledTimes(1)
        expect(importProtonShare.mock.calls[0][2]).toBe(share)
        expect(downloadProtonEntry).not.toHaveBeenCalled()
        expect(db.modules[0].nodeOnlyProtonShare).toBe(LINK)
        expect(db.characters[0].modules).toEqual(['picked'])
    })

    test('nothing picked pairs nothing', async () => {
        inspectProtonShare.mockResolvedValue({ kind: 'folder', name: 'pack', entries: [], trail: [] })
        importProtonShare.mockResolvedValue(undefined)
        await importRealmCompanionModules('c1', [LINK])
        expect(db.characters[0].modules).toEqual([])
        expect(notifySuccess).not.toHaveBeenCalled()
    })
})
