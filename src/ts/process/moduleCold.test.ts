import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { writable } from 'svelte/store'

const server = createRequire(import.meta.url)('../../../server/node/module-cold-store.cjs')

const db: any = { modules: [], characters: [], enabledModules: [] }
const readColdModuleBodies = vi.fn()
const refreshModules = vi.fn()
const rerenderChatForModules = vi.fn()
vi.mock('../stores.svelte', () => ({ DBState: { db }, selectedCharID: writable(-1) }))
vi.mock('../platform', () => ({ isNodeServer: true }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: { readColdModuleBodies } } }))
vi.mock('../characters', () => ({ updateLorebooks: (book: unknown[]) => book.map((entry: any) => ({ ...entry, normalized: true })) }))
vi.mock('./modules', () => ({ refreshModules, rerenderChatForModules }))

const cold = await import('./moduleCold.svelte')

const big = (tag: string) => [{ key: tag, content: tag.repeat(5000) }]
const marker = (archivedAt: number) => ({ archivedAt, bytes: 10 })

describe('stored modules', () => {
    beforeEach(() => {
        db.modules = []
        db.characters = []
        db.enabledModules = []
        db.moduleIntergration = ''
        db.botPresets = []
        readColdModuleBodies.mockReset()
        refreshModules.mockReset()
    })

    it('has the server\'s body fields and merge rule', () => {
        expect([...cold.COLD_BODY_FIELDS]).toEqual(server.COLD_BODY_FIELDS)
        const cases: [any, any][] = [
            [{ id: 'm', name: 'n', nodeOnlyColdModule: marker(1) }, { lorebook: [{ key: 'a' }], regex: [] }],
            [{ id: 'm', name: 'n', lorebook: [{ key: 'partial' }], nodeOnlyColdModule: marker(1) }, { lorebook: [{ key: 'row' }] }],
            [{ id: 'm', folderId: 'f', favorite: true, assetManifest: { id: 'd' }, nodeOnlyColdModule: marker(1) }, { cjs: 'x', backgroundEmbedding: '<b>' }],
        ]
        for (const [stub, body] of cases) expect(cold.mergeColdBody(stub, body)).toEqual(server.mergeColdBody(stub, body))
    })

    it('counts the same references as the server', () => {
        const source = {
            enabledModules: ['g', ''],
            moduleIntergration: ' ns1 ,ns2,',
            botPresets: [{ moduleIntergration: 'p1' }, null, {}],
            characters: [{ modules: ['c'], chats: [{ modules: ['chat'] }, null, {}] }, null],
        }
        expect([...cold.referencedModuleNames(source as any)].sort()).toEqual([...server.referencedModuleNames(source)].sort())
    })

    it('picks only whole modules nothing uses, worth storing, not kept', () => {
        db.enabledModules = ['on']
        db.characters = [{ modules: ['bot'], chats: [{ modules: ['chat'] }] }]
        db.botPresets = [{ moduleIntergration: 'presetNs' }]
        db.modules = [
            { id: 'free', name: 'free', lorebook: big('a') },
            { id: 'on', name: 'on', lorebook: big('b') },
            { id: 'bot', name: 'bot', lorebook: big('c') },
            { id: 'chat', name: 'chat', lorebook: big('d') },
            { id: 'ns', name: 'ns', namespace: 'presetNs', lorebook: big('e') },
            { id: 'tiny', name: 'tiny', lorebook: [{ key: 'k' }] },
            { id: 'mcp', name: 'mcp', mcp: { url: 'x' }, lorebook: big('f') },
            { id: 'stored', name: 'stored', nodeOnlyColdModule: marker(3) },
            { id: 'kept', name: 'kept', lorebook: big('g') },
            // The 🎨 module: its presets are read for every bot while it is off.
            { id: 'art', name: 'art', nodeOnlyIllustrationModule: true, lorebook: big('h') },
        ]
        expect(cold.coldCandidateIds(db, new Set(['kept']))).toEqual(['free'])
    })

    it('brings a stored module back in its slot, once for many asks', async () => {
        db.modules = [
            { id: 'a', name: 'A', folderId: 'f', nodeOnlyColdModule: marker(7) },
            { id: 'b', name: 'B', lorebook: [] },
        ]
        readColdModuleBodies.mockImplementation(async (refs: any[]) => refs.map((r) => ({ ...r, body: { lorebook: [{ key: 'k' }], regex: [{ in: 'x' }] } })))
        const [first, second] = await Promise.all([cold.wakeModules(['a', 'b']), cold.wakeModules(['a'])])
        expect(first && second).toBe(true)
        expect(readColdModuleBodies).toHaveBeenCalledTimes(1)
        expect(readColdModuleBodies.mock.calls[0][0]).toEqual([{ id: 'a', archivedAt: 7 }])
        expect(db.modules[0]).toEqual({ id: 'a', name: 'A', folderId: 'f', lorebook: [{ key: 'k', normalized: true }], regex: [{ in: 'x' }] })
        expect(refreshModules).toHaveBeenCalledTimes(1)
    })

    it('leaves a module whose row is gone as it is', async () => {
        db.modules = [{ id: 'a', name: 'A', nodeOnlyColdModule: marker(7) }]
        readColdModuleBodies.mockImplementation(async (refs: any[]) => refs.map((r) => ({ ...r, missing: true })))
        expect(await cold.wakeModules(['a'])).toBe(false)
        expect(db.modules[0].nodeOnlyColdModule).toEqual(marker(7))
        await expect(cold.wholeModule(db.modules[0])).rejects.toThrow('Stored module data missing')
    })

    it('shows a stored module whole without touching the database', async () => {
        const stub = { id: 'a', name: 'A', nodeOnlyColdModule: marker(7) }
        db.modules = [stub]
        readColdModuleBodies.mockImplementation(async (refs: any[]) => refs.map((r) => ({ ...r, body: { trigger: [] } })))
        expect(await cold.wholeModule(stub as any)).toEqual({ id: 'a', name: 'A', trigger: [] })
        expect(db.modules[0]).toBe(stub)
    })
})
