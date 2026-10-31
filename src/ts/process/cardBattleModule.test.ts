// @vitest-environment node
// The distributable 🃏 카드 전투 module (modules/card-battle), run through the
// app's own Lua engine with a stubbed chat, toggles, alerts and auxiliary model.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildModuleJson, readSource, TOGGLES } from '../../../modules/card-battle/build.mjs'
import { decodeRisum, encodeRisum, readMaps } from '../../../modules/scene-fold/build.mjs'
import { ReloadChatPointer } from '../stores.svelte'

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

type Message = { role: 'user' | 'char', data: string, time?: number, swipes?: string[], swipeId?: number }

function makeChat(messages: Message[]) {
    const vars: Record<string, string> = {}
    const chat = { message: messages.map((m, i) => ({ time: i + 1, ...m })), scriptstate: {} } as any
    // Scenes do not wait here (CB.pause), unless a test asks for a pace.
    const run = (mode: string, extra: { data?: any, meta?: object, probe?: string, pace?: number } = {}) => runScripted(
        `${code}\nCB.PACE_SCALE = ${extra.pace ?? 0}${extra.probe ? `\n${extra.probe}` : ''}`,
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
    )
    return {
        chat,
        vars,
        run,
        state: (name: string) => JSON.parse(vars[`__${name}`] ?? 'null'),
        setState: (name: string, value: unknown) => { vars[`__${name}`] = JSON.stringify(value) },
        /** What the module reads from this chat as it stands. */
        lua: async (body: string) => JSON.parse((await run('cbProbe', { probe: `function cbProbe(id)\n${body}\nend` })).res as string),
        shown: async (index: number) => (await run('editDisplay', { data: chat.message[index].data, meta: { index } })).res as string,
    }
}

async function probe(body: string) {
    return makeChat([]).lua(body)
}

/** A hidden mark as the module writes it (CB.packMark). */
function packMark(kind: string, value: unknown) {
    const body = JSON.stringify(value).replace(/[%\-<>{}"\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
    return `<!--cb:${kind}:${body}-->`
}

/** The last mark of this kind in a message, read back (CB.readMark). */
function mark(text: string, kind: string) {
    const found = [...text.matchAll(new RegExp(`<!--cb:${kind}:([^>]*)-->`, 'g'))].at(-1)
    if (!found) return null
    return JSON.parse(found[1].replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))))
}

beforeEach(() => {
    toggles.clear()
    // The tests from before 0.6 play as 0.5 did: the fight told once at the
    // end, no signature card, no enemy taken. Those that need them set them.
    toggles.set('toggle_cardbattle.tell', '1')
    toggles.set('toggle_cardbattle.sig', '2')
    toggles.set('toggle_cardbattle.capture', '1')
    llmAnswers.length = 0
    llmPrompts.length = 0
    alerts.select = '0'
    alerts.confirm = true
    vi.mocked(ReloadChatPointer.update).mockReset()
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
        // Turn by turn comes first (the default), under a key 0.5 did not use.
        expect(TOGGLES).toContain('cardbattle.tell=전투 이야기=select=턴마다,끝나고 한 번에')
        expect(TOGGLES).not.toContain('cardbattle.story')
        expect(TOGGLES).toContain('cardbattle.fx=전투 연출=select=보통,빠르게,끄기')
        expect(TOGGLES).toContain('cardbattle.sig=대표 카드=select=AI가 만들기,직접 만들기,없음')
        expect(TOGGLES).toContain('cardbattle.capture=이긴 적 카드=select=받을지 고르기,안 받기')
        // Every caption and option list parses: no '=' inside a text.
        for (const line of TOGGLES.split('\n')) {
            if (line.endsWith('=caption')) expect(line.slice(1, -'=caption'.length)).not.toContain('=')
        }
    })

    test('its request regex takes the hidden marks out of every message before long-term memory reads them', () => {
        const [regex] = buildModuleJson(code).module.regex
        expect(regex.type).toBe('editprocess')
        const text = `이야기.\n<battle-log>\n승리\n</battle-log>\n${packMark('r', { level: 2 })}\n${packMark('b', { id: 'a', phase: 'won' })}`
        expect(text.replace(new RegExp(regex.in, regex.flag), regex.out)).toBe('이야기.\n<battle-log>\n승리\n</battle-log>')
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

describe('hidden marks', () => {
    test('hold any card text without ending the comment or starting a template, and one of a kind replaces the last', async () => {
        const result = await probe(`
            local card = { name = '-->{{user}}"\\\\%', desc = '끝 --> <b>' }
            local text = CB.writeMark('본문  ', 'r', { level = 1, deck = { card } })
            local again = CB.writeMark(text, 'r', { level = 2, deck = {} })
            return json.encode({ text = text, back = CB.readMark(text, 'r'), again = CB.readMark(again, 'r'), marks = select(2, again:gsub('<!%-%-cb:r:', '')),
                gone = CB.writeMark(again, 'r', nil), stripped = CB.stripMarks(again) })`)
        expect(result.text.startsWith('본문\n<!--cb:r:')).toBe(true)
        expect(result.text.indexOf('-->')).toBe(result.text.length - 3)
        expect(result.text.slice('본문\n<!--cb:r:'.length, -3)).not.toMatch(/[{}"\\<>-]/)
        expect(result.back.deck[0]).toEqual({ name: '-->{{user}}"\\%', desc: '끝 --> <b>' })
        expect(result.again).toEqual({ level: 2, deck: [] })
        expect(result.marks).toBe(1)
        expect(result.gone).toBe('본문')
        expect(result.stripped).toBe('본문')
    })
})

describe('the battle tag', () => {
    test('is taken out of the reply as a fight waiting to start, and a log block is not a tag', async () => {
        const result = await probe(`
            local text, spec = CB.takeBattleTag('늑대가 달려든다!\\n<battle tier="elite" name="늑대 우두머리">')
            local same, none = CB.takeBattleTag('<battle-log>\\n승리\\n</battle-log>')
            local _, plain = CB.takeBattleTag('<battle>')
            return json.encode({ text = text, spec = spec, same = same, none = none == nil, plainTier = plain.tier })`)
        expect(result.text).toBe('늑대가 달려든다!')
        expect(result.spec).toMatchObject({ tier: 'elite', name: '늑대 우두머리', phase: 'pending' })
        expect(result.spec.id).toMatch(/^[0-9a-f]{8}$/)
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
            CB.play(b, 1)
            local afterPlay = { energy = b.energy, enemyHp = hpBefore - b.enemy.hp, block = b.enemy.block, hand = #b.hand, discard = #b.discard }
            b.enemy.moves = { { atk = 10 } }
            b.enemy.step = 1
            b.block = 4
            CB.endTurn(b)
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
            CB.endTurn(b)
            local vulnAfterFirst = b.vuln
            CB.endTurn(b)
            return json.encode({ exposed = exposed, weakened = weakened, vulnAfterFirst = vulnAfterFirst, hp = b.hp, maxHp = b.maxHp, name = b.name })`)
        expect(result.exposed).toBe(9)
        expect(result.weakened).toBe(6)
        expect(result.vulnAfterFirst).toBe(1)
        expect(result.maxHp - result.hp).toBe(15)
        expect(result.name).toBe('적')
    })
})

describe('more effects', () => {
    // A fight against a dummy that only defends, and a hand of given cards.
    const setup = `
        local function fresh()
            local b = CB.newBattle(CB.newRun(3), { id = 'x', name = '', tier = 'normal' }, { healEach = true })
            b.enemy.hp, b.enemy.maxHp, b.enemy.block, b.enemy.bonus = 100, 100, 0, 0
            b.enemy.moves, b.enemy.step = { { def = 1 } }, 1
            return b
        end
        local function deal(b, cards)
            b.cards = cards
            b.hand, b.draw, b.discard, b.energy = {}, {}, {}, 3
            for i = 1, #cards do b.hand[i] = i end
        end`

    test('cards keep only what the module plays: keywords need a real effect, exhaust and hit points pay, every pool card fits its cost', async () => {
        const result = await probe(`
            local flagsOnly = CB.cleanCard({ name = '말뿐', effects = { retain = true, exhaust = true, pierce = true } }, { rarity = 'common', cost = 1 })
            local noDamage = CB.cleanCard({ name = '방패 찌르기', effects = { block = 5, pierce = true, drain = 'true' } }, { rarity = 'common', cost = 1 })
            local last = CB.cleanCard({ name = '최후', effects = { dmg = 22, exhaust = 1 } }, { rarity = 'epic', cost = 1 })
            local notLast = CB.cleanCard({ name = '최후', effects = { dmg = 22 } }, { rarity = 'epic', cost = 1 })
            local paid = CB.cleanCard({ name = '피값', effects = { dmg = 40, hpCost = 12 } }, { rarity = 'common', cost = 0 })
            local changed = {}
            for rarity, list in pairs(CB.POOL) do
                for _, card in ipairs(list) do
                    local c = CB.cleanCard(card, { rarity = rarity, cost = card.cost })
                    if not c or c.cost ~= card.cost or CB.effectText(c) ~= CB.effectText(card) then changed[#changed + 1] = card.name end
                end
            end
            return json.encode({
                flagsOnly = flagsOnly == nil, noDamage = noDamage.fx, last = { cost = last.cost, dmg = last.fx.dmg }, notLast = notLast.cost,
                paid = { cost = paid.cost, dmg = paid.fx.dmg, hpCost = paid.fx.hpCost }, changed = changed, rules = CB.CARD_RULES,
                text = CB.effectText({ fx = { hpCost = 3, dmg = 12, pierce = 1, drain = 1, retain = 1, exhaust = 1 } }),
                more = CB.effectText({ fx = { poison = 5, thorns = 2, armor = 3, dex = 1, charge = 1, prepare = 2 } }),
            })`)
        expect(result.flagsOnly).toBe(true)
        expect(result.noDamage).toEqual({ block: 5 })
        expect(result.last).toEqual({ cost: 1, dmg: 22 })
        expect(result.notLast).toBe(2)
        expect(result.paid).toEqual({ cost: 3, dmg: 34, hpCost: 12 })
        expect(result.changed).toEqual([])
        expect(result.rules).toContain('poison =')
        expect(result.rules).toContain('exhaust =')
        expect(result.text).toBe('체력 3 소모, 피해 12 (방어 무시) (흡혈), 보존, 소멸')
        expect(result.more).toBe('독 5, 민첩 +1, 가시 2, 매 턴 방어 3, 다음 턴 에너지 +1, 다음 턴 2장 더')
    })

    test('poison takes its due at the start of its bearer\'s turn, thorns prick every hit, armor blocks the enemy\'s turn', async () => {
        const result = await probe(`${setup}
            local p = fresh() p.enemy.poison = 4 CB.endTurn(p)
            local k = fresh() k.enemy.hp = 3 k.enemy.poison = 5 CB.endTurn(k)
            local q = fresh() q.enemy.moves = { { poison = 3 } } CB.endTurn(q)
            local t = fresh() t.thorns = 3 t.enemy.moves = { { atk = 2, n = 3 } } CB.endTurn(t)
            local a = fresh() a.armor = 5 a.enemy.moves = { { atk = 7 } } CB.endTurn(a)
            return json.encode({
                poisoned = { hp = p.enemy.hp, left = p.enemy.poison, log = p.log[1] },
                killed = { phase = k.phase, log = k.log[1] },
                onMe = { hp = q.hp, left = q.poison },
                thorned = { enemyHp = t.enemy.hp, hp = t.hp },
                armored = a.hp,
            })`)
        expect(result.poisoned).toEqual({ hp: 96, left: 3, log: '1턴: 카드 없음 / 적: 독 4, 방어 1' })
        expect(result.killed).toEqual({ phase: 'won', log: '1턴: 카드 없음 / 적: 독 5에 쓰러짐' })
        expect(result.onMe).toEqual({ hp: 57, left: 2 })
        expect(result.thorned).toEqual({ enemyHp: 91, hp: 54 })
        expect(result.armored).toBe(58)
    })

    test('dex, pierce, drain, the enemy\'s thorns and a hit point cost play as written', async () => {
        const result = await probe(`${setup}
            local d = fresh() deal(d, { CB.copy(CB.DEFEND) }) d.dex = 2 CB.play(d, 1)
            local x = fresh()
            deal(x, { { name = '꿰뚫기', cost = 1, fx = { dmg = 6, pierce = 1 } }, { name = '흡혈', cost = 1, fx = { dmg = 8, drain = 1 } } })
            x.enemy.block, x.hp = 10, 50
            CB.play(x, 1)
            local pierced = { enemyHp = x.enemy.hp, block = x.enemy.block }
            x.enemy.block = 3
            CB.play(x, 1)
            local y = fresh() deal(y, { { name = '연타', cost = 1, fx = { dmg = 3, hits = 3 } } }) y.enemy.thorns = 2 CB.play(y, 1)
            local h = fresh() deal(h, { { name = '피', cost = 0, fx = { dmg = 5, hpCost = 5 } } }) h.hp = 2 CB.play(h, 1)
            return json.encode({
                dexBlock = d.block, pierced = pierced, drained = { hp = x.hp, enemyHp = x.enemy.hp, note = x.note },
                pricked = { hp = y.hp, enemyHp = y.enemy.hp }, lastPoint = { hp = h.hp, phase = h.phase },
            })`)
        expect(result.dexBlock).toBe(7)
        expect(result.pierced).toEqual({ enemyHp: 94, block: 10 })
        expect(result.drained).toMatchObject({ hp: 55, enemyHp: 89 })
        expect(result.drained.note).toContain('흡혈 5')
        expect(result.pricked).toEqual({ hp: 54, enemyHp: 91 })
        expect(result.lastPoint).toEqual({ hp: 1, phase: 'fight' })
    })

    test('retain keeps a card, exhaust takes one out of the fight, charge and prepare land next turn', async () => {
        const result = await probe(`${setup}
            local r = fresh()
            deal(r, { { name = '버티기', cost = 1, fx = { block = 3, retain = 1 } }, { name = '마지막 수', cost = 0, fx = { dmg = 5, exhaust = 1 } }, { name = '준비', cost = 0, fx = { charge = 1, prepare = 2 } } })
            for i = 4, 12 do r.cards[i] = CB.copy(CB.STRIKE) r.draw[#r.draw + 1] = i end
            CB.play(r, 2)
            CB.play(r, 2)
            local before = { nextEnergy = r.nextEnergy, nextDraw = r.nextDraw }
            CB.endTurn(r)
            return json.encode({ before = before, kept = r.cards[r.hand[1]].name, hand = #r.hand, energy = r.energy,
                exhausted = r.exhausted, discard = r.discard, nextEnergy = r.nextEnergy, nextDraw = r.nextDraw })`)
        expect(result.before).toEqual({ nextEnergy: 1, nextDraw: 2 })
        expect(result.kept).toBe('버티기')
        expect(result.hand).toBe(8)
        expect(result.energy).toBe(4)
        expect(result.exhausted).toEqual([2])
        expect(result.discard).toEqual([3])
        expect(result).toMatchObject({ nextEnergy: 0, nextDraw: 0 })
    })

    test('a lifted card explains its keywords, and the bars show the new states', async () => {
        const result = await probe(`${setup}
            local b = fresh()
            deal(b, { { name = '독 바르기', cost = 1, fx = { poison = 5 }, rarity = 'common', desc = '' } })
            b.selected = 1
            b.enemy.poison, b.thorns, b.armor = 3, 2, 4
            b.enemy.moves = { { atk = 5, poison = 2 } }
            return json.encode({ view = CB.fightView(b, '레이') })`)
        expect(result.view).toContain('독: 적이 자기 턴을 시작할 때')
        expect(result.view).toContain('🧪 독 3')
        expect(result.view).toContain('🌵 가시 2')
        expect(result.view).toContain('🔰 매 턴 방어 4')
        expect(result.view).toContain('⚔️ 5 🧪')
    })
})

describe('after a reply', () => {
    test('a battle tag asks to fight and, on yes, opens the fight on that message', async () => {
        const { chat, run, state } = makeChat([
            { role: 'user', data: '숲으로 간다' },
            { role: 'char', data: '덤불에서 늑대가 튀어나온다.\n<battle tier="normal" name="굶주린 늑대">' },
        ])
        await run('output')
        expect(chat.message[1].data).toMatch(/^덤불에서 늑대가 튀어나온다.\n<!--cb:b:[^>]+-->$/)
        const b = mark(chat.message[1].data, 'b')
        expect(b).toMatchObject({ name: '굶주린 늑대', tier: 'normal', phase: 'fight', open: true, level: 1, hp: 60 })
        expect(b.hand).toHaveLength(5)
        expect(state('cb_live')).toEqual({ id: b.id, at: 1 })
    })

    test('"나중에" leaves the fight waiting, with a start card on the last message', async () => {
        alerts.select = '1'
        const { chat, run, shown } = makeChat([{ role: 'char', data: '도적이 길을 막는다.\n<battle tier="boss" name="도적 두목">' }])
        await run('output')
        expect(mark(chat.message[0].data, 'b')).toMatchObject({ name: '도적 두목', tier: 'boss', phase: 'pending' })
        const card = await shown(0)
        expect(card).toContain('risu-btn="cb|start"')
        expect(card).not.toContain('<!--cb:')

        await run('onButtonClick', { data: 'cb|start' })
        expect(mark(chat.message[0].data, 'b')).toMatchObject({ name: '도적 두목', tier: 'boss', phase: 'fight' })
    })

    test('a waiting fight started a few messages later is fought there', async () => {
        alerts.select = '1'
        const { chat, run, state, shown } = makeChat([{ role: 'char', data: '도적이 길을 막는다.\n<battle tier="boss" name="도적 두목">' }])
        await run('output')
        chat.message.push({ role: 'user', data: '일단 지나간다', time: 2 }, { role: 'char', data: '도적이 쫓아온다.', time: 3 })
        expect(await shown(2)).toContain('risu-btn="cb|start"')
        expect(await shown(0)).toBe('도적이 길을 막는다.')

        await run('onButtonClick', { data: 'cb|start' })
        expect(mark(chat.message[0].data, 'b')).toBeNull()
        expect(mark(chat.message[2].data, 'b')).toMatchObject({ name: '도적 두목', phase: 'fight' })
        expect(state('cb_live').at).toBe(2)
    })

    test('the module keeps a reply\'s swipe page in step with what it writes', async () => {
        const { chat, run } = makeChat([
            { role: 'char', data: '늑대가 덤빈다.\n<battle name="늑대">', swipes: ['평화로운 숲.', '늑대가 덤빈다.\n<battle name="늑대">'], swipeId: 1 },
        ])
        await run('output')
        expect(chat.message[0].swipes[1]).toBe(chat.message[0].data)
        expect(chat.message[0].swipes[0]).toBe('평화로운 숲.')
        expect(mark(chat.message[0].swipes[1], 'b').phase).toBe('fight')
    })
})

describe('the window', () => {
    test('draws the fight over the chat on the last message only, and taps lift then play a card', async () => {
        const { chat, run, shown } = makeChat([
            { role: 'user', data: '덤빈다' },
            { role: 'char', data: '고블린이 덤벼든다.\n<battle name="고블린">' },
        ])
        await run('output')
        const last = await shown(1)
        expect(last).toContain('position:fixed')
        expect(last).toContain('risu-btn="cb|sel|1"')
        expect(last).toContain('고블린')
        expect(await shown(0)).toBe('덤빈다')

        await run('onButtonClick', { data: 'cb|sel|1' })
        expect(mark(chat.message[1].data, 'b').selected).toBe(1)
        expect(await shown(1)).toContain('risu-btn="cb|play|1|')
        await run('onButtonClick', { data: 'cb|play|1' })
        const b = mark(chat.message[1].data, 'b')
        expect(b.energy).toBe(2)
        expect(b.hand).toHaveLength(4)
        expect(b.selected).toBeUndefined()

        await run('onButtonClick', { data: 'cb|close' })
        const closed = await shown(1)
        expect(closed).not.toContain('position:fixed')
        expect(closed).toContain('risu-btn="cb|open"')
    })

    test('finds its fight again when a message before it was deleted', async () => {
        const { chat, run, state } = makeChat([
            { role: 'user', data: '덤빈다' },
            { role: 'char', data: '고블린이 덤벼든다.\n<battle name="고블린">' },
        ])
        await run('output')
        chat.message.push({ role: 'user', data: '잠깐', time: 3 })
        chat.message.splice(0, 1)
        await run('onButtonClick', { data: 'cb|sel|2' })
        expect(mark(chat.message[0].data, 'b').selected).toBe(2)
        expect(state('cb_live').at).toBe(0)
    })
})

describe('the end of a fight', () => {
    const goblin = () => ({
        id: 'w1', level: 1, name: '고블린', tier: 'normal', phase: 'fight', open: true, turn: 3, energy: 3, maxEnergy: 3, seed: 9,
        cards: [{ name: '공격', cost: 1, fx: { dmg: 6 }, rarity: 'basic', desc: '' }], draw: [], hand: [1], discard: [],
        hp: 40, maxHp: 60, block: 0, str: 0, weak: 0, vuln: 0,
        enemy: { hp: 3, maxHp: 42, block: 0, str: 0, weak: 0, vuln: 0, moves: [{ atk: 7 }], step: 1, bonus: 0 },
        log: ['1턴: 공격(피해 6) / 적: 공격 7 (막음 0, 받은 피해 7)'], played: [], note: '',
    })
    const earlierRun = { v: 1, seed: 9, level: 1, xp: 1, maxHp: 60, hp: 60, deck: [{ name: '공격', cost: 1, fx: { dmg: 6 }, rarity: 'basic', desc: '' }] }

    /** An earlier fight's message (its run), then the goblin about to fall. */
    function nearlyWon() {
        return makeChat([
            { role: 'char', data: `지난 싸움.\n${packMark('r', earlierRun)}` },
            { role: 'user', data: '덤빈다' },
            { role: 'char', data: `고블린이 덤벼든다.\n${packMark('b', goblin())}` },
        ])
    }

    test('a win puts the log and the run on the fight\'s message, and a level up gets three cards from the auxiliary model', async () => {
        const { chat, run, state, shown } = nearlyWon()
        llmAnswers.push('[{"name":"세라의 검무","effects":{"dmg":4,"hits":2}},{"name":"방패 밀치기","effects":{"block":6,"weak":1}},{"name":"숨 돌리기","effects":{"draw":1}}]')
        await run('onButtonClick', { data: 'cb|play|1' })

        const text = chat.message[2].data
        expect(text).toContain('<battle-log>\n⚔️ 고블린 (일반) — 승리, 3턴\n1턴: 공격(피해 6) / 적: 공격 7')
        expect(text).toContain('결과: 레이 체력 45/65, 레벨 업 (Lv.2)\n</battle-log>')
        expect(mark(text, 'r')).toMatchObject({ level: 2, xp: 0, maxHp: 65, hp: 45 })
        expect(llmPrompts[0][1].content).toContain('# Story: 세라')
        const b = mark(text, 'b')
        expect(b).toMatchObject({ phase: 'won', level: 2, hp: 45 })
        expect(b.cards).toBeUndefined()
        expect(b.reward.choices.map((c: { name: string }) => c.name)).toEqual(['세라의 검무', '방패 밀치기', '숨 돌리기'])

        const end = await shown(2)
        expect(end).toContain('risu-btn="cb|pick|2"')
        expect(end).toContain('<details')
        expect(end).not.toContain('<!--cb:')
        await run('onButtonClick', { data: 'cb|pick|2' })
        expect(mark(chat.message[2].data, 'r').deck.at(-1).name).toBe('방패 밀치기')
        expect(mark(chat.message[2].data, 'b')).toBeNull()
        expect(state('cb_live')).toBe(false)
    })

    test('with the main model writing cards, the next request asks for them and the reply\'s block is hidden and read', async () => {
        toggles.set('toggle_cardbattle.cards', '1')
        const { chat, run } = nearlyWon()
        await run('onButtonClick', { data: 'cb|play|1' })
        expect(llmPrompts).toHaveLength(0)
        expect(mark(chat.message[2].data, 'b').reward.waiting).toBe(true)

        chat.message.push({ role: 'user', data: '계속', time: 4 })
        const request = (await run('editRequest', { data: chat.message.map((m: Message) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.data })) })).res as { role: string, content: string }[]
        expect(request.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'system', 'user'])
        expect(request[2].content).not.toContain('<!--cb:')
        expect(request[2].content).toContain('<battle-log>')
        expect(request[3].content).toContain('<cards>')
        expect(request[3].content).toContain('reached level 2')
        expect(request[3].content).toContain('Cards the player already has: 공격')

        chat.message.push({ role: 'char', data: '세라가 검을 거둔다.\n<cards>[{"name":"승리의 미소","effects":{"heal":4}}]</cards>', time: 5 })
        await run('output')
        expect(chat.message[4].data).toBe('세라가 검을 거둔다.')
        const b = mark(chat.message[2].data, 'b')
        expect(b.reward.choices[0].name).toBe('승리의 미소')
        expect(b.reward.choices).toHaveLength(3)
        expect(b.open).toBe(true)
    })

    test('fleeing ends the fight without experience; a log image shows the fight as plain text', async () => {
        const { chat, run } = nearlyWon()
        await run('onButtonClick', { data: 'cb|flee' })
        const text = chat.message[2].data
        expect(mark(text, 'b').phase).toBe('fled')
        expect(mark(text, 'r').xp).toBe(1)
        expect(text).toContain('— 도망, 3턴')
        const capture = (await run('editDisplay', { data: text, meta: { index: 2, logCapture: true } })).res as string
        expect(capture).toContain('⚔️ 고블린 (일반) — 도망, 3턴')
        expect(capture).not.toContain('<')
    })

    test('a beaten enemy becomes a card before the level up\'s: taken, it joins the run and the log says so', async () => {
        toggles.set('toggle_cardbattle.capture', '0')
        toggles.set('toggle_cardbattle.cards', '2')
        const { chat, run, shown, lua } = nearlyWon()
        await run('onButtonClick', { data: 'cb|play|1' })
        expect(llmPrompts).toHaveLength(0)
        // The module's own card of it: its strongest move, its name and face.
        expect(mark(chat.message[2].data, 'b').capture.card).toMatchObject({ name: '고블린', foe: true, glyph: '👺', rarity: 'common', cost: 1, fx: { dmg: 7 } })
        const end = await shown(2)
        expect(end).toContain('risu-btn="cb|take"')
        expect(end).toContain('risu-btn="cb|free"')
        expect(end).not.toContain('cb|pick')

        // The level up's cards wait for it.
        await run('onButtonClick', { data: 'cb|pick|1' })
        expect(mark(chat.message[2].data, 'r').deck).toHaveLength(1)
        await run('onButtonClick', { data: 'cb|take' })
        const text = chat.message[2].data
        expect(mark(text, 'r').deck.at(-1)).toMatchObject({ name: '고블린', foe: true })
        expect(text).toContain('카드로 얻음: 고블린\n</battle-log>')
        expect(mark(text, 'b').capture.done).toBe('take')
        expect(await shown(2)).toContain('risu-btn="cb|pick|1"')

        await run('onButtonClick', { data: 'cb|pick|1' })
        const deck = mark(chat.message[2].data, 'r').deck
        expect(deck).toHaveLength(3)
        expect(deck[1].name).toBe('고블린')
        // Its face is kept into the next fight.
        expect(await lua('return json.encode(CB.newBattle(CB.loadRun(id), { id = "n", name = "", tier = "normal" }, { healEach = true }).cards[2])')).toMatchObject({ name: '고블린', glyph: '👺', foe: true })
    })

    test('with the auxiliary model, one request writes the level up\'s cards and the beaten enemy\'s, which keeps its name; let go, it stays out', async () => {
        toggles.set('toggle_cardbattle.capture', '0')
        const { chat, run } = nearlyWon()
        llmAnswers.push('[{"name":"하나","effects":{"dmg":5}},{"name":"둘","effects":{"block":5}},{"name":"셋","effects":{"draw":1}},{"name":"고블린 왕","effects":{"dmg":5,"weak":1},"desc":"작지만 끈질기다."}]')
        await run('onButtonClick', { data: 'cb|play|1' })
        expect(llmPrompts).toHaveLength(1)
        expect(llmPrompts[0][1].content).toContain('card 4: the enemy just beaten, "고블린"')
        expect(llmPrompts[0][1].content).toContain('attack 7')
        const b = mark(chat.message[2].data, 'b')
        expect(b.reward.choices.map((c: { name: string }) => c.name)).toEqual(['하나', '둘', '셋'])
        expect(b.reward.note).toBeUndefined()
        expect(b.capture.card).toMatchObject({ name: '고블린', foe: true, glyph: '👺', fx: { dmg: 5, weak: 1 }, desc: '작지만 끈질기다.' })

        await run('onButtonClick', { data: 'cb|free' })
        const text = chat.message[2].data
        expect(mark(text, 'b').capture.done).toBe('free')
        expect(mark(text, 'r').deck.some((c: { foe?: boolean }) => c.foe)).toBe(false)
        expect(text).not.toContain('카드로 얻음')
    })
})

describe('turn by turn', () => {
    const asRequest = (messages: Message[]) => messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.data }))

    test('ending a turn closes the window and puts the turn on a user message; the reply that tells it opens the next turn', async () => {
        toggles.set('toggle_cardbattle.tell', '0')
        const { chat, run, state, shown } = makeChat([
            { role: 'user', data: '덤빈다' },
            { role: 'char', data: '고블린이 덤벼든다.\n<battle name="고블린">' },
        ])
        await run('output')
        const b0 = mark(chat.message[1].data, 'b')
        expect(b0).toMatchObject({ perTurn: true, told: 0, turn: 1 })

        await run('onButtonClick', { data: 'cb|end' })
        expect(chat.message).toHaveLength(3)
        const turn = chat.message[2]
        expect(turn.role).toBe('user')
        expect(turn.data).toMatch(/^<battle-turn>\n⚔️ 고블린 \(일반\)\n1턴: 카드 없음 \/ 적: [^\n]+\n지금: 레이 체력 \d+\/60, 고블린 체력 \d+\/\d+\n<\/battle-turn>\n<!--cb:b:[^>]+-->$/)
        expect(mark(turn.data, 'b')).toMatchObject({ phase: 'fight', turn: 2, open: false, awaitStory: true, told: 1 })
        // The start message keeps the fight as it stood, and says nothing of it.
        expect(mark(chat.message[1].data, 'b').turn).toBe(1)
        expect(await shown(1)).toBe('고블린이 덤벼든다.')
        const waiting = await shown(2)
        expect(waiting).toContain('보내기를 누르면 이 턴이 이야기로')
        expect(waiting).toContain('<details')
        expect(waiting).not.toContain('position:fixed')

        const request = (await run('editRequest', { data: asRequest(chat.message) })).res as { role: string, content: string }[]
        expect(request.map((m) => m.role)).toEqual(['user', 'assistant', 'system', 'user'])
        expect(request[2].content).toContain('tell the turn in the <battle-turn> block')
        expect(request[3].content).toContain('<battle-turn>')
        expect(request[3].content).not.toContain('<!--cb:')

        chat.message.push({ role: 'char', data: '고블린의 몽둥이가 어깨를 스친다.', time: 4 })
        await run('output')
        const b2 = mark(chat.message[2].data, 'b')
        expect(b2).toMatchObject({ open: true, turn: 2 })
        expect(b2.awaitStory).toBeUndefined()
        expect(await shown(3)).toContain('position:fixed')
        expect(state('cb_live')).toEqual({ id: b0.id, at: 2 })
    })

    test('rerolling the telling reply keeps the turn; deleting the turn message takes it back', async () => {
        toggles.set('toggle_cardbattle.tell', '0')
        const { chat, run, shown } = makeChat([
            { role: 'user', data: '덤빈다' },
            { role: 'char', data: '고블린이 덤벼든다.\n<battle name="고블린">' },
        ])
        await run('output')
        await run('onButtonClick', { data: 'cb|end' })
        chat.message.push({ role: 'char', data: '첫 이야기.', time: 4 })
        await run('output')
        chat.message[3].data = '다른 이야기.'
        await run('output')
        expect(mark(chat.message[2].data, 'b')).toMatchObject({ turn: 2, open: true })
        expect(await shown(3)).toContain('2턴')

        chat.message.splice(2, 2)
        await run('onButtonClick', { data: 'cb|sel|1' })
        expect(mark(chat.message[1].data, 'b')).toMatchObject({ turn: 1, selected: 1 })
        expect(await shown(1)).toContain('1턴')
    })

    test('the end goes on the turn message with only the turns not yet told, and closing it covers the older marks', async () => {
        toggles.set('toggle_cardbattle.tell', '0')
        const fight = (over: object) => ({
            id: 'w1', level: 1, name: '고블린', tier: 'normal', phase: 'fight', open: true, turn: 2, energy: 3, maxEnergy: 3, seed: 9, perTurn: true, told: 1,
            cards: [{ name: '공격', cost: 1, fx: { dmg: 6 }, rarity: 'basic', desc: '' }], draw: [], hand: [1], discard: [],
            hp: 53, maxHp: 60, block: 0, str: 0, weak: 0, vuln: 0,
            enemy: { hp: 3, maxHp: 42, block: 0, str: 0, weak: 0, vuln: 0, moves: [{ atk: 7 }], step: 1, bonus: 0 },
            log: ['1턴: 공격(피해 6) / 적: 공격 7 (막음 0, 받은 피해 7)'], played: [], note: '', ...over,
        })
        const { chat, run, state, setState, shown, lua } = makeChat([
            { role: 'char', data: `고블린이 덤벼든다.\n${packMark('b', fight({ turn: 1, told: 0, log: [], enemy: undefined }))}` },
            { role: 'user', data: `<battle-turn>\n⚔️ 고블린 (일반)\n1턴: 공격(피해 6) / 적: 공격 7\n지금: 레이 체력 53/60, 고블린 체력 9/42\n</battle-turn>\n${packMark('b', fight({}))}` },
            { role: 'char', data: '세라가 숨을 고른다.' },
        ])
        setState('cb_live', { id: 'w1', at: 1 })
        await run('onButtonClick', { data: 'cb|play|1' })

        expect(chat.message).toHaveLength(4)
        const end = chat.message[3]
        expect(end.role).toBe('user')
        expect(end.data).toContain('<battle-log>\n⚔️ 고블린 (일반) — 승리, 2턴\n2턴: 공격(피해 6)\n결과: 레이 체력 53/60')
        expect(end.data).not.toContain('1턴:')
        expect(mark(end.data, 'b').phase).toBe('won')
        expect(mark(end.data, 'r')).toMatchObject({ xp: 1 })

        await run('onButtonClick', { data: 'cb|done' })
        expect(mark(chat.message[3].data, 'b')).toEqual({ id: 'w1', phase: 'done' })
        expect(state('cb_live')).toBe(false)
        expect(await lua('return json.encode({ none = CB.findFight(id, true) == nil })')).toEqual({ none: true })
        const shownEnd = await shown(3)
        expect(shownEnd).toContain('<details')
        expect(shownEnd).not.toContain('position:fixed')
        expect(shownEnd).not.toContain('cb|open')
        expect(await shown(1)).not.toContain('전투 중')
    })

    test('by default a fight is told turn by turn; 끝나고 한 번에 adds no message when a turn ends', async () => {
        const start = () => makeChat([
            { role: 'user', data: '덤빈다' },
            { role: 'char', data: '고블린이 덤벼든다.\n<battle name="고블린">' },
        ])
        toggles.delete('toggle_cardbattle.tell')
        const fresh = start()
        await fresh.run('output')
        expect(mark(fresh.chat.message[1].data, 'b').perTurn).toBe(true)

        toggles.set('toggle_cardbattle.tell', '1')
        const { chat, run } = start()
        await run('output')
        await run('onButtonClick', { data: 'cb|end' })
        expect(chat.message).toHaveLength(2)
        expect(mark(chat.message[1].data, 'b')).toMatchObject({ turn: 2, open: true })
        expect(mark(chat.message[1].data, 'b').perTurn).toBeUndefined()
    })

    test('a battle tag in the middle of a fight is dropped, and the fight goes on', async () => {
        const { chat, run } = makeChat([
            { role: 'user', data: '덤빈다' },
            { role: 'char', data: '고블린이 덤벼든다.\n<battle name="고블린">' },
        ])
        await run('output')
        const id = mark(chat.message[1].data, 'b').id
        chat.message.push({ role: 'user', data: '계속', time: 3 }, { role: 'char', data: '또 다른 적이 나타난다.\n<battle tier="boss" name="마왕">', time: 4 })
        await run('output')
        expect(chat.message[3].data).toBe('또 다른 적이 나타난다.')
        expect(mark(chat.message[1].data, 'b')).toMatchObject({ id, phase: 'fight' })
    })
})

describe('rerolls and deletions', () => {
    const strike = { name: '공격', cost: 1, fx: { dmg: 6 }, rarity: 'basic', desc: '' }

    test('rerolling the fight\'s message takes back everything it won, and nothing of it is left on screen or in the request', async () => {
        toggles.set('toggle_cardbattle.cards', '2')
        const { chat, run, lua, shown } = makeChat([
            { role: 'char', data: `지난 싸움.\n${packMark('r', { v: 1, seed: 9, level: 1, xp: 1, maxHp: 60, hp: 60, deck: [strike] })}` },
            { role: 'user', data: '덤빈다' },
            { role: 'char', data: '고블린이 덤벼든다.\n<battle name="고블린">' },
        ])
        await run('output')
        const b = mark(chat.message[2].data, 'b')
        b.enemy.hp = 1
        chat.message[2].data = `고블린이 덤벼든다.\n${packMark('b', b)}`
        await run('onButtonClick', { data: 'cb|play|1' })
        await run('onButtonClick', { data: 'cb|pick|1' })
        const won = await lua('return json.encode(CB.loadRun(id))')
        expect(won).toMatchObject({ level: 2, xp: 0 })
        expect(won.deck).toHaveLength(2)

        // The reroll: the same place, another reply.
        chat.message[2].data = '고블린은 도망쳤다.'
        expect(await lua('return json.encode(CB.loadRun(id))')).toMatchObject({ level: 1, xp: 1, deck: [strike] })
        expect(await shown(2)).toBe('고블린은 도망쳤다.')
        chat.message.push({ role: 'user', data: '쫓아간다', time: 4 })
        const request = (await run('editRequest', { data: [{ role: 'user', content: '쫓아간다' }] })).res as { role: string, content: string }[]
        expect(request[0].content).not.toContain('going on')
    })

    test('deleting the last fight\'s message brings back the run from the one before', async () => {
        const { chat, lua } = makeChat([
            { role: 'char', data: `첫 싸움.\n${packMark('r', { level: 1, xp: 1, maxHp: 60, hp: 50, deck: [] })}` },
            { role: 'user', data: '다음' },
            { role: 'char', data: `둘째 싸움.\n${packMark('r', { level: 2, xp: 0, maxHp: 65, hp: 65, deck: [] })}` },
        ])
        expect(await lua('return json.encode(CB.loadRun(id))')).toMatchObject({ level: 2 })
        chat.message.splice(1, 2)
        expect(await lua('return json.encode(CB.loadRun(id))')).toMatchObject({ level: 1, hp: 50 })
        chat.message.splice(0, 1)
        expect(await lua('return json.encode(CB.loadRun(id))')).toMatchObject({ level: 1, hp: 60, xp: 0 })
    })

    test('a waiting fight whose reply was rerolled shows no start card any more', async () => {
        alerts.select = '1'
        const { chat, run, shown } = makeChat([{ role: 'char', data: '도적이 길을 막는다.\n<battle name="도적">' }])
        await run('output')
        expect(await shown(0)).toContain('cb|start')
        chat.message[0].data = '조용한 길이다.'
        await run('output')
        expect(await shown(0)).toBe('조용한 길이다.')
        await run('onButtonClick', { data: 'cb|start' })
        expect(chat.message[0].data).toBe('조용한 길이다.')
    })
})

describe('scenes', () => {
    const goblinFight = () => makeChat([
        { role: 'user', data: '덤빈다' },
        { role: 'char', data: '고블린이 덤벼든다.\n<battle name="고블린">' },
    ])

    test('a played card flies to the enemy and lands: a slash a hit, a big hit shakes the window, broken block shatters', async () => {
        const result = await probe(`
            local b = CB.newBattle(CB.newRun(3), { id = 'x', name = '늑대', tier = 'normal' }, { healEach = true })
            b.cards[b.hand[1]] = { name = '연타', cost = 1, fx = { dmg = 9, hits = 2 }, rarity = 'common', desc = '' }
            b.enemy.block, b.n = 5, 3
            CB.play(b, 1)
            local on, off = CB.fightView(b, '레이'), CB.fightView(b, '레이', false)
            b.n = 4
            return json.encode({ anim = b.anim, on = on, off = off, next = CB.fightView(b, '레이') })`)
        expect(result.anim).toMatchObject({ castAt: 'foe', hits: 2, big: true, enemyBreak: true, enemy: 'hit', enemyText: '-13' })
        expect(result.on).toContain('class="cbx-ghost"')
        expect(result.on.match(/class="cbx-slash"/g)).toHaveLength(2)
        expect(result.on).toContain('class="cbx-panel cbx-quake"')
        expect(result.on).toContain('class="cbx-block cbx-break"')
        expect(result.on).toContain('class="cbx-trail"')
        expect(result.on).toContain('class="cbx-float cbx-crit"')
        // Drawings take turns between two outer tags, so each one is drawn fresh.
        expect(result.on.startsWith('<section>')).toBe(true)
        expect(result.next.startsWith('<div>')).toBe(true)
        // 전투 연출 off: the number only (the style block names every class,
        // so the markup is what is looked at).
        expect(result.off).not.toContain('class="cbx-ghost"')
        expect(result.off).not.toContain('class="cbx-slash"')
        expect(result.off).not.toContain('cbx-quake"')
        expect(result.off).toContain('class="cbx-float">-13<')
    })

    test('ending a turn plays the enemy\'s turn as three drawings, each on screen before the next', async () => {
        toggles.delete('toggle_cardbattle.fx')
        const { chat, run, shown } = goblinFight()
        await run('output')
        // A poisoned enemy that hits twice, against block from armor.
        const b = mark(chat.message[1].data, 'b')
        Object.assign(b.enemy, { poison: 3, moves: [{ atk: 6, n: 2 }], step: 1 })
        b.armor = 4
        chat.message[1].data = `고블린이 덤벼든다.\n${packMark('b', b)}`
        const scenes: any[] = []
        vi.mocked(ReloadChatPointer.update).mockImplementation(() => { scenes.push(mark(chat.message[1].data, 'b')) })
        // Waits for real, a hundredth of the time.
        await run('onButtonClick', { data: `cb|end||${b.n}`, pace: 0.01 })

        expect(scenes.map((s) => s.anim.banner ?? null)).toEqual(['foe', null, 'mine'])
        expect(scenes[0].anim).toMatchObject({ foeTurn: true, enemy: 'hit', enemyText: '-3', enemyPoison: true, playerBlock: 'pop' })
        expect(scenes[0].hand).toHaveLength(0)
        expect(scenes[0].anim.toss).toHaveLength(5)
        expect(scenes[1].anim).toMatchObject({ foeTurn: true, lunge: 2, player: 'hurt', playerText: '-8', flash: true, playerBreak: true })
        expect(scenes[2].anim).toMatchObject({ deal: true, refill: true })
        expect(scenes[2].hand).toHaveLength(5)
        expect(new Set(scenes.map((s) => s.n % 2))).toEqual(new Set([0, 1]))
        const now = await shown(1)
        expect(now).toContain('2턴 · 내 차례')
        expect(now).toContain(`risu-btn="cb|end||${scenes[2].n}"`)

        // A 턴 종료 left over from before is dropped.
        await run('onButtonClick', { data: `cb|end||${b.n}` })
        expect(mark(chat.message[1].data, 'b').turn).toBe(2)
    })

    test('the enemy\'s scene shows its move while nothing can be tapped', async () => {
        const result = await probe(`
            local b = CB.newBattle(CB.newRun(3), { id = 'x', name = '늑대', tier = 'elite' }, { healEach = true })
            b.enemy.moves, b.enemy.step = { { atk = 5, poison = 2 } }, 1
            local views = {}
            CB.endTurn(b, function(n) views[n] = CB.fightView(b, '레이') end)
            return json.encode(views)`)
        // The three scenes, in order (a Lua list comes back as an array).
        const [coming, moving, mine] = result as string[]
        expect(coming).toContain('class="cbx-banner"')
        expect(coming).toContain('적의 차례')
        expect(coming).not.toContain('cb|end')
        expect(coming).not.toContain('cb|sel')
        expect(coming).toContain('class="cbx-toss"')
        expect(moving).toContain('class="cbx-medalw cbx-lunge"')
        expect(moving).toContain('class="cbx-flash"')
        expect(moving).toContain('class="cbx-bub"')
        expect(moving).toContain('class="cbx-intent cbx-act"')
        expect(mine).toContain('class="cbx-banner cbx-mine"')
        expect(mine).toContain('risu-btn="cb|sel|1"')
    })

    test('the blow that ends a fight is drawn as a hit with nothing to tap, not as the end screen', async () => {
        const result = await probe(`
            local b = CB.newBattle(CB.newRun(3), { id = 'x', name = '늑대', tier = 'normal' }, { healEach = true })
            b.cards[b.hand[1]] = CB.copy(CB.STRIKE)
            b.enemy.hp = 2
            CB.play(b, 1)
            return json.encode({ phase = b.phase, view = CB.lastExtras(id, '', b) })`)
        expect(result.phase).toBe('won')
        expect(result.view).toContain('class="cbx-slash"')
        expect(result.view).not.toContain('class="cbx-title"')
        expect(result.view).not.toContain('risu-btn="cb|sel')
        expect(result.view).not.toContain('cb|end')
    })
})

describe('the signature card', () => {
    const goblinFight = () => makeChat([
        { role: 'user', data: '덤빈다' },
        { role: 'char', data: '고블린이 덤벼든다.\n<battle name="고블린">' },
    ])

    test('the auxiliary model writes it at the first fight; the fight starts with it, and the run keeps it after', async () => {
        toggles.set('toggle_cardbattle.sig', '0')
        llmAnswers.push('[{"name":"세라의 검기","effects":{"dmg":9,"vuln":1},"desc":"세라가 가르친 일격."}]')
        const { chat, run, shown } = goblinFight()
        await run('output')
        const waiting = mark(chat.message[1].data, 'b')
        expect(waiting).toMatchObject({ phase: 'sig', name: '고블린', open: true })
        expect(waiting.sigDraft.card).toMatchObject({ name: '세라의 검기', rarity: 'rare', sig: true, fx: { dmg: 9, vuln: 1 } })
        expect(llmPrompts[0][1].content).toContain('the signature card of this story')
        const view = await shown(1)
        expect(view).toContain('★ 대표 카드')
        expect(view).toContain('cbx-badge">대표')
        expect(view).toContain('risu-btn="cb|sigok"')
        expect(view).toContain('risu-btn="cb|sigredo"')
        const request = (await run('editRequest', { data: [{ role: 'user', content: '싸운다' }] })).res as { role: string, content: string }[]
        expect(request[0].content).toContain('A fight against 고블린 is going on')

        await run('onButtonClick', { data: 'cb|sigok' })
        const b = mark(chat.message[1].data, 'b')
        expect(b).toMatchObject({ phase: 'fight', turn: 1, name: '고블린' })
        expect(b.cards).toHaveLength(11)
        expect(b.cards.filter((c: { sig?: boolean }) => c.sig).map((c: { name: string }) => c.name)).toEqual(['세라의 검기'])
        expect(b.anim).toMatchObject({ deal: true, banner: 'mine' })

        // However the fight ends, the run keeps the card, and the next fight asks for none.
        await run('onButtonClick', { data: 'cb|flee' })
        expect(mark(chat.message[1].data, 'r').deck.filter((c: { sig?: boolean }) => c.sig)).toHaveLength(1)
        await run('onButtonClick', { data: 'cb|done' })
        chat.message.push({ role: 'user', data: '간다', time: 3 }, { role: 'char', data: '늑대다.\n<battle name="늑대">', time: 4 })
        await run('output')
        const next = mark(chat.message[3].data, 'b')
        expect(next.phase).toBe('fight')
        expect(next.cards.filter((c: { sig?: boolean }) => c.sig)).toHaveLength(1)
        expect(llmPrompts).toHaveLength(1)
    })

    test('when the model writes nothing, a module card stands in, and it can be made by hand instead', async () => {
        toggles.set('toggle_cardbattle.sig', '0')
        const { chat, run, shown } = goblinFight()
        await run('output')
        const draft = mark(chat.message[1].data, 'b').sigDraft
        expect(draft.card).toMatchObject({ rarity: 'rare', sig: true })
        expect(draft.note).toContain('보조 모델이 쓰지 못해')
        await run('onButtonClick', { data: 'cb|sigform' })
        expect(await shown(1)).toContain('risu-form="cb|sig"')
        expect(await shown(1)).toContain(`value="${draft.card.name}"`)
    })

    test('made by hand: the form keeps the card within what its cost pays, and 고치기 brings the form back', async () => {
        toggles.set('toggle_cardbattle.sig', '1')
        const { chat, run, shown, lua } = goblinFight()
        await run('output')
        expect(mark(chat.message[1].data, 'b').sigDraft).toEqual({ hand: true })
        expect(llmPrompts).toHaveLength(0)
        const form = await shown(1)
        expect(form).toContain('risu-form="cb|sig"')
        expect(form).toContain('name="cname"')
        expect(form).not.toContain('name="name"')
        expect(form).toContain('<option value="poison">독</option>')

        const send = (data: Record<string, string>) => run('onFormSubmit', { data: 'cb|sig', meta: { data } })
        await send({ cname: '', cost: '1', k1: 'dmg', v1: '8' })
        expect(mark(chat.message[1].data, 'b').sigDraft).toMatchObject({ form: true, note: expect.stringContaining('이름과') })

        await send({ cname: '불꽃 검', cost: '0', k1: 'dmg', v1: '30', k2: 'poison', v2: '4', k3: '', v3: '', pierce: '1', cdesc: '타오른다' })
        const made = mark(chat.message[1].data, 'b').sigDraft
        expect(made.form).toBeUndefined()
        expect(made.card).toMatchObject({ name: '불꽃 검', rarity: 'rare', sig: true, cost: 3, desc: '타오른다' })
        expect(made.card.fx.pierce).toBe(1)
        expect(made.card.fx.dmg).toBeLessThan(30)
        expect(made.note).toContain('비용 0 → 3')
        expect(made.note).toContain('숫자를 줄였습니다')
        expect(await lua(`local d = CB.findFight(id, true).sigDraft.card return json.encode({ fits = CB.points(d.fx) <= CB.budget(d.cost, 'rare', d.fx) })`)).toEqual({ fits: true })
        const shownCard = await shown(1)
        expect(shownCard).toContain('risu-btn="cb|sigform"')
        expect(shownCard).not.toContain('cb|sigredo')

        await run('onButtonClick', { data: 'cb|sigform' })
        const again = await shown(1)
        expect(again).toContain('value="불꽃 검"')
        expect(again).toContain('risu-btn="cb|sigback"')
        await run('onButtonClick', { data: 'cb|sigback' })
        await run('onButtonClick', { data: 'cb|sigok' })
        const b = mark(chat.message[1].data, 'b')
        expect(b.phase).toBe('fight')
        expect(b.sigCard.name).toBe('불꽃 검')
    })
})
