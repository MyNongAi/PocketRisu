/**
 * Input word rank (/api/input-word-rank) against a real server: active chats
 * from the chat store, a deactivated bot from its archive row on request, a
 * trashed one never, and the scopes that name a bot or chat.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const encodeDb = (data: unknown) => Buffer.concat([MAGIC_RAW, packr.encode(data)])
const DB_KEY_HEX = Buffer.from('database/database.bin', 'utf-8').toString('hex')

const ARCH = 'rank-arch'
const KEEP = 'rank-keep'

function buildBackup(): Buffer {
    const mkChat = (id: string, message: unknown[]) => ({ id, name: `Chat ${id}`, lastDate: 1, localLore: [], scriptstate: {}, note: '', message })
    const characters = [
        {
            chaId: ARCH, type: 'character', name: 'To Deactivate', desc: '', firstMessage: 'hi', image: '',
            chats: [mkChat('arch-0', [
                { role: 'user', data: '귤을 먹었다', time: 10 },
                { role: 'char', data: '고르세요', time: 11 },
                { role: 'user', data: '봇이 넣은 말' },
            ])],
            chatPage: 0, lastInteraction: 1,
        },
        {
            chaId: KEEP, type: 'character', name: 'Stays', desc: '', firstMessage: 'yo', image: '',
            chats: [
                mkChat('keep-0', [{ role: 'user', data: '사과를 먹었다', time: 20 }, { role: 'char', data: '응', time: 21 }]),
                mkChat('keep-1', [{ role: 'user', data: '사과를 먹었다', time: 20 }, { role: 'user', data: '배를 먹었다', time: 22 }]),
            ],
            chatPage: 0, lastInteraction: 2,
        },
    ]
    const database = {
        characters, characterOrder: [ARCH, KEEP],
        apiType: 'openai', mainPrompt: '', jailbreak: '', globalNote: '',
        temperature: 80, maxContext: 4000, maxResponse: 300, frequencyPenalty: 70, PresensePenalty: 70,
        personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
        botPresets: [], botPresetsId: 0, moduleIntergration: [], selectedCharacter: 0,
    }
    return encodeBackup([{ name: 'database.risudat', data: encodeDb(database) }])
}

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
    srv = await spawnServer()
    client = await createClient(srv.port, srv.password)
    const imported = await client.importBackup(buildBackup())
    expect(imported.ok).toBe(true)
})
afterAll(async () => { await srv?.cleanup() })

async function rank(body: Record<string, unknown>) {
    const res = await client.fetch('/api/input-word-rank', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ particles: false, ...body }),
    })
    return { status: res.status, body: await res.json() as any }
}
const words = (body: any) => Object.fromEntries(body.words)

async function readDb() {
    const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
    expect(res.status).toBe(200)
    const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
    return { db, hash: utils.calculateHash(db).toString(16) }
}
function sendPatch(patch: unknown[], expectedHash: string) {
    return client.fetch('/api/patch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
        body: JSON.stringify({ patch, expectedHash }),
    })
}

describe('input word rank', () => {
    test('every active bot, a copied message counted once', async () => {
        const { status, body } = await rank({ scope: 'all' })
        expect(status).toBe(200)
        expect(words(body)).toEqual({ 먹었다: 3, 귤을: 1, 사과를: 1, 배를: 1 })
        expect(body.totals).toMatchObject({ bots: 2, chats: 3, inputs: 3, copies: 1, botInputs: 1, deactivatedBots: 0 })
    })

    test('a deactivated bot counts only on request, read from its archive row', async () => {
        const archived = await client.fetch(`/api/characters/${ARCH}/archive`, { method: 'POST' })
        expect(archived.status).toBe(200)
        const { stub } = await archived.json() as any
        const before = await readDb()
        const idx = before.db.characters.findIndex((c: any) => c.chaId === ARCH)
        const moved = await sendPatch([
            { op: 'remove', path: `/characters/${idx}` },
            { op: 'add', path: '/nodeOnlyArchivedCharacters', value: [stub] },
        ], before.hash)
        expect(moved.status).toBe(200)

        const active = await rank({ scope: 'all' })
        expect(words(active.body)).toEqual({ 먹었다: 2, 사과를: 1, 배를: 1 })
        const all = await rank({ scope: 'all', deactivated: true })
        expect(words(all.body)).toEqual({ 먹었다: 3, 귤을: 1, 사과를: 1, 배를: 1 })
        expect(all.body.totals).toMatchObject({ bots: 2, deactivatedBots: 1, botInputs: 1, failed: 0 })
    })

    test('this bot and this chat; a deactivated one is not found', async () => {
        const bot = await rank({ scope: 'char', chaId: KEEP })
        expect(words(bot.body)).toEqual({ 먹었다: 2, 사과를: 1, 배를: 1 })
        const chat = await rank({ scope: 'chat', chaId: KEEP, chatId: 'keep-0' })
        expect(words(chat.body)).toEqual({ 먹었다: 1, 사과를: 1 })
        expect((await rank({ scope: 'chat', chaId: ARCH, chatId: 'arch-0' })).status).toBe(404)
        expect((await rank({ scope: 'char', chaId: ARCH })).status).toBe(404)
    })

    test('a trashed deactivated bot is left out', async () => {
        const before = await readDb()
        const res = await sendPatch([{ op: 'add', path: '/nodeOnlyArchivedCharacters/0/trashedAt', value: Date.now() }], before.hash)
        expect(res.status).toBe(200)
        const all = await rank({ scope: 'all', deactivated: true })
        expect(words(all.body)).toEqual({ 먹었다: 2, 사과를: 1, 배를: 1 })
        expect(all.body.totals.deactivatedBots).toBe(0)
    })
})
