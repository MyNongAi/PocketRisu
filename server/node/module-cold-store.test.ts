import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
    COLD_MARKER, coldRefusal, createModuleColdStore, findDanglingColdModules, mergeColdBody,
    moduleBodyOf, referencedModuleNames,
} = require('./module-cold-store.cjs')

describe('module-cold-store', () => {
    it('puts the row body back under the stub\'s own catalog fields', () => {
        const stub = { id: 'm', name: 'New name', folderId: 'f', lorebook: [{ key: 'partial' }], [COLD_MARKER]: { archivedAt: 5, bytes: 1 } }
        const merged = mergeColdBody(stub, { lorebook: [{ key: 'a' }, { key: 'b' }], regex: [] })
        expect(merged).toEqual({ id: 'm', name: 'New name', folderId: 'f', lorebook: [{ key: 'a' }, { key: 'b' }], regex: [] })
    })

    it('takes only the body fields out', () => {
        expect(moduleBodyOf({ id: 'm', name: 'n', lorebook: [], cjs: 'x', hideIcon: true, assetManifest: { id: 'd' } }))
            .toEqual({ lorebook: [], cjs: 'x' })
    })

    it('counts what can turn a module on, by id or namespace', () => {
        const names = referencedModuleNames({
            enabledModules: ['g'],
            moduleIntergration: 'ns1, ns2',
            botPresets: [{ moduleIntergration: 'p1' }, null],
            characters: [{ modules: ['c'], chats: [{ modules: ['chat'] }, { _stub: true }] }],
        })
        expect([...names].sort()).toEqual(['c', 'chat', 'g', 'ns1', 'ns2', 'p1'])
        const big = 10_000
        expect(coldRefusal({ id: 'x', namespace: 'p1' }, names, big)).toBe('MODULE_IN_USE')
        expect(coldRefusal({ id: 'x' }, names, big)).toBeNull()
        expect(coldRefusal({ id: 'x' }, names, 10)).toBe('MODULE_TOO_SMALL')
        expect(coldRefusal({ id: '$embedded' }, names, big)).toBe('MODULE_BAD_ID')
    })

    it('flags a new marker whose row is missing, not one already there', () => {
        const marked = (id: string, archivedAt: number) => ({ id, [COLD_MARKER]: { archivedAt, bytes: 1 } })
        const prev = { modules: [marked('a', 1), { id: 'b' }] }
        const next = { modules: [marked('a', 1), marked('b', 2), marked('c', 3)] }
        expect(findDanglingColdModules(prev, next, (id: string) => id === 'c')).toEqual(['b@2'])
    })

    it('fails an export whose row is gone', async () => {
        const kv = new Map<string, Buffer>()
        const store = createModuleColdStore({
            kvGet: (k: string) => kv.get(k) ?? null,
            kvSet: (k: string, v: Buffer) => { kv.set(k, v) },
            kvDel: (k: string) => { kv.delete(k) },
            kvSize: (k: string) => kv.get(k)?.length ?? null,
            kvList: (p: string) => [...kv.keys()].filter((k) => k.startsWith(p)),
            encode: (v: unknown) => Buffer.from(JSON.stringify(v)),
            decode: async (b: Buffer) => JSON.parse(b.toString()),
            normalize: (v: unknown) => JSON.parse(JSON.stringify(v)),
            hash: (v: unknown) => JSON.stringify(v),
            now: () => 100,
        })
        const marker = await store.writeRow({ id: 'm', name: 'M', lorebook: [{ key: 'k' }] })
        expect(marker).toMatchObject({ archivedAt: 100, lorebookCount: 1 })
        const db = { modules: [{ id: 'm', name: 'M', [COLD_MARKER]: marker }, { id: 'gone', name: 'Gone', [COLD_MARKER]: { archivedAt: 7, bytes: 1 } }] }
        await expect(store.inlineColdModules(db)).rejects.toMatchObject({ code: 'COLD_MODULE_MISSING' })
        expect(db.modules[0]).toEqual({ id: 'm', name: 'M', lorebook: [{ key: 'k' }] })
        expect(store.listOrphanRows({ modules: [] }, 0).rows.map((r: any) => r.key)).toEqual(['module-cold/m/100'])
    })
})
