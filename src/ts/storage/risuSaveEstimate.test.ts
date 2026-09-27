import { describe, test, expect, vi } from 'vitest'

// Same isolation as risuSavePatcher.test.ts: the encoder and patcher are pure
// once their heavy imports are stubbed.
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({
    chatToStub: (c: any) => ({ id: c.id, name: c.name, _stub: true }),
}))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const { RisuSaveEncoder, RisuSavePatcher, utf8ByteLength } = await import('./risuSave')

const emptyToSave = () => ({
    character: [] as string[], chat: [] as [string, string][], root: false,
    botPreset: false, modules: false, plugins: false, pluginCustomStorage: false,
})

async function encodedBytes(db: any) {
    const encoder = new RisuSaveEncoder()
    await encoder.init(db, { compression: false })
    await encoder.set(db, emptyToSave())
    return encoder.encode()!.byteLength
}

function character(chaId: string, text: string) {
    return {
        chaId, name: `이름 ${chaId}`, desc: text, firstMessage: `${text} 🌙`,
        chats: [{ id: `${chaId}-chat`, name: '대화', message: [{ role: 'user', data: text }] }],
    }
}

function sampleDb() {
    return {
        characters: Array.from({ length: 40 }, (_, i) => character(`c${i}`, '긴 한국어 설명 문장입니다. '.repeat(200 + i))),
        botPresets: [{ id: 'p1', name: '프리셋', mainPrompt: '시스템 프롬프트 '.repeat(500) }],
        modules: [{ id: 'm1', name: '모듈', lorebook: [{ content: '로어북 항목 '.repeat(300) }] }],
        plugins: [],
        pluginCustomStorage: {},
        personaPrompt: '페르소나 '.repeat(100),
        username: 'user',
    }
}

function expectClose(estimate: number, actual: number) {
    // Only block headers and root key names are left out.
    expect(Math.abs(actual - estimate)).toBeLessThan(actual * 0.01 + 4096)
}

describe('utf8ByteLength', () => {
    test.each([
        ['ascii'],
        ['한국어 텍스트'],
        ['emoji 🌙🎉 mixed'],
        ['é ß ¢ 2-byte'],
        ['lone \uD800 surrogate'],
        [''],
    ])('matches Buffer.byteLength for %j', (text) => {
        expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'))
    })
})

describe('RisuSavePatcher.estimatePayloadBytes', () => {
    test('tracks a real full encode after init', async () => {
        const db = sampleDb()
        const patcher = new RisuSavePatcher()
        await patcher.init(db)
        expectClose(patcher.estimatePayloadBytes(), await encodedBytes(db))
    })

    test('follows character, root, preset and module edits and structural changes', async () => {
        const db = sampleDb()
        const patcher = new RisuSavePatcher()
        await patcher.init(structuredClone(db))

        db.characters[3].desc = '바뀐 설명 '.repeat(5000)
        db.personaPrompt = '새 페르소나 '.repeat(2000)
        await patcher.set(structuredClone(db), { ...emptyToSave(), character: ['c3'], root: true })
        expectClose(patcher.estimatePayloadBytes(), await encodedBytes(db))

        db.botPresets[0].mainPrompt = '짧게'
        db.modules[0].lorebook[0].content = '모듈 수정 '.repeat(3000)
        await patcher.set(structuredClone(db), { ...emptyToSave(), botPreset: true, modules: true })
        expectClose(patcher.estimatePayloadBytes(), await encodedBytes(db))

        db.characters.push(character('added', '새 캐릭터 '.repeat(4000)))
        db.characters.splice(0, 5)
        await patcher.set(structuredClone(db), emptyToSave())
        expectClose(patcher.estimatePayloadBytes(), await encodedBytes(db))
    })

    // init() leaves the sizes uncounted; they are counted when the estimate
    // is read or in countPayloadSizes slices. Either way the total must be
    // exactly the per-entry UTF-8 sum, through replacements, removals and forks.
    test('counts lazily and in slices to the exact per-entry total', async () => {
        const exact = (p: any) => {
            const { characters, botPresets, modules, ...root } = p.baselineDb()
            let bytes = utf8ByteLength(JSON.stringify(botPresets ?? []))
            for (const key of Object.keys(root)) bytes += utf8ByteLength(JSON.stringify(root[key]))
            for (const c of characters) bytes += utf8ByteLength(JSON.stringify(c))
            for (const m of modules ?? []) bytes += utf8ByteLength(JSON.stringify(m))
            return bytes
        }
        const db = sampleDb()
        const patcher = new RisuSavePatcher()
        await patcher.init(structuredClone(db))

        // A deadline already passed still counts one entry per call.
        let slices = 0
        while (!patcher.countPayloadSizes(0)) {
            slices++
            if (slices === 10) {
                // Replace counted and pending entries, drop some, mid-way.
                db.characters[0].desc = '처음 캐릭터 수정'
                db.characters[39].desc = '마지막 캐릭터 수정 '.repeat(100)
                db.personaPrompt = '바뀜'
                db.characters.splice(20, 2)
                await patcher.set(structuredClone(db), { ...emptyToSave(), character: ['c0', 'c39'], root: true })
            }
            if (slices === 20) {
                const draft = patcher.fork()
                expect(draft.estimatePayloadBytes()).toBe(exact(patcher))
            }
        }
        expect(slices).toBeGreaterThan(20)
        expect(patcher.countPayloadSizes(Infinity)).toBe(true)
        expect(patcher.estimatePayloadBytes()).toBe(exact(patcher))

        const fresh = new RisuSavePatcher()
        await fresh.init(structuredClone(db))
        expect(fresh.estimatePayloadBytes()).toBe(exact(fresh))
        expect(fresh.estimatePayloadBytes()).toBe(patcher.estimatePayloadBytes())
    })

    // The save loop computes each patch on a fork() draft and publishes the
    // draft only after the server accepts it, so the draft must carry the
    // size bookkeeping too (a plain Map copy made the estimate NaN).
    test('survives patching through a fork() draft', async () => {
        const db = sampleDb()
        const patcher = new RisuSavePatcher()
        await patcher.init(structuredClone(db))

        const untouched = patcher.fork()
        expect(untouched.estimatePayloadBytes()).toBe(patcher.estimatePayloadBytes())

        db.characters[3].desc = '바뀐 설명 '.repeat(5000)
        db.botPresets[0].mainPrompt = '짧게'
        const draft = patcher.fork()
        await draft.set(structuredClone(db), { ...emptyToSave(), character: ['c3'], botPreset: true })
        expectClose(draft.estimatePayloadBytes(), await encodedBytes(db))
        // The discarded-draft case: the original baseline is unchanged.
        expectClose(patcher.estimatePayloadBytes(), await encodedBytes(sampleDb()))
    })
})
