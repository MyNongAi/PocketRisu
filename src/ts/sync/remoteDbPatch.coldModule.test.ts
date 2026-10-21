import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

// The server stores a module (module-cold-store.cjs planCold) and publishes
// the ops; a page lands them with the real patcher.
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))
vi.mock('../storage/database.svelte', async () => {
    const { isChatStub } = await import('../storage/chatStub')
    return { isChatStub, createBotPresetTemplate: () => ({}), getDatabase: () => ({}) }
})

const require = createRequire(import.meta.url)
const coldStore = require('../../../server/node/module-cold-store.cjs')
const utils = require('../../../server/node/utils.cjs')
const { applyPatch } = require('fast-json-patch')

const { RisuSavePatcher, characterWithStubs, findDangerousChatOps, normalizeJSON } = await import('../storage/risuSave')
const { convertStubsToPlaceholders } = await import('../storage/chatStorage')
const { landRemoteDbPatch } = await import('./remoteDbPatch')

const lore = (tag: string) => Array.from({ length: 30 }, (_, i) => ({ key: `${tag}-${i}`, content: `${tag} ${i} `.repeat(30), mode: 'normal', insertorder: 100, alwaysActive: false }))

function serverDb() {
    return utils.normalizeJSON({
        username: 'me',
        enabledModules: ['on'],
        characters: [{ chaId: 'c1', name: 'Alice', chatPage: 0, modules: [], chats: [{ id: 'a1', name: 'Chat', lastDate: 1, _stub: true }] }],
        botPresets: [{ id: 'p1', name: 'Preset' }],
        modules: [
            { id: 'on', name: 'On', description: '', lorebook: lore('on') },
            { id: 'free', name: 'Free', description: '', folderId: 'f', lorebook: lore('free'), regex: [{ in: 'a', out: 'b' }], trigger: [] },
        ],
    })
}

async function serverEvent() {
    const kv = new Map<string, Buffer>()
    const store = coldStore.createModuleColdStore({
        kvGet: (k: string) => kv.get(k) ?? null,
        kvSet: (k: string, v: Buffer) => { kv.set(k, v) },
        kvDel: (k: string) => { kv.delete(k) },
        kvSize: (k: string) => kv.get(k)?.length ?? null,
        kvList: (p: string) => [...kv.keys()].filter((k) => k.startsWith(p)),
        encode: (v: unknown) => utils.encodeRisuSaveLegacyBuffer(v),
        decode: utils.decodeRisuSave,
        normalize: utils.normalizeJSON,
        hash: utils.calculateHash,
    })
    const before = serverDb()
    const { ops } = await store.planCold(before, ['on', 'free'])
    const after = applyPatch(structuredClone(before), ops, true, false).newDocument
    return {
        ops,
        prevHash: utils.calculateHash(before).toString(16),
        nextHash: utils.calculateHash(after).toString(16),
    }
}

describe('landing a stored module', () => {
    it('ends on the server hash with the body gone from the live module', async () => {
        const event = await serverEvent()
        expect(event.ops.length).toBeGreaterThan(0)
        const patcher = new RisuSavePatcher()
        await patcher.init(serverDb())
        expect(patcher.hash()).toBe(event.prevHash)

        const db: any = serverDb()
        for (const character of db.characters) character.chats = convertStubsToPlaceholders(character.chats)
        const liveFree = db.modules[1]
        let adopted: any = null
        const result = await landRemoteDbPatch({
            patcher,
            db,
            event,
            page: {
                selectedChaId: () => null,
                splitPaneChats: () => [],
                isChatBusy: () => false,
                isCharacterGenerating: () => false,
                suppressChatTracking: () => () => {},
                deselect: () => {},
                repointSelected: () => {},
                notifyDatabaseRebased: () => {},
                rehome: () => {},
            } as any,
            holds: new Map(),
            clone: (value) => structuredClone(value),
            normalize: normalizeJSON,
            characterWithStubs,
            findDangerousChatOps,
            toPlaceholders: convertStubsToPlaceholders,
            writeSection: async (run) => { const out = run(); out.release?.(); return out.result },
            commit: (next) => { adopted = next },
        })
        expect(result.status).toBe('applied')
        expect(adopted.hash()).toBe(event.nextHash)
        expect(db.modules[1]).toBe(liveFree)
        expect(liveFree.lorebook).toBeUndefined()
        expect(liveFree.nodeOnlyColdModule.lorebookCount).toBe(30)
        expect(db.modules[0].lorebook).toHaveLength(30)

        // The save right after sends nothing.
        const draft = adopted.fork()
        const { patch } = await draft.set(db, { character: [], chat: [], root: false, botPreset: false, modules: true, moduleIds: ['free'], plugins: false, pluginCustomStorage: false })
        expect(patch).toEqual([])
    })
})
