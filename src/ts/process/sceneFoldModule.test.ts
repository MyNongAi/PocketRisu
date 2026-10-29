// @vitest-environment node
// The distributable 📁 장면 접기 module (modules/scene-fold), run through the
// app's own Lua engine with a stubbed chat, toggles and auxiliary model.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildModuleJson, decodeRisum, encodeRisum, readMaps, readSource, TOGGLES } from '../../../modules/scene-fold/build.mjs'

const toggles = new Map<string, string>()
const llmAnswers: string[] = []
const llmPrompts: { role: string, content: string }[][] = []

vi.mock('../parser/parser.svelte', () => ({ hasher: vi.fn(), risuChatParser: vi.fn((text: string) => text) }))
vi.mock('../alert', () => ({
    alertConfirm: vi.fn(),
    alertError: vi.fn(),
    alertInput: vi.fn(),
    alertNormal: vi.fn(),
    alertSelect: vi.fn(async () => '0'),
}))
vi.mock('../globalApi.svelte', () => ({ fetchNative: vi.fn(), readImage: vi.fn() }))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn() }))
vi.mock('../util', () => ({
    asBuffer: vi.fn(),
    getPersonaPrompt: vi.fn(),
    getUserIcon: vi.fn(),
    getUserName: vi.fn(),
    parseKeyValue: () => [],
}))
vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(() => ({})),
    getCurrentChat: vi.fn(() => ({ message: [] })),
    getDatabase: vi.fn(() => ({ characters: [] })),
    setDatabase: vi.fn(),
}))
vi.mock('../stores.svelte', () => ({
    DBState: { db: {} },
    ReloadChatPointer: { update: vi.fn() },
    ReloadGUIPointer: { update: vi.fn() },
    selectedCharID: { subscribe: (run: (value: number) => void) => (run(0), () => undefined) },
}))
vi.mock('./modules', () => ({ getModuleLorebooks: vi.fn(() => []), getModuleTriggers: vi.fn(() => []) }))
vi.mock('./files/inlays', () => ({ getInlayAsset: vi.fn(), writeInlayImage: vi.fn() }))
vi.mock('./lorebook.svelte', () => ({ loadLoreBookV3Prompt: vi.fn() }))
vi.mock('./memory/hypamemory', () => ({ HypaProcesser: vi.fn() }))
vi.mock('./request/request', () => ({
    requestChatData: vi.fn(async (arg: { formated: { role: string, content: string }[] }) => {
        llmPrompts.push(arg.formated)
        const answer = llmAnswers.shift()
        return answer === undefined ? { type: 'fail', result: 'no answer' } : { type: 'success', result: answer }
    }),
}))
vi.mock('./stableDiff', () => ({ generateAIImage: vi.fn() }))
vi.mock('../parser/chatVar.svelte', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../parser/chatVar.svelte')>()),
    getGlobalChatVar: vi.fn((key: string) => toggles.get(key) ?? ''),
}))

let runScripted: typeof import('./scriptings').runScripted
let code: string

beforeAll(async () => {
    const jsonLua = await readFile(resolve(process.cwd(), 'public/lua/json.lua'), 'utf8')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(jsonLua, { status: 200 })))
    runScripted = (await import('./scriptings')).runScripted
    code = readSource()
})

type Message = { role: 'user' | 'char', data: string, time?: number }

function makeChat(messages: Message[]) {
    const vars: Record<string, string> = {}
    const chat = { message: messages.map((m, i) => ({ time: i + 1, ...m })), scriptstate: {} } as any
    return {
        chat,
        vars,
        run: (mode: string, extra: { data?: any, meta?: object, probe?: string } = {}) => runScripted(
            extra.probe ? `${code}\n${extra.probe}` : code,
            {
                char: { type: 'character', chaId: 'c1', chats: [chat], chatPage: 0 } as any,
                chat,
                data: extra.data,
                meta: extra.meta,
                mode,
                lowLevelAccess: true,
                setVar: (key: string, value: string) => { vars[key] = value },
                getVar: (key: string) => vars[key] ?? 'null',
            },
        ),
    }
}

beforeEach(() => {
    toggles.clear()
    llmAnswers.length = 0
    llmPrompts.length = 0
})

const marks = (text: string) => text.match(/<!--sf:[^>]*-->/g) ?? []

describe('the module file', () => {
    test('builds a .risum that reads back to the same module, low-level access on', () => {
        const maps = readMaps()
        const json = buildModuleJson(code)
        const back = decodeRisum(encodeRisum(json, maps.encode), maps.decode)
        expect(back).toEqual(json)
        expect(back.type).toBe('risuModule')
        expect(back.module.lowLevelAccess).toBe(true)
        expect(back.module.trigger[0].effect[0].type).toBe('triggerlua')
        // each kind is its own toggle, the default first
        expect(TOGGLES).toContain('scenefold.battle=⚔️ 배틀 (전투·던전·게이트·탐험·대련·미니게임·도박)=select=켬,끔')
        expect(TOGGLES).toContain('scenefold.nsfw=🔞 NSFW=select=끔,켬')
        expect(TOGGLES).toContain('scenefold.custom=✏️ 사용자 정의=select=끔,켬')
    })
})

describe('marks and scenes', () => {
    test('pairs start and end marks, keeps an unpaired start open, strips every mark and token', async () => {
        const { run } = makeChat([])
        const probe = `function sfProbe(id)
            local messages = {
                { role = 'user', data = 'go' },
                { role = 'char', data = 'fight' .. SF.startMark('battle', 'a1') },
                { role = 'user', data = 'hit' },
                { role = 'char', data = 'won' .. SF.endMark('a1') },
                { role = 'char', data = 'later' .. SF.startMark('nsfw', 'b2') },
            }
            local scenes = SF.scenes(messages)
            return json.encode({
                count = #scenes, s = scenes[1].s, e = scenes[1].e, openId = SF.openScene(scenes).id,
                after = SF.repliesAfter(messages, 4),
                stripped = SF.strip('text\\n<!--sf:s:battle:a1-->\\n[[SCENE START: battle]]\\nmore\\n[[scene end]]'),
                dropped = SF.scenes({ { role = 'char', data = SF.endMark('zz') } })[1] == nil,
            })
        end`
        const result = JSON.parse((await run('sfProbe', { probe })).res)
        expect(result).toMatchObject({ count: 2, s: 2, e: 4, openId: 'b2', after: 1, dropped: true })
        expect(result.stripped).toBe('text\nmore')
    })

    test('reads a judge answer even with chatter around it, and nothing from junk', async () => {
        const { run } = makeChat([])
        const probe = `function sfProbe(id)
            local a, b = SF.parseJudge('Sure! {"event": "START", "kind":"battle"} ok')
            local c = SF.parseJudge('no json here')
            local d = SF.parseJudge(nil)
            return json.encode({ a = a, b = b, c = c, d = d })
        end`
        expect(JSON.parse((await run('sfProbe', { probe })).res)).toEqual({ a: 'start', b: 'battle', c: 'none', d: 'none' })
    })
})

describe('after a reply (auxiliary model)', () => {
    test('marks where a battle starts and ends, then folds it after the grace replies', async () => {
        const { chat, run, vars } = makeChat([
            { role: 'user', data: 'Let us battle!' },
            { role: 'char', data: 'The battle begins. Pikachu uses Thunderbolt.' },
        ])
        llmAnswers.push('{"event":"start","kind":"battle"}')
        await run('output')
        expect(marks(chat.message[1].data)).toEqual([expect.stringMatching(/^<!--sf:s:battle:\w+-->$/)])
        expect(llmPrompts[0][1].content).toContain('battle: any contest with a start and an outcome')

        chat.message.push({ role: 'user', data: 'Again!', time: 3 }, { role: 'char', data: 'Pikachu wins and gets 300P.', time: 4 })
        llmAnswers.push('{"event":"end","kind":"battle"}')
        await run('output')
        const id = marks(chat.message[1].data)[0].match(/:(\w+)-->/)![1]
        expect(marks(chat.message[3].data)).toEqual([`<!--sf:e:${id}-->`])

        // grace 2: one reply later nothing folds, two later the summary is made
        chat.message.push({ role: 'char', data: 'They walk on.', time: 5 })
        llmAnswers.push('{"event":"none"}')
        await run('output')
        expect(vars[`__sf_sum_${id}`]).toBeUndefined()

        chat.message.push({ role: 'char', data: 'They reach town.', time: 6 })
        llmAnswers.push('{"event":"none"}', 'Pikachu beat the rival.\nGot 300P.')
        await run('output')
        expect(JSON.parse(vars[`__sf_sum_${id}`])).toBe('Pikachu beat the rival.\nGot 300P.')
        expect(marks(chat.message[2].data)).toEqual([`<!--sf:m:${id}-->`])
        expect(llmPrompts.at(-1)![1].content).toContain('Keep: who took part and why')
        // for the request regex: the summary goes where the fold mark is, the rest go
        expect(marks(chat.message[1].data)).toEqual([`<!--sf:s:battle:${id}-->`, `<!--sf:f:battle:${id}-->`])
        expect(marks(chat.message[3].data)).toEqual([`<!--sf:e:${id}-->`, `<!--sf:m:${id}-->`])
        expect(vars[`sf_text_${id}`]).toBe('[Folded scene · battle] The full text of this finished scene was left out; this is what happened:\nPikachu beat the rival.\nGot 300P.')
    })

    test('does nothing for a kind that is off, and asks nothing with every kind off', async () => {
        const { chat, run } = makeChat([{ role: 'user', data: 'x' }, { role: 'char', data: 'An intimate scene.' }])
        llmAnswers.push('{"event":"start","kind":"nsfw"}')
        await run('output')
        expect(marks(chat.message[1].data)).toEqual([])

        toggles.set('toggle_scenefold.battle', '1')
        llmAnswers.length = 0
        llmPrompts.length = 0
        await run('output')
        expect(llmPrompts).toHaveLength(0)
    })

    test('keeps a failed summary unfolded and remembers the failure', async () => {
        const { chat, run, vars } = makeChat([
            { role: 'char', data: 'fight<!--sf:s:battle:f1-->' },
            { role: 'char', data: 'won<!--sf:e:f1-->' },
            { role: 'char', data: 'a' },
            { role: 'char', data: 'b' },
        ])
        llmAnswers.push('{"event":"none"}')
        await run('output')
        expect(vars.__sf_sum_f1).toBeUndefined()
        expect(vars.__sf_fail_f1).toBe('true')
        expect(chat.message[0].data).toContain('<!--sf:s:battle:f1-->')
    })
})

describe('원문 잘라내기 (off by default, 비권장)', () => {
    const closed = (): Message[] => [
        { role: 'user', data: 'hi' },
        { role: 'char', data: 'fight<!--sf:s:battle:c1-->' },
        { role: 'user', data: 'hit' },
        { role: 'char', data: 'won<!--sf:e:c1-->' },
        { role: 'char', data: 'a' },
        { role: 'char', data: 'b' },
    ]

    test('stays off unless chosen: the chat keeps every message', async () => {
        const { chat, run } = makeChat(closed())
        llmAnswers.push('{"event":"none"}', 'Won.')
        await run('output')
        expect(chat.message).toHaveLength(6)
    })

    test('replaces the folded scene with one summary message, sends it as the summary, and 되돌리기 brings the originals back', async () => {
        toggles.set('toggle_scenefold.cut', '1')
        const { run, vars } = makeChat(closed())
        llmAnswers.push('{"event":"none"}', 'Won the fight.')
        let chat = (await run('output')).chat as any
        expect(chat.message.map((m: Message) => m.data)).toEqual(['hi', 'Won the fight.\n<!--sf:c:battle:c1-->', 'a', 'b'])
        expect(JSON.parse(vars.__sf_cut_c1)).toEqual([
            { role: 'char', data: 'fight<!--sf:s:battle:c1-->\n<!--sf:f:battle:c1-->' },
            { role: 'user', data: 'hit\n<!--sf:m:c1-->' },
            { role: 'char', data: 'won<!--sf:e:c1-->\n<!--sf:m:c1-->' },
        ])

        const request = (await run('editRequest', { data: chat.message.map((m: Message) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.data })) })).res as { role: string, content: string }[]
        expect(request.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'assistant'])
        expect(request[1].content).toContain('[Folded scene · battle]')
        expect(request[1].content).toContain('Won the fight.')
        expect(request[1].content).not.toContain('<!--')

        const card = (await run('editDisplay', { data: chat.message[1].data, meta: { index: 1 } })).res as string
        expect(card).toContain('✂️ 잘라낸 장면 · ⚔️ 배틀 · 원문 3개 보관 중')
        expect(card).toContain('risu-btn="sf|v|c1"')

        chat = (await run('onButtonClick', { data: 'sf|v|c1' })).chat as any
        expect(chat.message.map((m: Message) => m.data)).toEqual(['hi', 'fight<!--sf:s:battle:c1-->\n<!--sf:f:battle:c1-->', 'hit\n<!--sf:m:c1-->', 'won<!--sf:e:c1-->\n<!--sf:m:c1-->', 'a', 'b'])
        // not cut again on the next reply; still folded in requests
        llmAnswers.push('{"event":"none"}')
        chat = (await run('output')).chat as any
        expect(chat.message).toHaveLength(6)
    })
})

describe('after a reply (main model anchors)', () => {
    test('turns the written tokens into hidden marks', async () => {
        toggles.set('toggle_scenefold.mode', '1')
        const { chat, run } = makeChat([
            { role: 'user', data: 'fight' },
            { role: 'char', data: 'Ready.\n[[SCENE START: battle]]\nThey clash.\n[[SCENE END]]\nDone.' },
        ])
        await run('output')
        const text = chat.message[1].data
        expect(text).not.toContain('[[SCENE')
        expect(marks(text)).toHaveLength(2)
        expect(text).toMatch(/^Ready\.\nThey clash\.\nDone\.\n<!--sf:s:battle:(\w+)--><!--sf:e:\1-->$/)
    })
})

describe('the request', () => {
    const folded = (): Message[] => [
        { role: 'user', data: 'hi' },
        { role: 'char', data: 'fight<!--sf:s:battle:k1-->' },
        { role: 'user', data: 'hit<!--sf:m:k1-->' },
        { role: 'char', data: 'won<!--sf:e:k1-->' },
        { role: 'char', data: 'next' },
        { role: 'char', data: 'later' },
    ]

    test('puts the summary where the folded scene was and strips every mark', async () => {
        const { run, vars } = makeChat(folded())
        vars.__sf_sum_k1 = JSON.stringify('Won the battle.')
        const request = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'fight<!--sf:s:battle:k1-->' },
            { role: 'system', content: 'depth note' },
            { role: 'user', content: 'hit<!--sf:m:k1-->' },
            { role: 'assistant', content: 'won<!--sf:e:k1-->' },
            { role: 'assistant', content: 'next<!--sf:s:battle:zz-->' },
        ]
        const result = (await run('editRequest', { data: request })).res as { role: string, content: string }[]
        expect(result.map((m) => m.content)).toEqual([
            'sys',
            'hi',
            expect.stringContaining('[Folded scene · battle]'),
            'depth note',
            'next',
        ])
        expect(result[2].content).toContain('Won the battle.')
    })

    test('inserts nothing when the folded scene is not in the request (moved to memory)', async () => {
        const { run, vars } = makeChat(folded())
        vars.__sf_sum_k1 = JSON.stringify('Won.')
        const request = [{ role: 'system', content: 'memory' }, { role: 'assistant', content: 'later' }]
        const result = (await run('editRequest', { data: request })).res as { content: string }[]
        expect(result.map((m) => m.content)).toEqual(['memory', 'later'])
    })

    test('leaves a scene alone until its summary exists, and keeps a message shared with the next scene', async () => {
        const { run, vars } = makeChat(folded())
        let result = (await run('editRequest', { data: [{ role: 'assistant', content: 'won<!--sf:e:k1-->' }] })).res as { content: string }[]
        expect(result.map((m) => m.content)).toEqual(['won'])

        vars.__sf_sum_k1 = JSON.stringify('Won.')
        result = (await run('editRequest', { data: [{ role: 'assistant', content: 'won<!--sf:e:k1--><!--sf:s:battle:k2-->' }] })).res as { content: string }[]
        expect(result.map((m) => m.content)).toEqual(['won'])
    })

    test('asks the main model for markers in its anchor mode', async () => {
        toggles.set('toggle_scenefold.mode', '1')
        const { run } = makeChat([{ role: 'user', data: 'x' }])
        const result = (await run('editRequest', { data: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'x' }] })).res as { role: string, content: string }[]
        expect(result.map((m) => m.role)).toEqual(['system', 'system', 'user'])
        expect(result[1].content).toContain('[[SCENE START: kind]]')
    })
})

describe('display and buttons', () => {
    const scene = (): Message[] => [
        { role: 'user', data: 'hi' },
        { role: 'char', data: 'fight<!--sf:s:battle:d1-->' },
        { role: 'user', data: 'hit<!--sf:m:d1-->' },
        { role: 'char', data: 'won<!--sf:e:d1-->' },
        { role: 'char', data: 'a' },
        { role: 'char', data: 'b' },
    ]

    test('shows a summary card on the first folded message and a stub on the rest', async () => {
        const { run, vars } = makeChat(scene())
        vars.__sf_sum_d1 = JSON.stringify('Won <the> battle.\nGot 300P.')
        const first = (await run('editDisplay', { data: 'fight<!--sf:s:battle:d1-->', meta: { index: 1 } })).res as string
        expect(first).toContain('📁 접힌 장면 · ⚔️ 배틀 · 메시지 3개')
        expect(first).toContain('Won &lt;the&gt; battle.<br>Got 300P.')
        expect(first).toContain('risu-btn="sf|x|d1"')
        expect(first).not.toContain('fight')
        const middle = (await run('editDisplay', { data: 'hit<!--sf:m:d1-->', meta: { index: 2 } })).res as string
        expect(middle).toContain('접힌 장면의 일부')
        const outside = (await run('editDisplay', { data: 'a', meta: { index: 4 } })).res as string
        expect(outside).toContain('risu-btn="sf|s|4"')
        expect(outside.startsWith('a')).toBe(true)
    })

    test('펼치기 shows the original under the card', async () => {
        const { run, vars } = makeChat(scene())
        vars.__sf_sum_d1 = JSON.stringify('Won.')
        await run('onButtonClick', { data: 'sf|x|d1' })
        const first = (await run('editDisplay', { data: 'fight<!--sf:s:battle:d1-->', meta: { index: 1 } })).res as string
        expect(first).toContain('>접기<')
        expect(first).toContain('fight')
        expect(first).not.toContain('<!--sf')
    })

    test('manual start and end mark the chosen messages; 접기 해제 removes the scene', async () => {
        const { chat, run, vars } = makeChat([
            { role: 'user', data: 'u1' },
            { role: 'char', data: 'c1' },
            { role: 'char', data: 'c2' },
            { role: 'char', data: 'c3' },
            { role: 'char', data: 'c4' },
        ])
        llmAnswers.push('Manual summary.')
        await run('onButtonClick', { data: 'sf|s|1' })
        const id = marks(chat.message[1].data)[0].match(/:(\w+)-->/)![1]
        await run('onButtonClick', { data: 'sf|e|2' })
        // folded at once, so the end message also carries a member mark
        expect(marks(chat.message[2].data)).toEqual([`<!--sf:e:${id}-->`, `<!--sf:m:${id}-->`])
        // two replies after the end already: folded at once
        expect(JSON.parse(vars[`__sf_sum_${id}`])).toBe('Manual summary.')

        await run('onButtonClick', { data: `sf|u|${id}` })
        expect(chat.message.map((m: Message) => marks(m.data).length)).toEqual([0, 0, 0, 0, 0])
    })
})

describe('🔁 회차 (a time-loop run)', () => {
    beforeEach(() => {
        toggles.set('toggle_scenefold.loop', '1')
        toggles.set('toggle_scenefold.loopHero', 'Subaru')
    })

    const none = '{"event":"none","loop":false}'

    test('a death closes the run from its start, ends an open battle there, and the run folds over its battle', async () => {
        const { chat, run, vars } = makeChat([
            { role: 'user', data: 'hi' },
            { role: 'char', data: 'Elsa attacks.<!--sf:s:battle:b1-->' },
            { role: 'user', data: 'run' },
            { role: 'char', data: 'Subaru is killed. He wakes at the apple stand.' },
        ])
        llmAnswers.push('{"event":"none","kind":"battle","loop":true}')
        await run('output')
        expect(llmPrompts[0][1].content).toContain('Time loop: Subaru dies')
        expect(llmPrompts[0][1].content).toContain('"loop":false')
        const runId = marks(chat.message[0].data)[0].match(/^<!--sf:s:loop:(\w+)-->$/)![1]
        expect(marks(chat.message[3].data)).toEqual(['<!--sf:e:b1-->', `<!--sf:e:${runId}-->`])

        chat.message.push({ role: 'char', data: 'He is confused.', time: 5 })
        llmAnswers.push(none)
        await run('output')
        chat.message.push({ role: 'char', data: 'He meets Emilia again.', time: 6 })
        // grace done for both: the battle inside is summarized first
        llmAnswers.push(none, 'Elsa ambushed Subaru.')
        await run('output')
        expect(JSON.parse(vars.__sf_sum_b1)).toBe('Elsa ambushed Subaru.')
        expect(vars[`__sf_sum_${runId}`]).toBeUndefined()
        // the death message is also in the run, not folded yet: it keeps its text
        expect(marks(chat.message[3].data)).toEqual(['<!--sf:e:b1-->', `<!--sf:e:${runId}-->`])

        chat.message.push({ role: 'char', data: 'Day two.', time: 7 })
        llmAnswers.push(none, 'Run 1: Elsa killed Subaru at the loot house.')
        await run('output')
        const prompt = llmPrompts.at(-1)![1].content
        expect(prompt).toContain('This is run 1 of a time-loop story')
        expect(prompt).toContain('[folded battle] Elsa ambushed Subaru.')
        expect(prompt).not.toContain('Elsa attacks.')
        expect(marks(chat.message[0].data)).toEqual([`<!--sf:s:loop:${runId}-->`, `<!--sf:f:loop:${runId}-->`])
        for (const i of [1, 2, 3]) expect(marks(chat.message[i].data)).toContain(`<!--sf:m:${runId}-->`)
        expect(vars[`sf_text_${runId}`]).toContain('[Undone run 1 · only Subaru remembers]')
        expect(vars[`sf_text_${runId}`]).toContain('Run 1: Elsa killed Subaru at the loot house.')

        // the next death starts run 2 after it, with run 1 as context
        chat.message.push({ role: 'char', data: 'Subaru dies again.', time: 8 })
        llmAnswers.push('{"event":"none","loop":true}')
        await run('output')
        const second = (marks(chat.message[4].data) as string[]).find((m) => m.startsWith('<!--sf:s:loop:'))!.match(/:(\w+)-->$/)![1]
        expect(marks(chat.message[7].data)).toEqual([`<!--sf:e:${second}-->`])
        chat.message.push({ role: 'char', data: 'a', time: 9 }, { role: 'char', data: 'b', time: 10 })
        llmAnswers.push(none, 'Run 2 record.')
        await run('output')
        expect(llmPrompts.at(-1)![1].content).toContain('This is run 2')
        expect(llmPrompts.at(-1)![1].content).toContain('Run 1:\nRun 1: Elsa killed Subaru at the loot house.')

        const card = (await run('editDisplay', { data: chat.message[0].data, meta: { index: 0 } })).res as string
        expect(card).toContain('🔁 지나간 회차 · 🔁 1회차 · 메시지 4개')
        const inside = (await run('editDisplay', { data: chat.message[2].data, meta: { index: 2 } })).res as string
        expect(inside).toContain('지나간 회차의 일부')
    })

    test('a long run is noted part by part, then recorded from the notes', async () => {
        const long = 'x'.repeat(40)
        const { run } = makeChat([
            { role: 'user', data: long + '<!--sf:s:loop:r1-->' },
            { role: 'char', data: long },
            { role: 'char', data: long + '<!--sf:e:r1-->' },
            { role: 'char', data: 'a' },
            { role: 'char', data: 'b' },
        ])
        llmAnswers.push(none, 'note one', 'note two', 'note three', 'The record.')
        await run('output', { probe: 'SF.RUN_PART = 60' })
        const asked = llmPrompts.map((p) => p[1].content)
        expect(asked.filter((c) => c.startsWith('Part '))).toHaveLength(3)
        expect(asked.at(-1)).toContain('Notes on this run, part by part:\n(1) note one')
    })

    test('여기서 회차 끝 ends the run at a message; a message of an earlier run says so', async () => {
        const { chat, run } = makeChat([
            { role: 'user', data: 'u1' },
            { role: 'char', data: 'c1' },
            { role: 'char', data: 'c2' },
            { role: 'char', data: 'c3' },
        ])
        await run('onButtonClick', { data: 'sf|d|2' })
        const id = marks(chat.message[0].data)[0].match(/^<!--sf:s:loop:(\w+)-->$/)![1]
        expect(marks(chat.message[2].data)).toEqual([`<!--sf:e:${id}-->`])
        await run('onButtonClick', { data: 'sf|d|1' })
        expect(marks(chat.message[1].data)).toEqual([])
        const bar = (await run('editDisplay', { data: 'c3', meta: { index: 3 } })).res as string
        expect(bar).toContain('risu-btn="sf|d|3"')
    })

    test('a run whose death reply was rerolled away loses its start mark', async () => {
        const { chat, run } = makeChat([
            { role: 'user', data: 'u1<!--sf:s:loop:zz-->' },
            { role: 'char', data: 'c1' },
        ])
        llmAnswers.push(none)
        await run('output')
        expect(chat.message[0].data).toBe('u1')
    })
})

describe('the request without long-term memory reading folded scenes', () => {
    test('drops the messages the request regex emptied, unless 요청에서만 접기 is chosen', async () => {
        const { run } = makeChat([{ role: 'user', data: 'x' }])
        const request = [{ role: 'user', content: 'x' }, { role: 'assistant', content: '' }, { role: 'assistant', content: 'y' }]
        let result = (await run('editRequest', { data: request })).res as { content: string }[]
        expect(result.map((m) => m.content)).toEqual(['x', 'y'])
        toggles.set('toggle_scenefold.cut', '2')
        result = (await run('editRequest', { data: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '' }] })).res as { content: string }[]
        expect(result.map((m) => m.content)).toEqual(['x', ''])
    })

    test('ships the two request regexes, and the choice that turns them off', () => {
        const json = buildModuleJson(code)
        expect(json.module.regex.map((r: { type: string, flag: string }) => [r.type, r.flag])).toEqual([['editprocess', 'g<cbs>'], ['editprocess', 'g<cbs>']])
        expect(TOGGLES).toContain('scenefold.cut=접은 장면 처리=select=요청에서 빼기 (장기 기억 전),원문 잘라내기 (비권장·렉 감소),요청에서만 접기 (장기 기억은 원문)')
        expect(TOGGLES).toContain('scenefold.loop=🔁 회차 (죽으면 시간이 되돌아가는 회귀물)=select=끔,켬')
    })
})
