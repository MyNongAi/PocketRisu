import { beforeEach, describe, expect, test, vi } from 'vitest'

const db = { modules: [] as any[], characters: [] as any[] }
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => db }))
vi.mock('src/lang', () => ({
    language: {
        realmCompanionModuleTask: 'task',
        realmCompanionModulePaired: (n: number) => `paired ${n}`,
        realmCompanionModuleFailed: 'failed',
        botNotesModuleTask: 'notes',
        botNotesModuleFailed: 'notes failed',
        botNotesModulePaired: (n: number) => `notes paired ${n}`,
        realmModuleLinkN: (n: number) => `link ${n}`,
        realmModulePickLink: 'which link',
        realmModuleImported: (n: number) => `imported ${n}`,
        cancel: 'cancel',
        importProgress: { importing: 'importing' },
    },
}))
const notifySuccess = vi.fn()
const notifyError = vi.fn()
const alertSelect = vi.fn()
vi.mock('./alert', () => ({
    notifySuccess: (m: string) => notifySuccess(m),
    notifyError: (m: string) => notifyError(m),
    alertSelect: (...a: unknown[]) => alertSelect(...a),
}))
const taskNames: string[] = []
vi.mock('./importProgress', () => ({ runImportTask: (name: string, fn: (report: () => void) => unknown) => { taskNames.push(name); return fn(() => {}) } }))
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
    openBotNotesProtonLink, protonShareLinkOf, protonLinkChoices, importRealmDescriptionModules,
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
        taskNames.length = 0
        await importRealmCompanionModules('c1', [`desc ${LINK}`, undefined])
        // One card, the file's (the user's request, 2026-10-22: no idle outer card beside it).
        expect(taskNames).toEqual(['task · assets.risum'])
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
        expect(importProtonShare).toHaveBeenCalledWith(LINK, '', share, 'module', expect.any(Function), { browse: true, taskName: expect.any(Function) })
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
        taskNames.length = 0
        await importRealmCompanionModules('c1', [LINK])
        expect(importProtonShare).toHaveBeenCalledTimes(1)
        expect(importProtonShare.mock.calls[0][2]).toBe(share)
        // The browser's own per-file cards only, named for the Realm module.
        expect(taskNames).toEqual([])
        expect(importProtonShare.mock.calls[0][5].taskName('a.risum')).toBe('task · a.risum')
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

describe('a Proton link clicked in the creator notes', () => {
    beforeEach(() => {
        db.modules = []
        db.characters = [{ chaId: 'c1', modules: [] }]
        vi.clearAllMocks()
    })

    test('opens the browser even for a plain module file and pairs what is imported', async () => {
        const share = { kind: 'file', name: 'assets.risum', entries: [{ size: 10 }], trail: [] }
        inspectProtonShare.mockResolvedValue(share)
        importProtonShare.mockImplementation(async (_l: string, _p: string, _s: unknown, origin: string, onModule: (m: unknown) => void) => {
            expect(origin).toBe('module')
            const m = { id: 'n1' }
            db.modules.push(m)
            onModule(m)
        })
        await openBotNotesProtonLink('c1', LINK)
        expect(importProtonShare).toHaveBeenCalledTimes(1)
        expect(importProtonShare.mock.calls[0][5].browse).toBe(true)
        expect(importProtonShare.mock.calls[0][5].taskName('assets.risum')).toBe('notes · assets.risum')
        expect(downloadProtonEntry).not.toHaveBeenCalled()
        expect(db.characters[0].modules).toEqual(['n1'])
        expect(db.modules[0].nodeOnlyProtonShare).toBe(LINK)
        expect(notifySuccess).toHaveBeenCalledWith('notes paired 1')
    })

    test('closing the browser pairs nothing; a failure is reported, not thrown', async () => {
        inspectProtonShare.mockResolvedValue({ kind: 'folder', name: 'pack', entries: [], trail: [] })
        importProtonShare.mockResolvedValue(undefined)
        await openBotNotesProtonLink('c1', LINK)
        expect(db.characters[0].modules).toEqual([])
        expect(notifySuccess).not.toHaveBeenCalled()

        inspectProtonShare.mockRejectedValue(new Error('offline'))
        await expect(openBotNotesProtonLink('c1', LINK)).resolves.toBeUndefined()
        expect(notifyError).toHaveBeenCalledWith('notes failed: offline')
    })

    test('reads the share an anchor points at', () => {
        const anchor = (href: string | null) => ({ getAttribute: (name: string) => (name === 'href' ? href : null) }) as unknown as Element
        expect(protonShareLinkOf(anchor(LINK))).toBe(LINK)
        expect(protonShareLinkOf(anchor('https://example.com/x'))).toBeNull()
        expect(protonShareLinkOf(anchor(null))).toBeNull()
        expect(protonShareLinkOf(null)).toBeNull()
    })
})

const share = (id: string) => `https://drive.proton.me/urls/${id}#k${id}`

describe('the Realm window module button', () => {
    beforeEach(() => {
        db.modules = []
        db.characters = [{ chaId: 'c1', modules: [] }]
        vi.clearAllMocks()
        inspectProtonShare.mockResolvedValue({ kind: 'folder', name: 'pack', entries: [], trail: [] })
        importProtonShare.mockImplementation(async (_l: string, _p: string, _s: unknown, _o: string, onModule: (m: unknown) => void) => {
            const m = { id: `m${db.modules.length + 1}` }
            db.modules.push(m)
            onModule(m)
        })
    })

    test('names each link by the words on its line, every link counted', () => {
        const text = [
            '# 다운로드',
            `에셋 모듈: ${share('A1')}`,
            `[이미지팩](${share('B2')})`,
            share('C3'),
            `**배경 모듈** → ${share('D4')}`,
            `같은 줄 ${share('E5')} ${share('F6')}`,
        ].join('\n')
        expect(protonLinkChoices(text)).toEqual([
            { link: share('A1'), label: '에셋 모듈' },
            { link: share('B2'), label: '이미지팩' },
            { link: share('C3'), label: 'link 3' },
            { link: share('D4'), label: '배경 모듈' },
            { link: share('E5'), label: '같은 줄' },
            { link: share('F6'), label: '같은 줄 (2)' },
        ])
    })

    test('a link alone on its line takes the words on the line above it', () => {
        const text = ['추가 에셋 모듈:', share('A1'), '', 'BGM 플러그인:', '', share('B2')].join('\n')
        expect(protonLinkChoices(text).map((choice) => choice.label)).toEqual(['추가 에셋 모듈', 'BGM 플러그인'])
    })

    test('one link opens the browser at once and pairs with the bots downloaded from this card', async () => {
        await importRealmDescriptionModules(`모듈 ${share('A1')}`, () => db.characters)
        expect(alertSelect).not.toHaveBeenCalled()
        expect(importProtonShare.mock.calls[0][0]).toBe(share('A1'))
        expect(importProtonShare.mock.calls[0][5].browse).toBe(true)
        expect(db.characters[0].modules).toEqual(['m1'])
        expect(notifySuccess).toHaveBeenCalledWith('notes paired 1')
    })

    test('with several links the picked one opens; cancel opens none', async () => {
        const text = `a ${share('A1')}\nb ${share('B2')}`
        alertSelect.mockResolvedValueOnce('1')
        await importRealmDescriptionModules(text, () => db.characters)
        expect(alertSelect.mock.calls[0][0]).toEqual(['a', 'b', 'cancel'])
        expect(importProtonShare.mock.calls[0][0]).toBe(share('B2'))

        importProtonShare.mockClear()
        alertSelect.mockResolvedValueOnce('2')
        await importRealmDescriptionModules(text, () => db.characters)
        expect(importProtonShare).not.toHaveBeenCalled()
    })

    test('without a downloaded bot the modules just come in; no link does nothing', async () => {
        await importRealmDescriptionModules(share('A1'), () => [])
        expect(notifySuccess).toHaveBeenCalledWith('imported 1')

        vi.clearAllMocks()
        await importRealmDescriptionModules('no links here', () => db.characters)
        expect(inspectProtonShare).not.toHaveBeenCalled()
        expect(notifySuccess).not.toHaveBeenCalled()
    })
})
