import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import mergeModule from './peer-chat-merge.cjs'

const { reconcilePeerChats } = mergeModule as {
    reconcilePeerChats: (left: any, right: any, labels?: { left: string, right: string }) => {
        left: any, right: any, report: any
    }
}

const directories: string[] = []

function chat(id: string, lines: string[]) {
    return {
        id,
        name: id,
        message: lines.map((data, i) => ({ role: i % 2 ? 'char' : 'user', data, chatId: `${id}-${i}` })),
    }
}

function snapshot(chats: any[], extraCharacters: any[] = []) {
    return {
        settings: { apiKey: 'local-only' },
        characters: [{ chaId: 'bot-1', name: 'Bot', chats }, ...extraCharacters],
    }
}

// The two lab servers have distinct SQLite files. Their tiny test snapshots
// are JSON, not PocketRisu's production chunked database.bin encoding; this
// tests reconciliation semantics without claiming live-server integration.
function labServer(name: string, data: any) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `peer-chat-${name}-`))
    directories.push(directory)
    const db = new Database(path.join(directory, 'risuai.db'))
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL)')
    const write = (value: any) => db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
        .run('database/database.bin', Buffer.from(JSON.stringify(value)))
    const read = () => JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?')
        .get('database/database.bin').value.toString())
    write(data)
    return { db, read, write }
}

afterEach(() => {
    const tempRoot = path.resolve(os.tmpdir()) + path.sep
    for (const directory of directories.splice(0)) {
        const resolved = path.resolve(directory)
        if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('peer-chat-')) {
            throw new Error(`Refusing to remove unexpected lab directory: ${resolved}`)
        }
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})

describe('two isolated server chat reconciliation lab', () => {
    it('exchanges independent chat rooms without changing server-local settings', () => {
        const desktop = labServer('desktop', snapshot([chat('desktop-room', ['desktop'])]))
        const notebook = labServer('notebook', snapshot([chat('notebook-room', ['notebook'])]))
        try {
            const result = reconcilePeerChats(desktop.read(), notebook.read())
            desktop.write(result.left)
            notebook.write(result.right)
            expect(result.report).toMatchObject({ copiedToLeft: 1, copiedToRight: 1, conflictRooms: 0 })
            for (const server of [desktop, notebook]) {
                expect(server.read().characters[0].chats.map((room: any) => room.id).sort())
                    .toEqual(['desktop-room', 'notebook-room'])
                expect(server.read().settings.apiKey).toBe('local-only')
            }
        } finally {
            desktop.db.close()
            notebook.db.close()
        }
    })

    it('keeps both versions of a changed room, without overwriting either original', () => {
        const leftOriginal = chat('same-room', ['start', 'desktop reply'])
        const rightOriginal = chat('same-room', ['start', 'notebook reply'])
        const result = reconcilePeerChats(snapshot([leftOriginal]), snapshot([rightOriginal]), {
            left: 'desktop', right: 'notebook',
        })
        expect(result.left.characters[0].chats[0]).toEqual(leftOriginal)
        expect(result.right.characters[0].chats[0]).toEqual(rightOriginal)
        expect(result.left.characters[0].chats[1].message).toEqual(rightOriginal.message)
        expect(result.right.characters[0].chats[1].message).toEqual(leftOriginal.message)
        expect(result.left.characters[0].chats[1].id).toMatch(/^peer-preserved-/)
        expect(result.report.conflictRooms).toBe(2)
    })

    it('does not create more preserved rooms on a repeated sync', () => {
        const once = reconcilePeerChats(snapshot([chat('same-room', ['a'])]),
            snapshot([chat('same-room', ['b'])]))
        const twice = reconcilePeerChats(once.left, once.right)
        expect(twice.report).toMatchObject({ copiedToLeft: 0, copiedToRight: 0, conflictRooms: 0 })
        expect(twice.left).toEqual(once.left)
        expect(twice.right).toEqual(once.right)
    })

    it('recovers when only one side persisted the previous round', () => {
        const initialLeft = snapshot([chat('same-room', ['desktop version'])])
        const initialRight = snapshot([chat('same-room', ['notebook version'])])
        const planned = reconcilePeerChats(initialLeft, initialRight)
        // The desktop committed but the notebook disappeared before its write.
        const retried = reconcilePeerChats(planned.left, initialRight)
        expect(retried.left).toEqual(planned.left)
        expect(retried.right).toEqual(planned.right)
        expect(retried.report).toMatchObject({ copiedToLeft: 0, copiedToRight: 1 })
    })

    it('preserves a second divergence after an earlier conflict was reconciled', () => {
        const initial = reconcilePeerChats(snapshot([chat('same-room', ['start', 'desktop'])]),
            snapshot([chat('same-room', ['start', 'notebook'])]))
        initial.left.characters[0].chats[0].message.push({ role: 'user', data: 'later', chatId: 'later' })
        const next = reconcilePeerChats(initial.left, initial.right)
        expect(next.right.characters[0].chats.some((room: any) =>
            room.message.some((message: any) => message.data === 'later'))).toBe(true)
        expect(next.left.characters[0].chats[0].message.at(-1).data).toBe('later')
    })

    it('does not silently import a bot whose assets may be absent on the peer', () => {
        const exclusive = { chaId: 'only-desktop', name: 'Needs assets', chats: [chat('x', ['hi'])] }
        const result = reconcilePeerChats(snapshot([], [exclusive]), snapshot([]))
        expect(result.report.skippedCharacterIds).toEqual(['only-desktop'])
        expect(result.right.characters).toHaveLength(1)
    })

    it('rejects stub-only chat payloads before changing either input', () => {
        const desktop = snapshot([chat('one', ['original'])])
        const notebook = snapshot([{ id: 'one', _stub: true }])
        expect(() => reconcilePeerChats(desktop, notebook)).toThrow(/Full chat body required/)
        expect(desktop.characters[0].chats[0].message[0].data).toBe('original')
    })

    it('fails on a collision rather than replacing a preserved room', () => {
        const once = reconcilePeerChats(snapshot([chat('same-room', ['a'])]),
            snapshot([chat('same-room', ['b'])]))
        once.left.characters[0].chats[1].message[0].data = 'tampered'
        expect(() => reconcilePeerChats(once.left, once.right)).toThrow(/Preserved chat id collision/)
    })
})
