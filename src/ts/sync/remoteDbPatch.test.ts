import { describe, expect, it, vi } from 'vitest'

// Real patcher and real stub helpers; only the heavy app modules are mocked.
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))
vi.mock('../storage/database.svelte', async () => {
    const { isChatStub } = await import('../storage/chatStub')
    return { isChatStub, createBotPresetTemplate: () => ({}), getDatabase: () => ({}) }
})

const { RisuSavePatcher } = await import('../storage/risuSave')
const { convertStubsToPlaceholders } = await import('../storage/chatStorage')
const { landRemoteDbPatch, characterIndexesWithChatOps } = await import('./remoteDbPatch')

const ALL = { character: [], chat: [], root: true, botPreset: true, modules: true, moduleIds: null, plugins: false, pluginCustomStorage: false }

/** The server's catalog: chats are stubs. */
function serverDb() {
    return {
        username: 'me',
        personaPrompt: 'hi',
        characters: [
            {
                chaId: 'c1', name: 'Alice', chatPage: 0,
                chats: [
                    { id: 'a1', name: 'Chat 1', lastDate: 1, _stub: true },
                    { id: 'a2', name: 'Chat 2', lastDate: 2, _stub: true },
                ],
            },
            { chaId: 'c2', name: 'Bob', chatPage: 0, chats: [{ id: 'b1', name: 'B', lastDate: 3, _stub: true }] },
        ],
        botPresets: [{ id: 'p1', name: 'Preset' }],
        modules: [{ id: 'm1', name: 'Mod' }],
    }
}

/** A page's live state: placeholders, plus one loaded conversation. */
function livePage(withBody = true) {
    const db: any = structuredClone(serverDb())
    for (const character of db.characters) character.chats = convertStubsToPlaceholders(character.chats)
    if (withBody) {
        db.characters[0].chats[0] = {
            id: 'a1', name: 'Chat 1', lastDate: 1, note: '', localLore: [], fmIndex: -1,
            message: [{ role: 'user', data: 'hello from a1' }],
        }
    }
    return db
}

async function pagePatcher() {
    const patcher = new RisuSavePatcher()
    await patcher.init(structuredClone(serverDb()))
    return patcher
}

/** What the phone sends after editing its own live state. */
async function phoneEdit(edit: (db: any) => void) {
    const patcher = await pagePatcher()
    const db = livePage(false)
    edit(db)
    const draft = patcher.fork()
    const { patch, expectedHash } = await draft.set(db, structuredClone(ALL))
    return { ops: patch, prevHash: expectedHash, nextHash: draft.hash() }
}

const land = (patcher: any, db: any, event: any) => landRemoteDbPatch({
    patcher,
    db,
    event,
    probeToSave: structuredClone(ALL),
    nextToSave: () => structuredClone(ALL),
    mutate: async (write) => write(),
})

describe('landing a remote database patch', () => {
    it('keeps a loaded conversation intact when a chat is inserted in front of it', async () => {
        const event = await phoneEdit((db) => {
            db.characters[0].chats.unshift({ id: 'a3', name: 'New', lastDate: 9, note: '', localLore: [], fmIndex: -1, message: [] })
        })
        // The patcher shifts slots rather than inserting: this is the case
        // that would relabel a loaded body if the ops hit it directly.
        expect(event.ops.some((op: any) => op.path === '/characters/0/chats/0/id')).toBe(true)
        expect(characterIndexesWithChatOps(event.ops)).toEqual(new Set([0]))

        const db = livePage()
        const body = db.characters[0].chats[0]
        const result = await land(await pagePatcher(), db, event)

        expect(result.status).toBe('applied')
        expect((result as any).patcher.hash()).toBe(event.nextHash)
        const chats = db.characters[0].chats
        expect(chats.map((chat: any) => chat.id)).toEqual(['a3', 'a1', 'a2'])
        expect(chats[0]._placeholder).toBe(true)
        expect(chats[1]).toBe(body)
        expect(chats[1].message).toEqual([{ role: 'user', data: 'hello from a1' }])
        expect(chats[2]._placeholder).toBe(true)
        expect(chats.some((chat: any) => chat._stub)).toBe(false)
    })

    it('applies catalog and settings edits, including to the loaded chat, and ends on the server hash', async () => {
        const event = await phoneEdit((db) => {
            db.username = 'phone'
            db.characters[1].name = 'Robert'
            db.characters[0].chats[0].name = 'Renamed'
            db.characters[0].chats[0].lastDate = 42
            db.modules[0].name = 'Mod 2'
        })

        const db = livePage()
        const result = await land(await pagePatcher(), db, event)

        expect(result.status).toBe('applied')
        expect((result as any).patcher.hash()).toBe(event.nextHash)
        expect(db.username).toBe('phone')
        expect(db.characters[1].name).toBe('Robert')
        expect(db.modules[0].name).toBe('Mod 2')
        expect(db.characters[0].chats[0]).toMatchObject({ id: 'a1', name: 'Renamed', lastDate: 42 })
        expect(db.characters[0].chats[0].message).toHaveLength(1)
    })

    it('keeps loaded bodies when the whole character list is replaced', async () => {
        const event = await phoneEdit((db) => {
            db.characters.unshift({ chaId: 'c0', name: 'Newcomer', chatPage: 0, chats: [] })
        })
        expect(event.ops).toEqual([expect.objectContaining({ op: 'replace', path: '/characters' })])

        const db = livePage()
        const result = await land(await pagePatcher(), db, event)

        expect(result.status).toBe('applied')
        expect((result as any).patcher.hash()).toBe(event.nextHash)
        expect(db.characters.map((character: any) => character.chaId)).toEqual(['c0', 'c1', 'c2'])
        expect(db.characters[1].chats[0].message).toEqual([{ role: 'user', data: 'hello from a1' }])
        expect(db.characters[2].chats[0]._placeholder).toBe(true)
    })

    it('touches nothing while this page has unsaved database edits', async () => {
        const event = await phoneEdit((db) => { db.username = 'phone' })
        const db = livePage()
        db.personaPrompt = 'typed here, not saved yet'
        const before = JSON.stringify(db)

        const result = await land(await pagePatcher(), db, event)

        expect(result.status).toBe('local-changes')
        expect(JSON.stringify(db)).toBe(before)
    })

    it('touches nothing when this page is not at the patch starting point', async () => {
        const event = await phoneEdit((db) => { db.username = 'phone' })
        const db = livePage()
        const before = JSON.stringify(db)

        const result = await land(await pagePatcher(), db, { ...event, prevHash: 'somewhere-else' })

        expect(result.status).toBe('not-at-base')
        expect(JSON.stringify(db)).toBe(before)
    })

    it('reports divergence instead of adopting a baseline that misses the server hash', async () => {
        const event = await phoneEdit((db) => { db.username = 'phone' })
        const result = await land(await pagePatcher(), livePage(), { ...event, nextHash: 'not-what-the-server-has' })
        expect(result.status).toBe('diverged')
    })
})
