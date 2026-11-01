import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const { rankInputWords, readRequest } = require('./input-word-rank.cjs') as typeof import('./input-word-rank.cjs')

const root = path.resolve(__dirname, '../..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')

const user = (data: string, time?: number) => ({ role: 'user', data, ...(time ? { time } : {}) })
const char = (data: string, time: number) => ({ role: 'char', data, time })

function setup() {
    const bodies = new Map<string, any>([
        ['a/a1', { message: [user('사과를 먹었다', 1), char('그래', 2), user('사과를 먹었다', 3)] }],
        // A copy of a1: the same messages and times.
        ['a/a2', { message: [user('사과를 먹었다', 1), char('그래', 2), user('사과를 먹었다', 3)] }],
        ['b/b1', { message: [user('배를 먹었다', 5)] }],
        ['b/b2', null],
    ])
    const archivedChats = new Map<string, any>([
        ['z', [{ message: [user('귤을 먹었다', 9), char('고르세요', 10), user('봇이 넣은 말')] }]],
    ])
    return {
        characters: [{ chaId: 'a', chats: [{ id: 'a1' }, { id: 'a2' }] }, { chaId: 'b', chats: [{ id: 'b1' }, { id: 'b2' }] }],
        readChat: (chaId: string, chatId: string) => bodies.get(`${chaId}/${chatId}`) ?? null,
        archived: [{ chaId: 'z', archivedAt: 1 }, { chaId: 'gone', archivedAt: 2 }],
        readArchivedChats: async ({ chaId }: { chaId: string }) => archivedChats.get(chaId) ?? null,
    }
}
const words = (result: any) => Object.fromEntries(result.words)

describe('input word rank on the server', () => {
    test('its counting section is the plugin\'s, line for line', () => {
        const plugin = read('plugins/input-word-rank/input-word-rank.js')
        const fromPlugin = plugin.slice(plugin.indexOf('    const MAX_ENTRIES'), plugin.indexOf('    // ---------- reading chats ----------'))
            .split('\n').map((line) => line.replace(/^ {4}/, '')).join('\n').trimEnd()
        const server = read('server/node/input-word-rank.cjs')
        const start = server.indexOf('\n', server.indexOf('// ---------- SHARED with plugins/input-word-rank')) + 1
        const fromServer = server.slice(start, server.indexOf('// ---------- end of SHARED')).trimEnd()
        expect(fromPlugin.length).toBeGreaterThan(1000)
        expect(fromServer).toBe(fromPlugin)
    })

    test('every bot: a copied chat counts once, an unreadable chat is reported', async () => {
        const result = await rankInputWords({ ...setup(), body: { scope: 'all', particles: false } })
        expect(words(result)).toEqual({ 사과를: 2, 먹었다: 3, 배를: 1 })
        expect(result!.totals).toMatchObject({ bots: 2, deactivatedBots: 0, chats: 3, inputs: 3, copies: 2, failed: 1, stopped: false })
    })

    test('deactivated bots are read on request; a bot\'s own input and a missing row are told apart', async () => {
        const result = await rankInputWords({ ...setup(), body: { scope: 'all', deactivated: true, particles: false } })
        expect(words(result)).toEqual({ 사과를: 2, 먹었다: 4, 배를: 1, 귤을: 1 })
        expect(result!.totals).toMatchObject({ bots: 3, deactivatedBots: 1, botInputs: 1, failed: 2 })
        const kept = await rankInputWords({ ...setup(), body: { scope: 'all', deactivated: true, particles: false, botInputs: false } })
        expect(words(kept)).toMatchObject({ 봇이: 1, 넣은: 1, 말: 1 })
    })

    test('this bot and this chat; null when they are not active', async () => {
        const bot = await rankInputWords({ ...setup(), body: { scope: 'char', chaId: 'b', deactivated: true, particles: false } })
        expect(words(bot)).toEqual({ 배를: 1, 먹었다: 1 })
        expect(bot!.totals).toMatchObject({ bots: 1, chats: 1, failed: 1 })
        const chat = await rankInputWords({ ...setup(), body: { scope: 'chat', chaId: 'a', chatId: 'a2', particles: false } })
        expect(words(chat)).toEqual({ 사과를: 2, 먹었다: 2 })
        expect(await rankInputWords({ ...setup(), body: { scope: 'chat', chaId: 'a', chatId: 'nope' } })).toBeNull()
        expect(await rankInputWords({ ...setup(), body: { scope: 'char', chaId: 'z' } })).toBeNull()
    })

    test('a caller that leaves stops the count at the next bot', async () => {
        let calls = 0
        const result = await rankInputWords({ ...setup(), body: { scope: 'all', deactivated: true }, shouldStop: () => ++calls > 1 })
        expect(result!.totals).toMatchObject({ bots: 1, stopped: true, deactivatedBots: 0 })
    })

    test('requests get the plugin defaults and bounded values', () => {
        expect(readRequest(undefined)).toEqual({
            scope: 'char', chaId: '', chatId: '', deactivated: false, limit: 100,
            options: { particles: true, parens: false, english: false, botInputs: true, exclude: '' },
        })
        const odd = readRequest({ scope: 'everything', limit: 10_000, exclude: 'x'.repeat(20_000), particles: 0, deactivated: 'yes' })
        expect(odd).toMatchObject({ scope: 'char', limit: 500, deactivated: false, options: { particles: true } })
        expect(odd.options.exclude).toHaveLength(10_000)
    })
})
