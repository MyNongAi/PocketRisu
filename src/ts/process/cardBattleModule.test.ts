// @vitest-environment node
// The distributable 🃏 카드 전투 module (modules/card-battle), run through the
// app's own Lua engine with a stubbed chat, toggles, alerts and auxiliary model.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildModuleJson, readSource, TOGGLES } from '../../../modules/card-battle/build.mjs'
import { decodeRisum, encodeRisum, readMaps } from '../../../modules/scene-fold/build.mjs'

const toggles = new Map<string, string>()
const llmAnswers: string[] = []
const llmPrompts: { role: string, content: string }[][] = []
const alerts = vi.hoisted(() => ({ select: '0', confirm: true }))

vi.mock('../parser/parser.svelte', () => ({ hasher: vi.fn(), risuChatParser: vi.fn((text: string) => text) }))
vi.mock('../alert', () => ({
    alertConfirm: vi.fn(async () => alerts.confirm),
    alertError: vi.fn(),
    alertInput: vi.fn(),
    alertNormal: vi.fn(),
    alertSelect: vi.fn(async () => alerts.select),
}))
vi.mock('../globalApi.svelte', () => ({ fetchNative: vi.fn(), readImage: vi.fn() }))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn() }))
vi.mock('../util', () => ({
    asBuffer: vi.fn(),
    getPersonaPrompt: vi.fn(),
    getUserIcon: vi.fn(),
    getUserName: vi.fn(() => '레이'),
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
    ReloadGUIPointer: { subscribe: (run: (value: number) => void) => (run(0), () => undefined), set: vi.fn(), update: vi.fn() },
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
        state: (name: string) => JSON.parse(vars[`__${name}`] ?? 'null'),
        setState: (name: string, value: unknown) => { vars[`__${name}`] = JSON.stringify(value) },
        run: (mode: string, extra: { data?: any, meta?: object, probe?: string } = {}) => runScripted(
            extra.probe ? `${code}\n${extra.probe}` : code,
            {
                char: { type: 'character', chaId: 'c1', name: '세라', desc: '검사 세라.', chats: [chat], chatPage: 0 } as any,
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

async function probe(body: string) {
    const { run } = makeChat([])
    const result = await run('cbProbe', { probe: `function cbProbe(id)\n${body}\nend` })
    return JSON.parse(result.res as string)
}

beforeEach(() => {
    toggles.clear()
    llmAnswers.length = 0
    llmPrompts.length = 0
    alerts.select = '0'
    alerts.confirm = true
})

describe('the module file', () => {
    test('builds a .risum that reads back to the same module, low-level access on', () => {
        const maps = readMaps()
        const json = buildModuleJson(code)
        const back = decodeRisum(encodeRisum(json, maps.encode), maps.decode)
        expect(back).toEqual(json)
        expect(back.module.lowLevelAccess).toBe(true)
        expect(back.module.trigger[0].effect[0].type).toBe('triggerlua')
        expect(TOGGLES).toContain('cardbattle.cards=레벨업 카드 만드는 모델=select=보조 모델,메인 모델,기본 카드만')
    })
})

describe('cards', () => {
    test('keeps known effects in range and pays for them: the cost rises first, then the numbers fall', async () => {
        const result = await probe(`
            local fair = CB.cleanCard({ name = '번개 베기', effects = { dmg = 8, laser = 99 }, desc = '번쩍' }, { rarity = 'common', cost = 1 })
            local greedy = CB.cleanCard({ name = '천지개벽', effects = { dmg = 99, hits = 9, draw = 9 } }, { rarity = 'common', cost = 0 })
            local long = CB.cleanCard({ name = '아주아주아주아주아주긴카드이름', effects = { block = 5 } }, { rarity = 'rare', cost = 1 })
            return json.encode({
                fair = fair, greedy = greedy, greedyPoints = CB.points(greedy.fx), budget = CB.budget(greedy.cost, 'common'),
                long = long.name, empty = CB.cleanCard({ name = 'x', effects = { laser = 3 } }, nil) == nil,
                text = CB.effectText({ fx = { dmg = 4, hits = 2, vuln = 1 } }),
            })`)
        expect(result.fair).toEqual({ name: '번개 베기', cost: 1, fx: { dmg: 8 }, rarity: 'common', desc: '번쩍' })
        expect(result.greedy.cost).toBe(3)
        expect(result.greedy.fx.hits).toBe(4)
        expect(result.greedyPoints).toBeLessThanOrEqual(result.budget)
        expect([...result.long]).toHaveLength(14)
        expect(result.empty).toBe(true)
        expect(result.text).toBe('피해 4×2, 취약 1')
    })

    test('reads three cards from an answer with chatter, filling a slot it left out from the pool', async () => {
        const result = await probe(`
            local run = CB.newRun(7)
            local slots = { { rarity = 'common', cost = 1 }, { rarity = 'rare', cost = 2 }, { rarity = 'common', cost = 0 } }
            local cards, written = CB.parseCards(run, 'Here: [{"name":"세라의 응원","effects":{"str":1,"block":3}},{"name":"검무","effects":{"dmg":5,"hits":3}}] done', slots)
            return json.encode({ names = { cards[1].name, cards[2].name }, third = cards[3] ~= nil, written = written })`)
        expect(result).toEqual({ names: ['세라의 응원', '검무'], third: true, written: 2 })
    })
})

describe('the battle tag', () => {
    test('becomes a hidden start mark with its tier and name, and a log block is not a tag', async () => {
        const result = await probe(`
            local run = CB.newRun(3)
            local text, spec = CB.takeBattleTag('늑대가 달려든다!\\n<battle tier="elite" name="늑대 우두머리">', run)
            local same, none = CB.takeBattleTag('<battle-log>\\n승리\\n</battle-log>', run)
            local _, plain = CB.takeBattleTag('<battle>', run)
            return json.encode({ text = text, spec = spec, same = same, none = none == nil, plainTier = plain.tier })`)
        expect(result.text).toMatch(/^늑대가 달려든다!\n<!--cb:s:\w+-->$/)
        expect(result.spec).toMatchObject({ tier: 'elite', name: '늑대 우두머리' })
        expect(result.same).toBe('<battle-log>\n승리\n</battle-log>')
        expect(result.none).toBe(true)
        expect(result.plainTier).toBe('normal')
    })
})

describe('the fight', () => {
    test('a played card costs energy and hits through block; the enemy acts on its turn and block takes it', async () => {
        const result = await probe(`
            local run = CB.newRun(11)
            local b = CB.newBattle(run, { id = 'f1', name = '늑대', tier = 'normal' }, { healEach = true })
            local handSize = #b.hand
            b.cards[b.hand[1]] = CB.copy(CB.STRIKE)
            b.enemy.block = 2
            local hpBefore = b.enemy.hp
            CB.play(run, b, 1)
            local afterPlay = { energy = b.energy, enemyHp = hpBefore - b.enemy.hp, block = b.enemy.block, hand = #b.hand, discard = #b.discard }
            b.enemy.moves = { { atk = 10 } }
            b.enemy.step = 1
            b.block = 4
            CB.endTurn(run, b)
            return json.encode({ handSize = handSize, afterPlay = afterPlay, hp = b.hp, turn = b.turn, energy = b.energy, hand = #b.hand, block = b.block, log = b.log[1] })`)
        expect(result.handSize).toBe(5)
        expect(result.afterPlay).toEqual({ energy: 2, enemyHp: 4, block: 0, hand: 4, discard: 1 })
        expect(result.hp).toBe(54)
        expect(result).toMatchObject({ turn: 2, energy: 3, hand: 5, block: 0 })
        expect(result.log).toBe('1턴: 공격(피해 4 (막힘 2)) / 적: 공격 10 (막음 4, 받은 피해 6)')
    })

    test('vulnerable adds half, weak takes a quarter, and vulnerable put on the player lasts to the next enemy turn', async () => {
        const result = await probe(`
            local run = CB.newRun(5)
            local b = CB.newBattle(run, { id = 'f2', name = '', tier = 'normal' }, { healEach = true })
            local exposed = CB.attackDamage(6, b, { vuln = 1 })
            b.weak = 1
            local weakened = CB.attackDamage(8, b, {})
            b.weak = 0
            b.enemy.moves = { { vuln = 1 }, { atk = 10 } }
            b.enemy.step = 1
            CB.endTurn(run, b)
            local vulnAfterFirst = b.vuln
            CB.endTurn(run, b)
            return json.encode({ exposed = exposed, weakened = weakened, vulnAfterFirst = vulnAfterFirst, hp = b.hp, maxHp = b.maxHp, name = b.name })`)
        expect(result.exposed).toBe(9)
        expect(result.weakened).toBe(6)
        expect(result.vulnAfterFirst).toBe(1)
        expect(result.maxHp - result.hp).toBe(15)
        expect(result.name).toBe('적')
    })
})

describe('after a reply', () => {
    test('a battle tag asks to fight and, on yes, opens the fight', async () => {
        const { chat, run, state } = makeChat([
            { role: 'user', data: '숲으로 간다' },
            { role: 'char', data: '덤불에서 늑대가 튀어나온다.\n<battle tier="normal" name="굶주린 늑대">' },
        ])
        await run('output')
        expect(chat.message[1].data).toMatch(/^덤불에서 늑대가 튀어나온다.\n<!--cb:s:\w+-->$/)
        const b = state('cb_battle')
        expect(b).toMatchObject({ name: '굶주린 늑대', tier: 'normal', phase: 'fight', open: true, at: 2 })
        expect(b.hand).toHaveLength(5)
        expect(state('cb_run')).toMatchObject({ level: 1, hp: 60 })
    })

    test('"나중에" leaves the fight waiting, with a start card on the last message', async () => {
        alerts.select = '1'
        const { chat, run, state } = makeChat([{ role: 'char', data: '도적이 길을 막는다.\n<battle tier="boss" name="도적 두목">' }])
        await run('output')
        expect(state('cb_battle')).toBeNull()
        expect(state('cb_pending')).toMatchObject({ name: '도적 두목', tier: 'boss' })
        const shown = (await run('editDisplay', { data: chat.message[0].data, meta: { index: 0 } })).res as string
        expect(shown).toContain('risu-btn="cb|start"')
        expect(shown).not.toContain('<!--cb:')

        await run('onButtonClick', { data: 'cb|start' })
        expect(state('cb_pending')).toBe(false)
        expect(state('cb_battle')).toMatchObject({ name: '도적 두목', tier: 'boss', phase: 'fight' })
    })
})

describe('the window', () => {
    test('draws the fight over the chat on the last message only, and taps lift then play a card', async () => {
        const { chat, run, state } = makeChat([
            { role: 'user', data: '덤빈다' },
            { role: 'char', data: '고블린이 덤벼든다.\n<battle name="고블린">' },
        ])
        await run('output')
        const last = (await run('editDisplay', { data: chat.message[1].data, meta: { index: 1 } })).res as string
        expect(last).toContain('position:fixed')
        expect(last).toContain('risu-btn="cb|sel|1"')
        expect(last).toContain('고블린')
        const earlier = (await run('editDisplay', { data: chat.message[0].data, meta: { index: 0 } })).res as string
        expect(earlier).toBe('덤빈다')

        await run('onButtonClick', { data: 'cb|sel|1' })
        expect(state('cb_battle').selected).toBe(1)
        const lifted = (await run('editDisplay', { data: chat.message[1].data, meta: { index: 1 } })).res as string
        expect(lifted).toContain('risu-btn="cb|play|1"')
        await run('onButtonClick', { data: 'cb|play|1' })
        const b = state('cb_battle')
        expect(b.energy).toBe(2)
        expect(b.hand).toHaveLength(4)
        expect(b.selected).toBeUndefined()

        await run('onButtonClick', { data: 'cb|close' })
        const closed = (await run('editDisplay', { data: chat.message[1].data, meta: { index: 1 } })).res as string
        expect(closed).not.toContain('position:fixed')
        expect(closed).toContain('risu-btn="cb|open"')
    })
})

describe('the end of a fight', () => {
    function nearlyWon(setState: (name: string, value: unknown) => void) {
        setState('cb_run', { v: 1, seed: 9, level: 1, xp: 1, maxHp: 60, hp: 60, deck: [
            { name: '공격', cost: 1, fx: { dmg: 6 }, rarity: 'basic', desc: '' },
        ] })
        setState('cb_battle', {
            id: 'w1', at: 2, name: '고블린', tier: 'normal', phase: 'fight', open: true, turn: 3, energy: 3, maxEnergy: 3,
            cards: [{ name: '공격', cost: 1, fx: { dmg: 6 }, rarity: 'basic', desc: '' }], draw: [], hand: [1], discard: [],
            hp: 40, maxHp: 60, block: 0, str: 0, weak: 0, vuln: 0,
            enemy: { hp: 3, maxHp: 42, block: 0, str: 0, weak: 0, vuln: 0, moves: [{ atk: 7 }], step: 1, bonus: 0 },
            log: ['1턴: 공격(피해 6) / 적: 공격 7 (막음 0, 받은 피해 7)'], played: [], note: '',
        })
    }

    test('a win puts the log on the last message and a level up gets three cards from the auxiliary model', async () => {
        const { chat, run, state, setState } = makeChat([
            { role: 'user', data: '덤빈다' },
            { role: 'char', data: '고블린이 덤벼든다.\n<!--cb:s:w1-->' },
        ])
        nearlyWon(setState)
        llmAnswers.push('[{"name":"세라의 검무","effects":{"dmg":4,"hits":2}},{"name":"방패 밀치기","effects":{"block":6,"weak":1}},{"name":"숨 돌리기","effects":{"draw":1}}]')
        await run('onButtonClick', { data: 'cb|play|1' })

        expect(chat.message[1].data).toContain('<battle-log>\n⚔️ 고블린 (일반) — 승리, 3턴\n1턴: 공격(피해 6) / 적: 공격 7')
        expect(chat.message[1].data).toContain('결과: 레이 체력 45/65, 레벨 업 (Lv.2)\n</battle-log>')
        expect(state('cb_run')).toMatchObject({ level: 2, xp: 0, maxHp: 65, hp: 45 })
        expect(llmPrompts[0][1].content).toContain('# Story: 세라')
        const b = state('cb_battle')
        expect(b.phase).toBe('won')
        expect(b.reward.choices.map((c: { name: string }) => c.name)).toEqual(['세라의 검무', '방패 밀치기', '숨 돌리기'])

        const shown = (await run('editDisplay', { data: chat.message[1].data, meta: { index: 1 } })).res as string
        expect(shown).toContain('risu-btn="cb|pick|2"')
        expect(shown).toContain('<details')
        await run('onButtonClick', { data: 'cb|pick|2' })
        expect(state('cb_run').deck.at(-1).name).toBe('방패 밀치기')
        expect(state('cb_battle')).toMatchObject({ done: true, open: false })
    })

    test('with the main model writing cards, the next request asks for them and the reply\'s block is hidden and read', async () => {
        toggles.set('toggle_cardbattle.cards', '1')
        const { chat, run, state, setState } = makeChat([
            { role: 'user', data: '덤빈다' },
            { role: 'char', data: '고블린이 덤벼든다.\n<!--cb:s:w1-->' },
        ])
        nearlyWon(setState)
        await run('onButtonClick', { data: 'cb|play|1' })
        expect(llmPrompts).toHaveLength(0)
        expect(state('cb_battle').reward.waiting).toBe(true)

        chat.message.push({ role: 'user', data: '계속', time: 3 })
        const request = (await run('editRequest', { data: chat.message.map((m: Message) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.data })) })).res as { role: string, content: string }[]
        expect(request.map((m) => m.role)).toEqual(['user', 'assistant', 'system', 'user'])
        expect(request[1].content).not.toContain('<!--cb:')
        expect(request[1].content).toContain('<battle-log>')
        expect(request[2].content).toContain('<cards>')

        chat.message.push({ role: 'char', data: '세라가 검을 거둔다.\n<cards>[{"name":"승리의 미소","effects":{"heal":4}}]</cards>', time: 4 })
        await run('output')
        expect(chat.message[3].data).toBe('세라가 검을 거둔다.')
        const b = state('cb_battle')
        expect(b.reward.choices[0].name).toBe('승리의 미소')
        expect(b.reward.choices).toHaveLength(3)
        expect(b.open).toBe(true)
    })

    test('fleeing ends the fight without experience; a log image shows the fight as plain text', async () => {
        const { chat, run, state, setState } = makeChat([{ role: 'char', data: '고블린이 덤벼든다.\n<!--cb:s:w1-->' }])
        nearlyWon(setState)
        await run('onButtonClick', { data: 'cb|flee' })
        expect(state('cb_battle').phase).toBe('fled')
        expect(state('cb_run').xp).toBe(1)
        expect(chat.message[0].data).toContain('— 도망, 3턴')
        const capture = (await run('editDisplay', { data: chat.message[0].data, meta: { index: 0, logCapture: true } })).res as string
        expect(capture).toContain('⚔️ 고블린 (일반) — 도망, 3턴')
        expect(capture).not.toContain('<')
    })
})
