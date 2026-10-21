import { describe, expect, it, vi } from 'vitest'
import { applyOperation } from 'fast-json-patch'

// Real patcher, stub helpers and copy-on-write apply; only the heavy app modules are mocked.
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))
vi.mock('../storage/database.svelte', async () => {
    const { isChatStub } = await import('../storage/chatStub')
    return { isChatStub, createBotPresetTemplate: () => ({}), getDatabase: () => ({}) }
})

const { RisuSavePatcher, characterWithStubs, normalizeJSON } = await import('../storage/risuSave')
const { convertStubsToPlaceholders } = await import('../storage/chatStorage')
const { applyOpsCopyOnWrite } = await import('./copyOnWritePatch')
const { localChangeSet, planLanding, remoteChangeSet } = await import('./remoteLanding')
type Landing = typeof import('./remoteLanding')
type ChatRef = import('./remoteLanding').ChatRef

const ALL = { character: [], chat: [], root: true, botPreset: true, modules: true, moduleIds: null, plugins: false, pluginCustomStorage: false }

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const child of Object.values(value)) deepFreeze(child)
    }
    return value
}

// Key order as chatToStub writes it, so the JSON fast path can hit.
const stub = (id: string, name = `Chat ${id}`) => ({ id, name, _stub: true, lastDate: 1 })

/** The server's view: chats are catalog stubs. */
function serverDb(): any {
    return {
        username: 'me',
        personaPrompt: 'hi',
        language: 'en',
        statics: { messages: 10, imports: 0 },
        characterOrder: ['c1', 'c2', 'c3'],
        nodeOnlyArchivedCharacters: [],
        pluginCustomStorage: {},
        botPresetsId: 0,
        selectedPersona: 0,
        personas: [{ id: 'u1', name: 'Me' }, { id: 'u2', name: 'Alt' }],
        characters: [
            { chaId: 'c1', name: 'Alice', nickname: 'A', desc: 'd1', lastInteraction: 100, chatPage: 0, chats: [stub('a1'), stub('a2')] },
            { chaId: 'c2', name: 'Bob', desc: 'd2', lastInteraction: 200, chatPage: 0, chats: [stub('b1'), stub('b2')] },
            { chaId: 'c3', name: 'Cid', desc: 'd3', lastInteraction: 300, chatPage: 0, chats: [stub('c31')] },
        ],
        botPresets: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
        modules: [{ id: 'm1', name: 'M1', lorebook: [] }, { id: 'm2', name: 'M2', lorebook: [] }],
    }
}

/** A page's live state: placeholders, plus the chosen loaded bodies ('c1/a1'). */
function livePage(server: any, bodies: readonly string[] = []) {
    const db: any = structuredClone(server)
    for (const character of db.characters) {
        character.chats = convertStubsToPlaceholders(character.chats)
        character.chats = character.chats.map((chat: any) => bodies.includes(`${character.chaId}/${chat.id}`)
            ? { id: chat.id, name: chat.name, lastDate: chat.lastDate, note: '', localLore: [], fmIndex: -1, message: [{ role: 'user', data: `hello from ${chat.id}` }] }
            : chat)
    }
    return db
}

interface Scenario {
    server?: () => any
    /** The other device's edit of its copy of the server view (its patcher writes the ops). */
    remote?: (db: any) => void
    /** Or the ops themselves. */
    ops?: any[]
    /** This page's unsaved edits. */
    local?: (live: any) => void
    bodies?: string[]
    selected?: string | null
    split?: ChatRef[]
    busy?: string[]
    generating?: string[]
    holds?: [string, string][]
}

function fakePage(s: Scenario) {
    const busy = new Set(s.busy ?? [])
    const generating = new Set(s.generating ?? [])
    return {
        selectedChaId: () => s.selected ?? null,
        splitPaneChats: () => s.split ?? [],
        isChatBusy: (chaId: string, chatId: string) => busy.has(`${chaId}/${chatId}`),
        isCharacterGenerating: (chaId: string) => generating.has(chaId),
    }
}

async function remoteOps(server: any, edit: (db: any) => void) {
    const phone = new RisuSavePatcher()
    await phone.init(structuredClone(server))
    const db = structuredClone(server)
    edit(db)
    return (await phone.set(db, ALL)).patch
}

/** B, S and R for an event. B and S are deep-frozen: nothing may write into them. */
async function remoteSide(s: Scenario) {
    const server = (s.server ?? serverDb)()
    const patcher = new RisuSavePatcher()
    await patcher.init(structuredClone(server))
    const B = deepFreeze(patcher.baselineDb())
    const ops = s.ops ?? await remoteOps(server, s.remote ?? (() => {}))
    const S = deepFreeze(applyOpsCopyOnWrite(B, structuredClone(ops), applyOperation))
    return { server, patcher, B, S, ops, R: remoteChangeSet(B, S) }
}

async function land(s: Scenario) {
    const side = await remoteSide(s)
    const { server, patcher, B, S, R } = side
    if (R.ambiguous === true) throw new Error(`ambiguous: ${R.reason}`)
    const live = livePage(server, s.bodies)
    s.local?.(live)
    const liveBefore = JSON.stringify(live)
    const holds = new Map(s.holds ?? [])
    const normalize = vi.fn(normalizeJSON)
    const L = localChangeSet({ B, live, R, patcher, normalize, characterWithStubs, holds })
    const plan = planLanding({ B, S, R, L, live, page: fakePage(s), holds, clone: structuredClone, toPlaceholders: convertStubsToPlaceholders })
    // Planning only reads.
    expect(JSON.stringify(live)).toBe(liveBefore)
    expect([...holds]).toEqual(s.holds ?? [])
    return { ...side, R, L, live, holds, plan, normalize }
}

type Landed = Awaited<ReturnType<typeof land>>
type Plan = Extract<ReturnType<Landing['planLanding']>, { ok: true }>

function applied(landed: Landed): Plan {
    if (landed.plan.ok === false) throw new Error(`refused: ${landed.plan.conflicts.join(', ')}`)
    return landed.plan
}

function refused(landed: Landed): string[] {
    if (landed.plan.ok === true) throw new Error('landed')
    return landed.plan.conflicts
}

const characterOf = (plan: Plan, chaId: string) => plan.characters?.find((c: any) => c.chaId === chaId)

/** What the next save sends after the plan is written, on a baseline of S (I6 when it is []). */
async function nextSave(landed: Landed, plan: Plan) {
    const next = new RisuSavePatcher()
    await next.init(structuredClone(landed.S))
    const merged: any = { ...landed.live, ...structuredClone(plan.roots) }
    for (const key of plan.deleteRoots) delete merged[key]
    if (plan.characters) merged.characters = plan.characters
    const holds = new Map(landed.holds)
    for (const [chaId, chatId] of plan.holdUpdates) {
        if (chatId === null) holds.delete(chaId)
        else holds.set(chaId, chatId)
    }
    return (await next.set(merged, ALL, { chatPageHolds: holds })).patch
}

describe('remoteChangeSet', () => {
    it('ignores a replace that wrote the same value', async () => {
        const { R } = await remoteSide({ ops: [
            { op: 'replace', path: '/username', value: 'me' },
            { op: 'replace', path: '/statics', value: { imports: 0, messages: 10 } },
            { op: 'replace', path: '/characters/1/desc', value: 'd2' },
        ] })
        expect(R).toEqual({ ambiguous: false, roots: new Set(), removedRoots: new Set(), botPresets: false, modules: null, characters: null })
    })

    it('reads field ops at their final indexes after a structural op', async () => {
        const { R } = await remoteSide({ ops: [
            { op: 'remove', path: '/characters/0' },
            { op: 'replace', path: '/characters/0/desc', value: 'bob edited' },
        ] })
        if (R.ambiguous === true) throw new Error('ambiguous')
        expect(R.characters?.structure).toBe(true)
        expect(R.characters?.removed).toEqual(new Set(['c1']))
        expect([...R.characters!.changed.keys()]).toEqual(['c2'])
        expect(R.characters?.changed.get('c2')?.fields).toEqual(new Set(['desc']))
    })

    it('refines a whole /characters replace to what really changed', async () => {
        const { R } = await remoteSide({ remote: (db) => {
            db.characters.reverse()
            db.characters[1].name = 'Bobby'
        } })
        if (R.ambiguous === true) throw new Error('ambiguous')
        expect(R.characters?.structure).toBe(true)
        expect(R.characters?.added.size).toBe(0)
        expect(R.characters?.removed.size).toBe(0)
        expect([...R.characters!.changed.keys()]).toEqual(['c2'])
        expect(R.characters?.changed.get('c2')?.fields).toEqual(new Set(['name']))
    })

    it('records chat removals, additions and sequence changes', async () => {
        const { R } = await remoteSide({ remote: (db) => {
            db.characters[0].chats = [stub('a3'), stub('a1')]
        } })
        if (R.ambiguous === true) throw new Error('ambiguous')
        const change = R.characters!.changed.get('c1')!
        expect(change.fields).toEqual(new Set(['chats']))
        expect(change.removedChats).toEqual(new Set(['a2']))
        expect(change.addedChats).toEqual(new Set(['a3']))
        expect(change.seqChanged).toBe(true)
    })

    it('records presets and module changes', async () => {
        const { R } = await remoteSide({ remote: (db) => {
            db.botPresets[0].name = 'P1 edited'
            db.modules[0].name = 'M1 edited'
            db.modules.push({ id: 'm3', name: 'M3', lorebook: [] })
        } })
        if (R.ambiguous === true) throw new Error('ambiguous')
        expect(R.botPresets).toBe(true)
        expect(R.modules).toEqual({ structure: true, added: new Set(['m3']), removed: new Set(), changed: new Set(['m1']) })
    })

    it('says ambiguous for missing or duplicate ids', async () => {
        const dupCharacter = await remoteSide({ ops: [{ op: 'add', path: '/characters/-', value: { chaId: 'c1', chats: [] } }] })
        expect(dupCharacter.R).toEqual({ ambiguous: true, reason: 'character-ids' })
        const noChaId = await remoteSide({ ops: [{ op: 'remove', path: '/characters/0/chaId' }] })
        expect(noChaId.R).toEqual({ ambiguous: true, reason: 'character-ids' })
        const dupModule = await remoteSide({ ops: [{ op: 'add', path: '/modules/-', value: { id: 'm1' } }] })
        expect(dupModule.R).toEqual({ ambiguous: true, reason: 'module-ids' })
        const dupChat = await remoteSide({ ops: [{ op: 'add', path: '/characters/0/chats/-', value: stub('a1') }] })
        expect(dupChat.R).toEqual({ ambiguous: true, reason: 'chat-ids' })
    })

    it('records a removed root key', async () => {
        const { R } = await remoteSide({ remote: (db) => { delete db.personaPrompt } })
        if (R.ambiguous === true) throw new Error('ambiguous')
        expect(R.roots).toEqual(new Set(['personaPrompt']))
        expect(R.removedRoots).toEqual(new Set(['personaPrompt']))
    })
})

describe('localChangeSet', () => {
    it('takes the JSON fast path for unchanged entries', async () => {
        const landed = await land({ remote: (db) => {
            db.username = 'you'
            db.characters[0].desc = 'remote desc'
            db.modules[0].name = 'M1 remote'
        } })
        expect(landed.normalize).not.toHaveBeenCalled()
        expect(landed.L.roots.get('username')).toEqual({ changed: false, present: true })
        expect(landed.L.characters?.entries.get('c1')).toEqual({ present: true, fields: new Set(), stub: null, moved: false })
        expect(landed.L.modules?.entries.get('m1')).toEqual({ changed: false, present: true })
    })

    it('counts order-only differences as unchanged', async () => {
        const landed = await land({
            remote: (db) => {
                db.statics.messages = 11
                db.characters[0].desc = 'remote desc'
            },
            local: (live) => {
                live.statics = { imports: 0, messages: 10 }
                const { chaId, ...rest } = live.characters[0]
                live.characters[0] = { ...rest, chaId }
            },
        })
        expect(landed.normalize).toHaveBeenCalled()
        expect(landed.L.roots.get('statics')?.changed).toBe(false)
        expect(landed.L.characters?.entries.get('c1')?.fields).toEqual(new Set())
    })

    it('lists changed fields without chatPage, which is a move unless held', async () => {
        const moved = await land({
            remote: (db) => { db.characters[1].desc = 'remote' },
            local: (live) => { live.characters[1].name = 'Local'; live.characters[1].chatPage = 1 },
        })
        const entry = moved.L.characters?.entries.get('c2')
        expect(entry?.fields).toEqual(new Set(['name']))
        expect(entry?.moved).toBe(true)
        expect(entry?.stub?.name).toBe('Local')

        const held = await land({
            remote: (db) => { db.characters[1].desc = 'remote' },
            local: (live) => { live.characters[1].chatPage = 1 },
            holds: [['c2', 'b2']],
        })
        expect(held.L.characters?.entries.get('c2')).toMatchObject({ fields: new Set(), moved: false })
    })

    it('checks the partner of an index key or list the remote changed', async () => {
        const landed = await land({ remote: (db) => { db.selectedPersona = 1 } })
        expect([...landed.L.roots.keys()].sort()).toEqual(['personas', 'selectedPersona'])
        const presets = await land({ remote: (db) => { db.botPresets.unshift({ id: 'p0', name: 'P0' }) } })
        expect(presets.L.roots.has('botPresetsId')).toBe(true)
        expect(presets.L.botPresets).toEqual({ changed: false, present: true })
    })
})

describe('planLanding: root keys', () => {
    it('writes a remote change and deletes a remote removal where live is unchanged', async () => {
        const landed = await land({ remote: (db) => { db.username = 'you'; delete db.personaPrompt; db.language = 'ko' } })
        const plan = applied(landed)
        expect(plan.roots).toEqual({ username: 'you', language: 'ko' })
        expect(plan.deleteRoots).toEqual(['personaPrompt'])
        expect(plan.languageChanged).toBe(true)
        expect(plan.characters).toBeNull()
        expect(await nextSave(landed, plan)).toEqual([])
    })

    it('writes a clone, never the server object', async () => {
        const landed = await land({ remote: (db) => { db.personas[1].name = 'Alt 2' } })
        const plan = applied(landed)
        expect(plan.roots.personas).toEqual(landed.S.personas)
        expect(plan.roots.personas).not.toBe(landed.S.personas)
        expect((plan.roots.personas as any[])[0]).not.toBe(landed.B.personas[0])
    })

    it('keeps live when both made the same change', async () => {
        const plan = applied(await land({ remote: (db) => { db.username = 'same' }, local: (live) => { live.username = 'same' } }))
        expect(plan.roots).toEqual({})
    })

    it('refuses different changes, and a removal against a local change', async () => {
        expect(refused(await land({ remote: (db) => { db.username = 'a' }, local: (live) => { live.username = 'b' } }))).toEqual(['root:username'])
        expect(refused(await land({ remote: (db) => { delete db.personaPrompt }, local: (live) => { live.personaPrompt = 'mine' } }))).toEqual(['root:personaPrompt'])
        expect(refused(await land({ remote: (db) => { db.personaPrompt = 'theirs' }, local: (live) => { delete live.personaPrompt } }))).toEqual(['root:personaPrompt'])
    })

    it('takes nothing when both removed the key', async () => {
        const plan = applied(await land({ remote: (db) => { delete db.personaPrompt }, local: (live) => { delete live.personaPrompt } }))
        expect(plan.deleteRoots).toEqual([])
    })

    it('adds both sides\' sends to statics (A +2, B +3 from 10 gives 15)', async () => {
        const landed = await land({ remote: (db) => { db.statics.messages = 13 }, local: (live) => { live.statics.messages = 12 } })
        const plan = applied(landed)
        expect(plan.roots.statics).toEqual({ messages: 15, imports: 0 })
        // The next save sends this page's own two sends on top of the server's.
        expect(await nextSave(landed, plan)).toEqual([{ op: 'replace', path: '/statics/messages', value: 15 }])
    })
})

describe('planLanding: index keys', () => {
    it('re-points botPresetsId by id after a remote preset insert', async () => {
        for (const remoteIndex of [0, 1]) {
            const landed = await land({
                remote: (db) => { db.botPresets.unshift({ id: 'p0', name: 'P0' }); db.botPresetsId = remoteIndex },
                local: (live) => { live.botPresetsId = 1 },
            })
            const plan = applied(landed)
            expect(plan.roots.botPresetsId).toBe(2)
            expect((plan.roots.botPresets as any[]).map((p) => p.id)).toEqual(['p0', 'p1', 'p2'])
        }
    })

    it('re-points selectedPersona after a remote persona delete, or refuses when it was the chosen one', async () => {
        const plan = applied(await land({
            remote: (db) => { db.personas.splice(0, 1) },
            local: (live) => { live.selectedPersona = 1 },
        }))
        expect(plan.roots.selectedPersona).toBe(0)
        expect((plan.roots.personas as any[]).map((p) => p.id)).toEqual(['u2'])

        expect(refused(await land({
            remote: (db) => { db.personas.splice(1, 1) },
            local: (live) => { live.selectedPersona = 1 },
        }))).toEqual(['index:selectedPersona'])
    })

    it('re-points a remote choice into the list this page changed', async () => {
        const plan = applied(await land({
            remote: (db) => { db.selectedPersona = 1 },
            local: (live) => { live.personas.unshift({ id: 'u0', name: 'New' }); live.selectedPersona = 1 },
        }))
        expect(plan.roots).toEqual({ selectedPersona: 2 })
    })

    it('refuses two different choices', async () => {
        const server = () => ({ ...serverDb(), personas: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] })
        // Over an unchanged list this is the plain root rule.
        expect(refused(await land({ server, remote: (db) => { db.selectedPersona = 1 }, local: (live) => { live.selectedPersona = 2 } })))
            .toEqual(['root:selectedPersona'])
        const plan = applied(await land({ server, remote: (db) => { db.selectedPersona = 2 }, local: (live) => { live.selectedPersona = 2 } }))
        expect(plan.roots).toEqual({})
        // With the list changed too, by id.
        expect(refused(await land({
            server,
            remote: (db) => { db.personas.push({ id: 'u4' }); db.selectedPersona = 1 },
            local: (live) => { live.selectedPersona = 2 },
        }))).toEqual(['index:selectedPersona'])
    })

    it('keeps the same index set on both sides over a list without ids', async () => {
        const server = () => ({ ...serverDb(), loreBook: [{ name: 'a', data: [] }, { name: 'b', data: [] }], loreBookPage: 0 })
        const plan = applied(await land({ server, remote: (db) => { db.loreBookPage = 1 }, local: (live) => { live.loreBookPage = 1 } }))
        expect(plan.roots).toEqual({})
        // Re-pointing needs ids.
        expect(refused(await land({
            server,
            remote: (db) => { db.loreBook.unshift({ name: 'new', data: [] }) },
            local: (live) => { live.loreBookPage = 1 },
        }))).toEqual(['index:loreBookPage'])
    })
})

describe('planLanding: botPresets', () => {
    it('writes, keeps or refuses', async () => {
        const write = applied(await land({ remote: (db) => { db.botPresets[1].name = 'P2 remote' } }))
        expect((write.roots.botPresets as any[])[1].name).toBe('P2 remote')
        const keep = applied(await land({ remote: (db) => { db.botPresets[1].name = 'same' }, local: (live) => { live.botPresets[1].name = 'same' } }))
        expect(keep.roots).toEqual({})
        expect(refused(await land({ remote: (db) => { db.botPresets[1].name = 'a' }, local: (live) => { live.botPresets[1].name = 'b' } })))
            .toEqual(['botPresets'])
    })
})

describe('planLanding: modules', () => {
    it('takes the remote module and keeps the live object of the one edited here', async () => {
        const landed = await land({ remote: (db) => { db.modules[0].name = 'M1 remote' }, local: (live) => { live.modules[1].name = 'M2 local' } })
        const modules = applied(landed).roots.modules as any[]
        expect(modules.map((m) => m.name)).toEqual(['M1 remote', 'M2 local'])
        expect(modules[1]).toBe(landed.live.modules[1])
        expect(modules[0]).not.toBe(landed.S.modules[0])
    })

    it('lands a remote add and remove while a retained module is edited here', async () => {
        const landed = await land({
            remote: (db) => { db.modules.splice(0, 1); db.modules.push({ id: 'm3', name: 'M3', lorebook: [] }) },
            local: (live) => { live.modules[1].name = 'M2 local' },
        })
        const modules = applied(landed).roots.modules as any[]
        expect(modules.map((m) => m.id)).toEqual(['m2', 'm3'])
        expect(modules[0]).toBe(landed.live.modules[1])
    })

    it('refuses the same module changed differently, keeps it when equal', async () => {
        expect(refused(await land({ remote: (db) => { db.modules[0].name = 'a' }, local: (live) => { live.modules[0].name = 'b' } }))).toEqual(['module'])
        expect(refused(await land({ remote: (db) => { db.modules[0].name = 'a' }, local: (live) => { live.modules.splice(0, 1) } }))).toEqual(['module'])
        const landed = await land({ remote: (db) => { db.modules[0].name = 'same' }, local: (live) => { live.modules[0].name = 'same' } })
        expect((applied(landed).roots.modules as any[])[0]).toBe(landed.live.modules[0])
    })

    it('refuses a remote reorder against a local add', async () => {
        expect(refused(await land({
            remote: (db) => { db.modules.reverse() },
            local: (live) => { live.modules.push({ id: 'm9', name: 'M9', lorebook: [] }) },
        }))).toEqual(['modules-structure'])
    })
})

describe('planLanding: characters', () => {
    it('refuses when both changed the character structure', async () => {
        expect(refused(await land({
            remote: (db) => { db.characters.push({ chaId: 'c4', name: 'D', chatPage: 0, chats: [] }) },
            local: (live) => { live.characters.push({ chaId: 'c5', name: 'E', chatPage: 0, chats: [] }) },
        }))).toEqual(['char-structure'])
    })

    it('adds a remote character with placeholder chats', async () => {
        const landed = await land({ remote: (db) => { db.characters.push({ chaId: 'c4', name: 'D', chatPage: 0, chats: [stub('z1')] }) } })
        const plan = applied(landed)
        expect(plan.characters?.map((c: any) => c.chaId)).toEqual(['c1', 'c2', 'c3', 'c4'])
        expect(plan.characters?.slice(0, 3)).toEqual(landed.live.characters)
        plan.characters?.slice(0, 3).forEach((c: any, i: number) => expect(c).toBe(landed.live.characters[i]))
        const added = characterOf(plan, 'c4')
        expect(added.chats[0]).toMatchObject({ id: 'z1', _placeholder: true })
        expect(added.chats[0]._stub).toBeUndefined()
        expect(plan.knownChats.get('c4')).toEqual(['z1'])
        expect(plan.structural).toBe(true)
        expect(await nextSave(landed, plan)).toEqual([])
    })

    it('keeps a character added on both sides when it is the same, refuses otherwise', async () => {
        const fresh = () => ({ chaId: 'c4', name: 'D', chatPage: 0, chats: [stub('z1')] })
        const same = applied(await land({
            remote: (db) => { db.characters.push(fresh()) },
            local: (live) => { live.characters.push({ ...fresh(), chats: convertStubsToPlaceholders([stub('z1')] as any) }) },
        }))
        expect(same.characters).toBeNull()
        expect(refused(await land({
            remote: (db) => { db.characters.push(fresh()) },
            local: (live) => { live.characters.push({ ...fresh(), name: 'Other', chats: [] }) },
        }))).toEqual(['char-added-differs'])
    })

    it('refuses a remote edit of a character removed here', async () => {
        expect(refused(await land({
            remote: (db) => { db.characters[1].desc = 'x' },
            local: (live) => { live.characters.splice(1, 1) },
        }))).toEqual(['char-removed-locally'])
    })

    it('removes a clean character, deselecting it when selected', async () => {
        const remove = (db: any) => { db.characters.splice(1, 1) }
        const plan = applied(await land({ remote: remove, holds: [['c2', 'b2']] }))
        expect(plan.characters?.map((c: any) => c.chaId)).toEqual(['c1', 'c3'])
        expect(plan.removedCharacters).toEqual(['c2'])
        expect(plan.deselect).toBe(false)
        expect(plan.holdUpdates).toEqual(new Map([['c2', null]]))
        const selected = applied(await land({ remote: remove, selected: 'c2' }))
        expect(selected.deselect).toBe(true)
    })

    it('lands a removal made on both sides', async () => {
        const plan = applied(await land({ remote: (db) => { db.characters.splice(1, 1) }, local: (live) => { live.characters.splice(1, 1) } }))
        expect(plan.characters).toBeNull()
        expect(plan.removedCharacters).toEqual([])
    })

    it('refuses removing a character that is edited, busy, generating or in the split pane', async () => {
        const remove = (db: any) => { db.characters.splice(1, 1) }
        expect(refused(await land({ remote: remove, local: (live) => { live.characters[1].desc = 'mine' } }))).toEqual(['char-removed-edited'])
        expect(refused(await land({ remote: remove, busy: ['c2/b2'] }))).toEqual(['char-removed-busy'])
        expect(refused(await land({ remote: remove, generating: ['c2'] }))).toEqual(['char-removed-generating'])
        expect(refused(await land({ remote: remove, split: [{ chaId: 'c2', chatId: 'b1' }] }))).toEqual(['char-removed-split'])
    })

    it('takes remote fields, deletes removed ones and keeps a different local field', async () => {
        const landed = await land({
            remote: (db) => { db.characters[0].desc = 'remote desc'; delete db.characters[0].nickname },
            local: (live) => { live.characters[0].name = 'Local name' },
        })
        const plan = applied(landed)
        const c1 = characterOf(plan, 'c1')
        expect(c1).toMatchObject({ desc: 'remote desc', name: 'Local name' })
        expect('nickname' in c1).toBe(false)
        expect(c1.chats).toBe(landed.live.characters[0].chats)
        expect(characterOf(plan, 'c2')).toBe(landed.live.characters[1])
        expect(plan.structural).toBe(false)
        expect(plan.knownChats.get('c1')).toEqual(['a1', 'a2'])
    })

    it('keeps a field both changed alike, takes the later lastInteraction, refuses the rest', async () => {
        expect(applied(await land({ remote: (db) => { db.characters[0].desc = 'x' }, local: (live) => { live.characters[0].desc = 'x' } })).characters).toBeNull()

        const later = applied(await land({ remote: (db) => { db.characters[0].lastInteraction = 500 }, local: (live) => { live.characters[0].lastInteraction = 400 } }))
        expect(characterOf(later, 'c1').lastInteraction).toBe(500)
        const mineLater = applied(await land({ remote: (db) => { db.characters[0].lastInteraction = 500 }, local: (live) => { live.characters[0].lastInteraction = 600 } }))
        expect(mineLater.characters).toBeNull()

        expect(refused(await land({ remote: (db) => { db.characters[0].desc = 'a' }, local: (live) => { live.characters[0].desc = 'b' } }))).toEqual(['char-field:desc'])
        expect(refused(await land({
            remote: (db) => { db.characters[0].chats[0].name = 'remote' },
            local: (live) => { live.characters[0].chats[0].name = 'local' },
        }))).toEqual(['char-chats'])
    })
})

describe('planLanding: chats taken from S', () => {
    const insertA3 = (chatPage?: number) => (db: any) => {
        db.characters[0].chats.unshift(stub('a3'))
        if (chatPage !== undefined) db.characters[0].chatPage = chatPage
    }

    it('writes placeholders from S and suppresses tracking of the clean loaded bodies', async () => {
        const landed = await land({ remote: insertA3(), bodies: ['c1/a1', 'c1/a2'], busy: ['c1/a2'] })
        const plan = applied(landed)
        const c1 = characterOf(plan, 'c1')
        expect(c1.chats.map((c: any) => c.id)).toEqual(['a3', 'a1', 'a2'])
        expect(c1.chats.every((c: any) => c._placeholder === true)).toBe(true)
        expect(plan.suppress).toEqual([{ chaId: 'c1', chatId: 'a1' }])
        expect(plan.structural).toBe(true)
        expect(plan.knownChats.get('c1')).toEqual(['a3', 'a1', 'a2'])
        // Not selected and not moved here: the server's open chat.
        expect(c1.chatPage).toBe(0)
        expect(await nextSave(landed, plan)).toEqual([])
    })

    it('suppresses nothing for a generating character', async () => {
        const plan = applied(await land({ remote: insertA3(), bodies: ['c1/a1'], generating: ['c1'] }))
        expect(plan.suppress).toEqual([])
    })

    it('refuses removing a busy chat, a split-pane chat, or the selected character\'s last chat', async () => {
        const removeA2 = (db: any) => { db.characters[0].chats.splice(1, 1) }
        expect(refused(await land({ remote: removeA2, busy: ['c1/a2'] }))).toEqual(['chat-removed-busy'])
        expect(refused(await land({ remote: removeA2, split: [{ chaId: 'c1', chatId: 'a2' }] }))).toEqual(['chat-removed-split'])
        const removeAll = (db: any) => { db.characters[2].chats = [] }
        expect(refused(await land({ remote: removeAll, selected: 'c3' }))).toEqual(['chat-removed-last'])
        expect(applied(await land({ remote: removeAll })).characters).not.toBeNull()
    })
})

describe('planLanding: chatPage', () => {
    it('keeps the selected character on its open chat by id and holds it', async () => {
        const landed = await land({ remote: (db) => { db.characters[0].chats.unshift(stub('a3')) }, selected: 'c1', bodies: ['c1/a1'] })
        const plan = applied(landed)
        expect(characterOf(plan, 'c1').chatPage).toBe(1)
        expect(plan.holdUpdates).toEqual(new Map([['c1', 'a1']]))
        // The hold sends the server's chatPage, so nothing echoes back.
        expect(await nextSave(landed, plan)).toEqual([])
    })

    it('needs no hold when the server opened the same chat', async () => {
        const plan = applied(await land({
            remote: (db) => { db.characters[0].chats.unshift(stub('a3')); db.characters[0].chatPage = 1 },
            selected: 'c1',
            holds: [['c1', 'a2']],
        }))
        expect(characterOf(plan, 'c1').chatPage).toBe(1)
        expect(plan.holdUpdates).toEqual(new Map([['c1', null]]))
    })

    it('keeps a move made here on a character that is not selected, and drops its hold', async () => {
        const plan = applied(await land({
            remote: (db) => { db.characters[1].chats.unshift(stub('b3')) },
            local: (live) => { live.characters[1].chatPage = 1 },
            holds: [['c2', 'b1']],
        }))
        expect(characterOf(plan, 'c2').chatPage).toBe(2)
        expect(plan.holdUpdates).toEqual(new Map([['c2', null]]))
    })

    it('lets a character that is neither selected nor moved follow the server', async () => {
        const plan = applied(await land({ remote: (db) => { db.characters[1].chatPage = 1 }, holds: [['c2', 'b1']] }))
        expect(characterOf(plan, 'c2').chatPage).toBe(1)
        expect(plan.holdUpdates).toEqual(new Map([['c2', null]]))
        // The selected one stays where it is and holds.
        const selected = applied(await land({ remote: (db) => { db.characters[1].chatPage = 1 }, selected: 'c2' }))
        expect(selected.characters).toBeNull()
        expect(selected.holdUpdates).toEqual(new Map([['c2', 'b1']]))
    })

    it('clamps when the selected character\'s open chat was removed elsewhere', async () => {
        const plan = applied(await land({
            remote: (db) => { db.characters[0].chats.splice(1, 1) },
            local: (live) => { live.characters[0].chatPage = 1 },
            selected: 'c1',
        }))
        const c1 = characterOf(plan, 'c1')
        expect(c1.chats.map((c: any) => c.id)).toEqual(['a1'])
        expect(c1.chatPage).toBe(0)
        expect(plan.removedOpenChat).toEqual({ chaId: 'c1', chatId: 'a2' })
    })
})

describe('planLanding: archive invariant', () => {
    it('lands a deactivation elsewhere', async () => {
        const plan = applied(await land({ remote: (db) => {
            const [gone] = db.characters.splice(2, 1)
            db.nodeOnlyArchivedCharacters.push({ chaId: gone.chaId, name: gone.name, archivedAt: 1 })
            db.characterOrder = ['c1', 'c2']
        } }))
        expect(plan.characters?.map((c: any) => c.chaId)).toEqual(['c1', 'c2'])
        expect((plan.roots.nodeOnlyArchivedCharacters as any[]).map((s) => s.chaId)).toEqual(['c3'])
        expect(plan.removedCharacters).toEqual(['c3'])
    })

    it('refuses a result with a chaId both active and deactivated', async () => {
        expect(refused(await land({ remote: (db) => {
            db.nodeOnlyArchivedCharacters.push({ chaId: 'c2', name: 'Bob', archivedAt: 1 })
        } }))).toEqual(['archive-invariant'])
    })
})

describe('planLanding: refusals', () => {
    it('carries kind names only, never values or names', async () => {
        const conflicts = refused(await land({
            remote: (db) => {
                db.username = 'SECRET-remote-name'
                db.characters[0].desc = 'SECRET-remote-desc'
                db.characters[0].name = 'SECRET-remote-character'
            },
            local: (live) => {
                live.username = 'SECRET-local-name'
                live.characters[0].desc = 'SECRET-local-desc'
                live.characters[0].name = 'SECRET-local-character'
            },
        }))
        expect(conflicts.sort()).toEqual(['char-field:desc', 'char-field:name', 'root:username'])
        expect(JSON.stringify(conflicts)).not.toContain('SECRET')
    })

    it('refuses a live state with ambiguous character ids', async () => {
        expect(refused(await land({
            remote: (db) => { db.characters[0].desc = 'x' },
            local: (live) => { live.characters.push({ ...live.characters[1] }) },
        }))).toEqual(['ambiguous-live-characters'])
    })
})

describe('planLanding: no echo', () => {
    it('leaves nothing to send after a mixed event lands on a page without edits', async () => {
        const landed = await land({
            remote: (db) => {
                db.username = 'you'
                db.statics.messages = 11
                db.characterOrder = ['c2', 'c1', 'c3']
                db.characters[1].lastInteraction = 999
                db.characters[1].chats.unshift(stub('b3'))
                db.characters[0].chats[1].name = 'renamed'
                db.botPresets.push({ id: 'p3', name: 'P3' })
                db.modules[1].lorebook.push({ key: 'k', content: 'c' })
            },
            bodies: ['c1/a2', 'c2/b1'],
            selected: 'c2',
        })
        const plan = applied(landed)
        expect(plan.suppress).toEqual([{ chaId: 'c1', chatId: 'a2' }, { chaId: 'c2', chatId: 'b1' }])
        expect(await nextSave(landed, plan)).toEqual([])
    })
})
