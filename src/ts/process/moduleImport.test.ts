import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    db: { modules: [] as any[], moduleFolders: [] as any[], nodeOnlyAutoAllowLowLevelImport: true },
    alertConfirm: vi.fn(),
    notifySuccess: vi.fn(),
    askProtonLink: vi.fn(),
    selectMultipleFile: vi.fn(),
    importCharacterProcess: vi.fn(),
    downloadRisuHubAsModule: vi.fn(),
    convertCharacterToModule: vi.fn(),
    readModule: vi.fn(),
    hydrateModuleAssets: vi.fn(),
    planLargeCharxImport: vi.fn(),
    checkCharOrder: vi.fn(),
    importFromProtonLink: vi.fn(),
    runImportTransaction: vi.fn(),
    scope: { id: 'scope', check: vi.fn(), track: vi.fn(), registerOwner: vi.fn() },
}))

vi.mock('src/lang', () => ({ language: {
    errors: { noData: 'no data' }, successImport: 'imported', lowLevelAccessConfirm: 'allow access?',
    moduleLayoutImported: '{{modules}} modules, {{folders}} moved, {{created}} created, {{skipped}} skipped',
    importProgress: { queued: 'queued', importing: 'importing', done: 'done', failed: 'failed', cancelled: 'cancelled' },
} }))
vi.mock('../alert', () => ({ alertConfirm: mocks.alertConfirm, notifySuccess: mocks.notifySuccess }))
vi.mock('../protonLinkPrompt.svelte', () => ({ askProtonLink: mocks.askProtonLink }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => mocks.db }))
vi.mock('../globalApi.svelte', () => ({ checkCharOrder: mocks.checkCharOrder }))
vi.mock('../util', () => ({ selectMultipleFile: mocks.selectMultipleFile }))
vi.mock('../platform', () => ({ isNodeServer: true }))
vi.mock('../characterCards', () => ({
    importCharacterProcess: mocks.importCharacterProcess, downloadRisuHubAsModule: mocks.downloadRisuHubAsModule,
}))
vi.mock('../interchangeability', () => ({ convertCharacterToModule: mocks.convertCharacterToModule }))
vi.mock('./lorebook.svelte', () => ({ convertExternalLorebook: (entries: unknown) => entries }))
vi.mock('./modules', () => ({
    addModuleToDatabase: (module: unknown) => mocks.db.modules.push(module),
    readModule: mocks.readModule, hydrateModuleAssets: mocks.hydrateModuleAssets,
}))
vi.mock('../largeCharxImport', () => ({ planLargeCharxImport: mocks.planLargeCharxImport }))
vi.mock('../protonImport', () => ({ importFromProtonLink: mocks.importFromProtonLink }))
vi.mock('../importTransaction', async (importOriginal) => ({
    ...await importOriginal<typeof import('../importTransaction')>(),
    runImportTransaction: mocks.runImportTransaction,
}))

import { importModuleFile, importModuleFiles, importModuleFromProtonDrive, importModuleLink } from './moduleImport'
import { importTasks, type ImportProgressReporter } from '../importProgress'
import { ImportCancelledError, type ImportWriteScope } from '../importTransaction'

const jsonFile = (data: unknown) => ({ name: 'module.json', data: Buffer.from(JSON.stringify(data)) })
const moduleData = () => ({ type: 'risuModule', name: 'World', description: '', id: 'source', mcp: { url: 'source' } })

beforeEach(() => {
    vi.resetAllMocks()
    mocks.db.modules = []
    mocks.db.moduleFolders = []
    mocks.db.nodeOnlyAutoAllowLowLevelImport = true
    importTasks.set(new Map())
    mocks.planLargeCharxImport.mockResolvedValue({ kind: 'normal' })
    mocks.alertConfirm.mockResolvedValue(true)
    mocks.runImportTransaction.mockImplementation((_report: ImportProgressReporter, run: (scope: ImportWriteScope) => unknown) => run(mocks.scope))
})

describe('module file imports', () => {
    it('copies JSON modules with a new identity and registers them in the cancellable scope', async () => {
        const report = vi.fn()
        const module = await importModuleFile(jsonFile(moduleData()), { onProgress: report, importScope: mocks.scope, suppressSuccess: true })
        expect(module).toMatchObject({ name: 'World', id: expect.any(String) })
        expect(module?.id).not.toBe('source')
        expect(module).not.toHaveProperty('mcp')
        expect(mocks.db.modules).toEqual([module])
        expect(mocks.scope.registerOwner).toHaveBeenCalledWith('module', module?.id)
        expect(report).toHaveBeenCalledWith(expect.objectContaining({ progress: 90 }))
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
    })

    it('streams CHARX files and forwards progress and the write scope to the card importer', async () => {
        const file = { name: 'World.CHARX', data: new File(['archive'], 'World.CHARX') }
        const report = vi.fn()
        const character = { name: 'World' }
        const module = { name: 'World', id: 'converted' }
        mocks.importCharacterProcess.mockResolvedValue(character)
        mocks.convertCharacterToModule.mockReturnValue(module)
        expect(await importModuleFile(file, { onProgress: report, importScope: mocks.scope })).toBe(module)
        expect(mocks.importCharacterProcess).toHaveBeenCalledWith({ ...file, returnCharacter: true, onProgress: report, suppressSuccess: true, importScope: mocks.scope })
        expect(mocks.convertCharacterToModule).toHaveBeenCalledWith(character)
        expect(mocks.db.modules).toEqual([module])
    })

    it('reads RISUM files with the caller progress and write scope', async () => {
        const bytes = Uint8Array.of(111, 0)
        const report = vi.fn()
        const module = { name: 'World', id: 'risum' }
        mocks.readModule.mockResolvedValue(module)
        expect(await importModuleFile({ name: 'world.RISUM', data: bytes }, { onProgress: report, importScope: mocks.scope })).toBe(module)
        expect(mocks.readModule).toHaveBeenCalledWith(Buffer.from(bytes), { onProgress: report, importScope: mocks.scope })
        expect(mocks.db.modules).toEqual([module])
    })

    it('hydrates a copied lazy asset manifest without retaining its descriptor', async () => {
        const assets = [['asset', 'assets/copy', 'png']]
        mocks.hydrateModuleAssets.mockResolvedValue({ assets })
        const module = await importModuleFile(jsonFile({ ...moduleData(), assetManifest: { id: 'source' } }))
        expect(module?.assets).toEqual(assets)
        expect(module).not.toHaveProperty('assetManifest')
    })

    it('honors the low-level import preference and a declined confirmation', async () => {
        const file = jsonFile({ ...moduleData(), lowLevelAccess: true })
        await importModuleFile(file)
        expect(mocks.alertConfirm).not.toHaveBeenCalled()
        mocks.db.modules = []
        mocks.db.nodeOnlyAutoAllowLowLevelImport = false
        mocks.alertConfirm.mockResolvedValue(false)
        expect(await importModuleFile(file)).toBeUndefined()
        expect(mocks.alertConfirm).toHaveBeenCalledWith('allow access?', { stayOpen: true })
        expect(mocks.db.modules).toEqual([])
    })

    it('does not insert a module after the write scope is cancelled', async () => {
        mocks.scope.check.mockImplementation(() => { throw new ImportCancelledError() })
        await expect(importModuleFile(jsonFile(moduleData()), { importScope: mocks.scope })).rejects.toBeInstanceOf(ImportCancelledError)
        expect(mocks.db.modules).toEqual([])
        expect(mocks.scope.registerOwner).not.toHaveBeenCalled()
    })

    it('applies module folder layouts without adding a module', async () => {
        mocks.db.modules = [{ id: 'existing', name: 'World' }]
        const { MODULE_LAYOUT_TYPE } = await import('./moduleLayoutImport')
        expect(await importModuleFile(jsonFile({ type: MODULE_LAYOUT_TYPE, ver: 1, moves: [{ module: 'existing', to: ['Worlds'] }] }))).toBeUndefined()
        expect(mocks.db.modules).toHaveLength(1)
        expect(mocks.db.moduleFolders).toEqual([expect.objectContaining({ name: 'Worlds', moduleIds: ['existing'] })])
        expect(mocks.db.modules[0].folderId).toBe(mocks.db.moduleFolders[0].id)
    })

    it('runs a guarded CHARX import once in a cancellable progress task', async () => {
        mocks.planLargeCharxImport.mockResolvedValue({ kind: 'guarded', destination: 'module' })
        mocks.importCharacterProcess.mockResolvedValue({ name: 'World' })
        mocks.convertCharacterToModule.mockReturnValue({ name: 'World', id: 'large' })
        await importModuleFile({ name: 'large.charx', data: new Uint8Array() })
        expect(mocks.planLargeCharxImport).toHaveBeenCalledTimes(1)
        expect(mocks.runImportTransaction).toHaveBeenCalledTimes(1)
        expect(mocks.importCharacterProcess).toHaveBeenCalledWith(expect.objectContaining({ importScope: mocks.scope }))
        expect([...get(importTasks).values()]).toEqual([expect.objectContaining({ fileName: 'large.charx', phase: 'done' })])
    })
})

describe('module page entry points', () => {
    it('keeps one progress card per file and continues after an invalid file', async () => {
        mocks.selectMultipleFile.mockResolvedValue([jsonFile(moduleData()), { name: 'bad.json', data: Buffer.from('{') }])
        expect(await importModuleFiles()).toEqual({ completed: 1, failed: 1, total: 2 })
        expect(mocks.db.modules).toHaveLength(1)
        expect([...get(importTasks).values()].map(task => [task.fileName, task.phase])).toEqual([['module.json', 'done'], ['bad.json', 'failed']])
        expect(mocks.notifySuccess).toHaveBeenCalledExactlyOnceWith('1/2 imported')
    })

    it('does nothing when the batch picker is cancelled', async () => {
        mocks.selectMultipleFile.mockResolvedValue(null)
        expect(await importModuleFiles()).toBeUndefined()
        expect(get(importTasks).size).toBe(0)
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
    })

    it('imports Realm links as modules and sends Proton links to module routing', async () => {
        const id = '11111111-2222-4333-8444-555555555555'
        expect(await importModuleLink(`https://realm.risuai.net/character/${id}`)).toBe(true)
        expect(mocks.downloadRisuHubAsModule).toHaveBeenCalledWith(id)
        expect(mocks.importFromProtonLink).not.toHaveBeenCalled()
        const link = 'https://drive.proton.me/urls/ABC123#key'
        mocks.importFromProtonLink.mockResolvedValue(true)
        expect(await importModuleLink(link)).toBe(true)
        expect(mocks.importFromProtonLink).toHaveBeenCalledWith(link, '', 'module')
    })

    it('does nothing when the Proton link popup is cancelled', async () => {
        mocks.askProtonLink.mockResolvedValue(null)
        await importModuleFromProtonDrive()
        expect(mocks.askProtonLink).toHaveBeenCalledWith('module')
        expect(mocks.importFromProtonLink).not.toHaveBeenCalled()
        expect(mocks.selectMultipleFile).not.toHaveBeenCalled()
    })

    it('falls back to the Proton browser and batch picker when direct import is unavailable', async () => {
        const link = 'https://drive.proton.me/urls/ABC123#key'
        const open = vi.spyOn(window, 'open').mockReturnValue(null)
        mocks.askProtonLink.mockResolvedValue(link)
        mocks.importFromProtonLink.mockResolvedValue(false)
        mocks.selectMultipleFile.mockResolvedValue([jsonFile(moduleData())])
        try {
            await importModuleFromProtonDrive()
            expect(open).toHaveBeenCalledWith(link, '_blank')
            expect(mocks.db.modules).toHaveLength(1)
            expect(mocks.notifySuccess).toHaveBeenCalledExactlyOnceWith('1/1 imported')
        } finally {
            open.mockRestore()
        }
    })
})
