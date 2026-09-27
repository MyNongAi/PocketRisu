import { describe, expect, test, vi } from 'vitest'

// Real patcher, decoder and stub helpers; only the heavy app modules are mocked.
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))
vi.mock('./database.svelte', async () => {
    const { isChatStub } = await import('./chatStub')
    return { isChatStub, createBotPresetTemplate: () => ({}), getDatabase: () => ({}) }
})

const {
    RisuSavePatcher, PatchBaselineSnapshot, calculateHash, decodeRisuSave, encodeRisuSaveLegacy,
    findDangerousChatOps, normalizeJSON,
} = await import('./risuSave')
const { convertStubsToPlaceholders } = await import('./chatStorage')

const NOTHING_TRACKED = {
    character: [] as string[], chat: [] as [string, string][], root: false, botPreset: false,
    modules: false, moduleIds: [] as string[], plugins: false, pluginCustomStorage: false,
}

/**
 * What /api/read serves on a large install, in miniature: chats are stubs
 * (explicit null folderId, per-chat modules), asset lists are manifest
 * descriptors, plugin values live in the server kv, and the values cover
 * what the hash and normalizeJSON care about (Korean text, emoji, floats,
 * nulls, empty containers, integer-like keys).
 */
function serverView() {
    const characters = Array.from({ length: 24 }, (_, i) => ({
        chaId: `cha-${i}`,
        name: `캐릭터 ${i} 🌙`,
        type: 'character',
        desc: '긴 한국어 설명 문장입니다. '.repeat(40 + i),
        firstMessage: i % 3 === 0 ? '' : `첫 메시지 ${i}`,
        chatPage: i % 2,
        chats: i === 5 ? [] : Array.from({ length: 1 + (i % 4) }, (_, j) => {
            const stub: Record<string, unknown> = { id: `chat-${i}-${j}`, name: `대화 ${j}`, _stub: true }
            if (j % 2 === 0) stub.lastDate = 1_700_000_000_000 + i * 1000 + j
            if (j === 1) stub.folderId = null
            if (j === 2) stub.folderId = `folder-${i}`
            if (j === 3) stub.modules = [`mod-${i % 5}`]
            return stub
        }),
        chatFolders: i % 4 === 2 ? [{ id: `folder-${i}`, name: '폴더', color: '' }] : [],
        globalLore: [{ key: '키워드', content: '로어 내용 '.repeat(30), insertorder: 100, alwaysActive: false, secondkey: '', selective: false, bookVersion: 2 }],
        emotionImages: [['happy', `assets/${i}.png`]],
        ...(i % 6 === 1 ? { additionalAssetManifest: { id: `m${i}`, version: 1, count: 3, sha256: 'ab'.repeat(32), ownerKind: 'character', ownerId: `cha-${i}` } } : {}),
        sdData: [['always', 'solo'], ['negative', '']],
        utilityBot: false,
        viewScreen: 'none',
        bias: [],
        creator: '',
        temperatureOverride: i === 7 ? 1e-7 : 0.65,
        scriptstate: { '0': 'zero', '10': 'ten', '2': 'two', note: null },
    }))
    return {
        formatversion: 5,
        apiType: 'gemini-3-flash-preview',
        hypaCustomSettings: { url: '', key: '', model: '' },
        username: '사용자',
        personaPrompt: '페르소나 '.repeat(50),
        temperature: 80,
        top_p: 0.95,
        characters,
        characterOrder: ['cha-0', { id: 'f1', name: '폴더', data: ['cha-1', 'cha-2'], color: '', folder: true }, 'cha-3'],
        botPresets: [{ id: 'p1', name: '프리셋', mainPrompt: '시스템 프롬프트 '.repeat(80), temperature: 1 }],
        modules: [
            { id: 'mod-0', name: '모듈', lorebook: [{ key: 'k', content: '모듈 로어 '.repeat(60), bookVersion: 2 }], assetManifest: { id: 'x', version: 1, count: 2, sha256: 'cd'.repeat(32), ownerKind: 'module', ownerId: 'mod-0' } },
            { id: 'mod-1', name: 'empty', lorebook: [] },
        ],
        personas: [{ id: 'per-1', name: '나', personaPrompt: '설명', icon: '', note: '', largePortrait: false }],
        plugins: [{ name: 'p', script: 'console.log(1)', enabled: true, version: '3.0', arguments: {}, realArg: {} }],
        pluginCustomStorage: {},
        nodeOnlyArchivedCharacters: [{ chaId: 'gone-1', name: '보관', chatIds: ['x1'] }],
        globalChatVariables: {},
        hotkeys: [],
        emptyNested: { a: [], b: {}, c: [[]] },
    }
}

/** The server's cached view: normalizeJSON'd, and the hash /api/patch expects. */
const serverHash = () => calculateHash(normalizeJSON(serverView())).toString(16)

/**
 * Everything loadData and its callees do to the decoded object before
 * saveDb's patcher.init: setDatabase defaults, checkNewFormat's per-character
 * defaults and whole-array reassignments, and convertStubsToPlaceholders.
 * The view above was saved by this client before, so the defaults are
 * already there and only rebuild objects with equal values.
 */
function mutateLikeBoot(db: any) {
    db.apiType ??= 'gemini-3-flash-preview'
    db.hypaCustomSettings = { url: '', key: '', model: '' }
    db.characters = db.characters.map((c: any) => {
        c.viewScreen ??= 'none'
        c.bias ??= []
        c.creator ??= ''
        return c
    })
    db.modules = db.modules.map((m: any) => ({ ...m, lorebook: m.lorebook.map((entry: any) => entry) }))
    for (const c of db.characters) c.chats = convertStubsToPlaceholders(c.chats)
}

/** A user edit made after boot, then tracked for the first save. */
function firstEdit(db: any) {
    db.characters[2].desc = '방금 고친 설명'
    db.characters[2].chats[0].name = '이름 바꾼 대화'
    db.personaPrompt = '새 페르소나'
    return { ...NOTHING_TRACKED, character: ['cha-2'], root: true }
}

async function boot(bytes: Uint8Array, seed: (decoded: any) => any) {
    const decoded = await decodeRisuSave(bytes)
    const baseline = seed(decoded)
    mutateLikeBoot(decoded)
    const patcher = new RisuSavePatcher()
    await patcher.init(baseline)
    return { patcher, db: decoded }
}

// Before: setPatchSyncBaseline kept safeStructuredClone(decoded).
const bootWithClone = (bytes: Uint8Array) => boot(bytes, (decoded) => structuredClone(decoded))
// Now: a normalizeJSON snapshot that patcher.init adopts.
const bootWithSnapshot = (bytes: Uint8Array) => boot(bytes, (decoded) => new PatchBaselineSnapshot(decoded))

// The first patch after boot must be accepted by the server: its expectedHash
// is the hash of the server's view. Pinned so a change to how the baseline is
// seeded cannot move it silently.
const PINNED_SERVER_HASH = 'c774720f'

describe('PatchBaselineSnapshot seeds the same patch baseline as a structuredClone', () => {
    test('the fixture hash is pinned', () => {
        expect(serverHash()).toBe(PINNED_SERVER_HASH)
    })

    test('baseline, hashes and size estimate match the clone path and the server', async () => {
        const bytes = encodeRisuSaveLegacy(serverView())
        const before = await bootWithClone(bytes)
        const after = await bootWithSnapshot(bytes)

        expect(after.patcher.hash()).toBe(before.patcher.hash())
        expect(after.patcher.hash()).toBe(PINNED_SERVER_HASH)
        expect(JSON.stringify(after.patcher.baselineDb())).toBe(JSON.stringify(before.patcher.baselineDb()))
        expect(after.patcher.baselineDb()).toStrictEqual(before.patcher.baselineDb())
        expect(after.patcher.estimatePayloadBytes()).toBe(before.patcher.estimatePayloadBytes())

        // Every per-key and per-character hash equals the server's.
        const view = normalizeJSON(serverView())
        const remote = {
            serverHash: PINNED_SERVER_HASH,
            keyHashes: Object.fromEntries(Object.keys(view).map((key) => [key, calculateHash(view[key]).toString(16)])),
            characterHashes: Object.fromEntries(view.characters.map((c: any) => [c.chaId, calculateHash(c).toString(16)])),
        }
        const report = after.patcher.describeHashMismatch(remote)
        expect(report).toStrictEqual(before.patcher.describeHashMismatch(remote))
        expect(report.compositionOnly).toBe(true)
        expect(report.roots.mismatched).toStrictEqual([])
        expect(report.characters.mismatched).toStrictEqual([])
    })

    test('the first save after boot sends the same patch with the server hash', async () => {
        const bytes = encodeRisuSaveLegacy(serverView())
        const before = await bootWithClone(bytes)
        const after = await bootWithSnapshot(bytes)

        const expected = await before.patcher.set(before.db, firstEdit(before.db))
        const actual = await after.patcher.set(after.db, firstEdit(after.db))

        expect(actual).toStrictEqual(expected)
        expect(actual.expectedHash).toBe(PINNED_SERVER_HASH)
        expect(actual.patch.length).toBeGreaterThan(0)
        // Only the edited character and root key; placeholders diff as the
        // stubs they came from, so no chat-internal ops.
        expect(new Set(actual.patch.map((op: any) => op.path.split('/').slice(0, 3).join('/'))))
            .toStrictEqual(new Set(['/characters/2', '/personaPrompt']))
        expect(findDangerousChatOps(actual.patch)).toStrictEqual([])
        expect(after.patcher.hash()).toBe(before.patcher.hash())
    })

    test('an untouched boot saves nothing and keeps the server hash', async () => {
        const bytes = encodeRisuSaveLegacy(serverView())
        const after = await bootWithSnapshot(bytes)
        const result = await after.patcher.set(after.db, NOTHING_TRACKED)
        expect(result.expectedHash).toBe(PINNED_SERVER_HASH)
        expect(result.patch).toStrictEqual([])
    })
})

describe('PatchBaselineSnapshot ownership', () => {
    test('shares no object or array with the source, so boot mutations cannot reach it', async () => {
        const decoded = await decodeRisuSave(encodeRisuSaveLegacy(serverView()))
        const sourceObjects = new WeakSet<object>()
        const collect = (v: any) => {
            if (!v || typeof v !== 'object') return
            sourceObjects.add(v)
            for (const key of Object.keys(v)) collect(v[key])
        }
        collect(decoded)
        const snapshot = new PatchBaselineSnapshot(decoded)
        const copy = snapshot.take()
        let objects = 0
        const walk = (v: any) => {
            if (!v || typeof v !== 'object') return
            objects++
            expect(sourceObjects.has(v)).toBe(false)
            for (const key of Object.keys(v)) walk(v[key])
        }
        walk(copy)
        expect(objects).toBeGreaterThan(100)
    })

    test('is adopted once; a second init cannot share the mutated copy', async () => {
        const snapshot = new PatchBaselineSnapshot(serverView())
        await new RisuSavePatcher().init(snapshot)
        await expect(new RisuSavePatcher().init(snapshot)).rejects.toThrow('already used')
    })
})
