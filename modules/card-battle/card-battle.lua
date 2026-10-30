-- 🃏 카드 전투 (Card Battle)
-- A deck-building card battle any bot can use: the story runs as usual, and
-- when a fight is about to start the main model ends its reply with a
-- <battle> tag. The module asks whether to fight, then plays the fight in a
-- window over the chat: the player's deck against an enemy whose next move
-- shows ahead, one tap to pick a card and one to play it. The numbers are
-- the module's (this file); only names and flavour come from the models.
--
-- When the fight is over a <battle-log> block is added to the last message,
-- so the next reply tells the fight as it went and the log stays in the
-- story. A level up offers three new cards written for this bot by the
-- auxiliary model, the main model (in its next reply) or the module's own
-- pool, to pick one or skip.
--
-- Everything lives in chat state: the run (level, hit points, deck) in
-- cb_run, the fight in cb_battle, a fight waiting to start in cb_pending.

local CB = {}
CB.VERSION = '0.1.0'

------------------------------------------------------------------------------
-- Small helpers
------------------------------------------------------------------------------

function CB.trim(s)
    return (tostring(s or ''):gsub('^%s+', ''):gsub('%s+$', ''))
end

local function escapeHtml(text)
    return (tostring(text or ''):gsub('&', '&amp;'):gsub('<', '&lt;'):gsub('>', '&gt;'):gsub('"', '&quot;'))
end

--- At most n characters (not bytes), so a Korean name is cut whole.
function CB.clip(text, n)
    text = tostring(text or '')
    local ok, len = pcall(utf8.len, text)
    if not ok or not len then return text:sub(1, n) end
    if len <= n then return text end
    return text:sub(1, utf8.offset(text, n + 1) - 1)
end

function CB.copy(value)
    if type(value) ~= 'table' then return value end
    local out = {}
    for k, v in pairs(value) do out[k] = CB.copy(v) end
    return out
end

--- A small generator kept in the run, so redrawing draws nothing new and a
--- test can fix the seed. rand(run) is in [0, 1); rand(run, n) in 1..n.
function CB.rand(run, n)
    local seed = math.floor(tonumber(run.seed) or 1)
    seed = (seed * 1103515245 + 12345) % 2147483648
    run.seed = seed
    if n then return seed % n + 1 end
    return seed / 2147483648
end

function CB.shuffle(run, list)
    for i = #list, 2, -1 do
        local j = CB.rand(run, i)
        list[i], list[j] = list[j], list[i]
    end
end

------------------------------------------------------------------------------
-- Cards
------------------------------------------------------------------------------

-- What a card can do, with the most of each one card may have and its worth
-- in budget points (a point is one damage or one block).
CB.EFFECTS = {
    { key = 'dmg', max = 40, points = 1 },
    { key = 'hits', max = 4 },
    { key = 'block', max = 40, points = 1 },
    { key = 'weak', max = 3, points = 3 },
    { key = 'vuln', max = 3, points = 3 },
    { key = 'str', max = 3, points = 6 },
    { key = 'draw', max = 3, points = 4 },
    { key = 'energy', max = 2, points = 5 },
    { key = 'heal', max = 12, points = 1.5 },
}

-- Points a card may carry by its cost, scaled by rarity, plus a little slack.
CB.BUDGET = { [0] = 5, [1] = 9, [2] = 16, [3] = 23 }
CB.RARITY_SCALE = { basic = 1, common = 1, rare = 1.3, epic = 1.6 }
CB.SLACK = 1.15

CB.RARITY_LABEL = { basic = '기본', common = '일반', rare = '희귀', epic = '영웅' }
CB.RARITY_COLOR = { basic = '#8a8f98', common = '#5aa0e6', rare = '#e6b450', epic = '#c77dff' }

function CB.points(fx)
    local total = 0
    for _, effect in ipairs(CB.EFFECTS) do
        local value = fx[effect.key]
        if value and effect.points then
            if effect.key == 'dmg' then value = value * (fx.hits or 1) end
            total = total + value * effect.points
        end
    end
    return total
end

function CB.budget(cost, rarity)
    return (CB.BUDGET[cost] or CB.BUDGET[1]) * (CB.RARITY_SCALE[rarity] or 1) * CB.SLACK
end

function CB.isAttack(card)
    return (card.fx or {}).dmg ~= nil
end

function CB.effectText(card)
    local fx, parts = card.fx or {}, {}
    if fx.dmg then
        local hits = fx.hits or 1
        parts[#parts + 1] = hits > 1 and ('피해 ' .. fx.dmg .. '×' .. hits) or ('피해 ' .. fx.dmg)
    end
    if fx.block then parts[#parts + 1] = '방어 ' .. fx.block end
    if fx.weak then parts[#parts + 1] = '약화 ' .. fx.weak end
    if fx.vuln then parts[#parts + 1] = '취약 ' .. fx.vuln end
    if fx.str then parts[#parts + 1] = '힘 +' .. fx.str end
    if fx.draw then parts[#parts + 1] = fx.draw .. '장 뽑기' end
    if fx.energy then parts[#parts + 1] = '에너지 +' .. fx.energy end
    if fx.heal then parts[#parts + 1] = '체력 ' .. fx.heal .. ' 회복' end
    return table.concat(parts, ', ')
end

--- A card made safe: known effects only, whole numbers in range, a cost of
--- 0-3, and no more effect than its cost and rarity pay for (over budget,
--- the cost goes up first, then the numbers come down). nil when nothing
--- usable is left. Cards an LLM wrote go through this, and every card again
--- when a fight starts, so an edited chat variable cannot make one stronger.
function CB.cleanCard(raw, slot)
    if type(raw) ~= 'table' then return nil end
    local name = CB.clip(CB.trim(raw.name), 14)
    if name == '' then return nil end
    local source = type(raw.effects) == 'table' and raw.effects or (type(raw.fx) == 'table' and raw.fx or {})
    local fx = {}
    for _, effect in ipairs(CB.EFFECTS) do
        local value = tonumber(source[effect.key])
        if value then
            value = math.floor(value)
            if value >= 1 then fx[effect.key] = math.min(value, effect.max) end
        end
    end
    if fx.hits and (not fx.dmg or fx.hits == 1) then fx.hits = nil end
    if next(fx) == nil then return nil end
    local rarity = (slot and slot.rarity) or raw.rarity
    if not CB.RARITY_SCALE[rarity] then rarity = 'common' end
    local cost = math.floor(tonumber((slot and slot.cost) or raw.cost) or 1)
    cost = math.max(0, math.min(3, cost))
    while CB.points(fx) > CB.budget(cost, rarity) and cost < 3 do cost = cost + 1 end
    local over = CB.points(fx) / CB.budget(cost, rarity)
    if over > 1 then
        for key, value in pairs(fx) do
            if key ~= 'hits' then fx[key] = math.max(1, math.floor(value / over)) end
        end
    end
    -- What rounding left over: the effect worth most loses one at a time (a
    -- many-hit attack loses a hit once each hit is small).
    for _ = 1, 200 do
        if CB.points(fx) <= CB.budget(cost, rarity) then break end
        local top, worth = nil, -1
        for _, effect in ipairs(CB.EFFECTS) do
            local value = fx[effect.key]
            if value and effect.points then
                local w = value * effect.points * (effect.key == 'dmg' and (fx.hits or 1) or 1)
                if w > worth then top, worth = effect.key, w end
            end
        end
        if top == 'dmg' and (fx.hits or 1) > 1 and fx.dmg <= 3 then
            fx.hits = fx.hits - 1
        else
            fx[top] = fx[top] - 1
            if fx[top] <= 0 then fx[top] = nil end
        end
    end
    if fx.hits and (not fx.dmg or fx.hits <= 1) then fx.hits = nil end
    if next(fx) == nil then return nil end
    return { name = name, cost = cost, fx = fx, rarity = rarity, desc = CB.clip(CB.trim(raw.desc), 60) }
end

CB.STRIKE = { name = '공격', cost = 1, fx = { dmg = 6 }, rarity = 'basic', desc = '' }
CB.DEFEND = { name = '방어', cost = 1, fx = { block = 5 }, rarity = 'basic', desc = '' }

-- The module's own cards: a level up offers these when no model writes
-- them, and in place of one a model wrote that could not be used.
CB.POOL = {
    common = {
        { name = '강타', cost = 2, fx = { dmg = 13 }, desc = '온 힘을 실은 한 방.' },
        { name = '연속 베기', cost = 1, fx = { dmg = 4, hits = 2 }, desc = '빠르게 두 번.' },
        { name = '철벽', cost = 1, fx = { block = 9 }, desc = '빈틈없이 막는다.' },
        { name = '숨 고르기', cost = 0, fx = { draw = 1 }, desc = '한 박자 쉬고 다음 수를 본다.' },
        { name = '약점 찌르기', cost = 1, fx = { dmg = 5, vuln = 1 }, desc = '틈을 노린다.' },
        { name = '위협', cost = 1, fx = { weak = 2, block = 3 }, desc = '기세로 누른다.' },
        { name = '응급 처치', cost = 1, fx = { heal = 6 }, desc = '급한 대로 상처를 싸맨다.' },
        { name = '자세 잡기', cost = 1, fx = { block = 5, draw = 1 }, desc = '물러서며 다음을 준비한다.' },
    },
    rare = {
        { name = '회오리 베기', cost = 2, fx = { dmg = 6, hits = 3 }, desc = '몸을 돌려 연달아 벤다.' },
        { name = '전투의 함성', cost = 1, fx = { str = 2 }, desc = '피가 끓어오른다.' },
        { name = '반격 태세', cost = 1, fx = { block = 8, draw = 1 }, desc = '막고, 노린다.' },
        { name = '급소 공격', cost = 1, fx = { dmg = 7, vuln = 2 }, desc = '정확히 그곳을.' },
    },
    epic = {
        { name = '결전', cost = 2, fx = { dmg = 18, vuln = 2 }, desc = '모든 것을 건 일격.' },
        { name = '각성', cost = 1, fx = { energy = 1, draw = 2 }, desc = '시야가 맑아진다.' },
        { name = '불굴', cost = 2, fx = { block = 14, str = 1 }, desc = '쓰러지지 않는다.' },
    },
}

function CB.poolCard(run, slot)
    local list = CB.POOL[slot.rarity] or CB.POOL.common
    local card = CB.copy(list[CB.rand(run, #list)])
    card.rarity = slot.rarity
    return CB.cleanCard(card, { rarity = slot.rarity, cost = card.cost })
end

--- The three cards a level up offers: a rarity (heroic from level 3) and a
--- cost for each, which the writer fills in.
function CB.rollSlots(run)
    local slots = {}
    for i = 1, 3 do
        local roll = CB.rand(run)
        local rarity = 'common'
        if roll < 0.1 and run.level >= 3 then rarity = 'epic' elseif roll < 0.4 then rarity = 'rare' end
        local c = CB.rand(run)
        local cost = c < 0.1 and 0 or (c < 0.6 and 1 or (c < 0.9 and 2 or 3))
        if rarity == 'epic' and cost == 0 then cost = 1 end
        slots[i] = { rarity = rarity, cost = cost }
    end
    return slots
end

function CB.slotText(slots)
    local lines = {}
    for i, slot in ipairs(slots) do
        lines[i] = string.format('card %d: rarity %s, cost %d, about %d points', i, slot.rarity, slot.cost,
            math.floor(CB.budget(slot.cost, slot.rarity) / CB.SLACK))
    end
    return table.concat(lines, '\n')
end

CB.CARD_RULES = table.concat({
    'Each card is JSON: {"name": short name in the story\'s language (12 characters at most), "effects": {...}, "desc": one short line of flavour}.',
    'Effects (points per unit): dmg = damage to the enemy (1), hits = how many times dmg lands (multiplies dmg), block = blocks damage this turn (1),',
    'weak = enemy deals 25% less for that many turns (3), vuln = enemy takes 50% more for that many turns (3), str = +1 damage per hit for the rest of the fight (6),',
    'draw = draw cards (4), energy = gain energy this turn (5), heal = restore hit points (1.5).',
    'Keep each card near its points. Make them fit this story: its people, their skills, items, moments and relationships.',
}, '\n')

--- The cards in an answer: the first [...] in it, one per slot, each made
--- safe; a slot the answer does not fill takes a pool card.
function CB.parseCards(run, text, slots)
    local list = nil
    local body = type(text) == 'string' and text:match('%b[]') or nil
    if body then
        local ok, decoded = pcall(json.decode, body)
        if ok and type(decoded) == 'table' then list = decoded end
    end
    local cards, written = {}, 0
    for i, slot in ipairs(slots) do
        local card = list and CB.cleanCard(list[i], slot) or nil
        if card then written = written + 1 else card = CB.poolCard(run, slot) end
        cards[i] = card
    end
    return cards, written
end

------------------------------------------------------------------------------
-- Enemies
------------------------------------------------------------------------------

CB.TIER_LABEL = { normal = '일반', elite = '정예', boss = '보스' }
CB.XP = { normal = 1, elite = 2, boss = 3 }
CB.XP_PER_LEVEL = 2

-- Each enemy repeats its moves in order, from a random first one. A move
-- may defend (def), attack (atk, n times), grow stronger (str) and weaken
-- (weak) or expose (vuln) the player. The numbers grow with the level.
CB.ENEMIES = {
    normal = {
        { name = '적', hp = 42, moves = { { atk = 7 }, { atk = 4, n = 2 }, { def = 6, atk = 5 } } },
        { name = '적', hp = 46, moves = { { def = 8 }, { atk = 9 }, { weak = 2, atk = 4 } } },
        { name = '적', hp = 38, moves = { { str = 2 }, { atk = 6 }, { atk = 6 } } },
    },
    elite = {
        { name = '강적', hp = 72, moves = { { atk = 12 }, { atk = 5, n = 3 }, { str = 3, def = 8 }, { vuln = 2, atk = 6 } } },
        { name = '강적', hp = 80, moves = { { def = 12, atk = 6 }, { atk = 15 }, { weak = 2, vuln = 1 } } },
    },
    boss = {
        { name = '우두머리', hp = 130, moves = { { str = 2, def = 12 }, { atk = 16 }, { atk = 6, n = 3 }, { weak = 2, vuln = 2 }, { atk = 22 } } },
    },
}

------------------------------------------------------------------------------
-- Settings (the module's toggle menu)
------------------------------------------------------------------------------

-- A select stores its option index; an unset one reads as its first option,
-- so each select lists its default first.
local function option(tid, key)
    local value = getGlobalVar(tid, 'toggle_cardbattle.' .. key)
    if value == nil or value == 'null' then return '' end
    return tostring(value)
end

local function choice(tid, key)
    return tonumber(option(tid, key)) or 0
end

CB.CARD_WRITERS = { [0] = 'aux', [1] = 'main', [2] = 'pool' }

function CB.settings(tid)
    return {
        cards = CB.CARD_WRITERS[choice(tid, 'cards')] or 'aux',  -- 보조 모델, 메인 모델, 기본 카드만
        popup = choice(tid, 'popup') == 0,                      -- 띄우기, 바로 전투 화면
        healEach = choice(tid, 'hp') == 0,                      -- 전투마다 회복, 이어짐
        fullLog = choice(tid, 'log') == 0,                      -- 턴마다 요약, 결과만
    }
end

------------------------------------------------------------------------------
-- Chat state
------------------------------------------------------------------------------

local function stateGet(tid, name)
    local ok, value = pcall(getState, tid, name)
    if ok then return value end
    return nil
end

local function tableState(tid, name)
    local value = stateGet(tid, name)
    if type(value) == 'table' then return value end
    return nil
end

function CB.newRun(seed)
    local run = { v = 1, seed = seed or math.random(1, 2147483646), level = 1, xp = 0, maxHp = 60, hp = 60, deck = {} }
    for _ = 1, 5 do run.deck[#run.deck + 1] = CB.copy(CB.STRIKE) end
    for _ = 1, 5 do run.deck[#run.deck + 1] = CB.copy(CB.DEFEND) end
    return run
end

function CB.loadRun(tid)
    local run = tableState(tid, 'cb_run')
    if not run or type(run.deck) ~= 'table' then run = CB.newRun() end
    return run
end

------------------------------------------------------------------------------
-- The battle tag and marks
------------------------------------------------------------------------------

-- The tag the main model ends a reply with when a fight starts, and the
-- hidden mark it becomes (an HTML comment, invisible wherever this module
-- does not run).
CB.TAG_PATTERN = '<[Bb][Aa][Tt][Tt][Ll][Ee]%f[%s/>]([^>]*)>'
CB.CLOSE_TAG_PATTERN = '</[Bb][Aa][Tt][Tt][Ll][Ee]>'
CB.START_PATTERN = '<!%-%-cb:s:(%w+)%-%->'
CB.ANY_MARK_PATTERN = '\n?<!%-%-cb:[%w:]+%-%->'
CB.CARDS_PATTERN = '<cards>(.-)</cards>'
CB.LOG_PATTERN = '<battle%-log>(.-)</battle%-log>'

function CB.startMark(id) return '<!--cb:s:' .. id .. '-->' end

local function attributes(text)
    local out = {}
    for key, value in tostring(text or ''):gmatch('(%w+)%s*=%s*"([^"]*)"') do out[key:lower()] = value end
    for key, value in tostring(text or ''):gmatch("(%w+)%s*=%s*'([^']*)'") do out[key:lower()] = value end
    return out
end

local function newId(run)
    return string.format('%x%x', CB.rand(run, 65535), CB.rand(run, 65535))
end

--- The text with its last battle tag turned into a start mark (other tags
--- dropped), and that fight: { id, name, tier }; or the text as it was.
function CB.takeBattleTag(text, run)
    if type(text) ~= 'string' or not text:find(CB.TAG_PATTERN) then return text, nil end
    local found = nil
    for attrs in text:gmatch(CB.TAG_PATTERN) do found = attrs end
    local attrs = attributes(found)
    local tier = tostring(attrs.tier or ''):lower()
    if not CB.TIER_LABEL[tier] then tier = 'normal' end
    local spec = { id = newId(run), name = CB.clip(CB.trim(attrs.name), 24), tier = tier }
    local cleaned = text:gsub('\n?' .. CB.TAG_PATTERN, ''):gsub('\n?' .. CB.CLOSE_TAG_PATTERN, '')
    cleaned = cleaned:gsub('%s+$', '')
    return cleaned .. '\n' .. CB.startMark(spec.id), spec
end

--- The text without a <cards> block, and the block's body.
function CB.takeCards(text)
    if type(text) ~= 'string' then return text, nil end
    local body = text:match(CB.CARDS_PATTERN)
    if not body then return text, nil end
    local cleaned = text:gsub('\n?' .. CB.CARDS_PATTERN, ''):gsub('%s+$', '')
    return cleaned, body
end

--- What the model is sent of a message: no marks.
function CB.stripMarks(text)
    if type(text) ~= 'string' then return text end
    return (text:gsub(CB.ANY_MARK_PATTERN, ''))
end

------------------------------------------------------------------------------
-- The fight
------------------------------------------------------------------------------

function CB.drawCards(run, b, n)
    for _ = 1, n do
        if #b.hand >= 10 then return end
        if #b.draw == 0 then
            if #b.discard == 0 then return end
            b.draw, b.discard = b.discard, {}
            CB.shuffle(run, b.draw)
        end
        b.hand[#b.hand + 1] = table.remove(b.draw)
    end
end

--- Damage of one hit: strength adds, weak takes a quarter off, vulnerable
--- adds half.
function CB.attackDamage(base, attacker, target)
    local damage = base + (attacker.str or 0)
    if (attacker.weak or 0) > 0 then damage = math.floor(damage * 0.75) end
    if (target.vuln or 0) > 0 then damage = math.floor(damage * 1.5) end
    return math.max(0, damage)
end

--- Block takes it first. Returns what was blocked and what was lost.
function CB.hit(target, amount)
    local blocked = math.min(target.block or 0, amount)
    target.block = (target.block or 0) - blocked
    local lost = amount - blocked
    target.hp = math.max(0, target.hp - lost)
    return blocked, lost
end

function CB.newBattle(run, spec, settings)
    local tier = CB.TIER_LABEL[spec.tier] and spec.tier or 'normal'
    local list = CB.ENEMIES[tier]
    local template = list[CB.rand(run, #list)]
    local hp = math.floor(template.hp * (1 + 0.2 * (run.level - 1)))
    if settings.healEach then run.hp = run.maxHp end
    local cards = {}
    for _, card in ipairs(run.deck) do
        local checked = card.rarity == 'basic' and CB.copy(card) or CB.cleanCard(card, { rarity = card.rarity, cost = card.cost })
        if checked then cards[#cards + 1] = checked end
    end
    local draw = {}
    for i = 1, #cards do draw[i] = i end
    CB.shuffle(run, draw)
    local b = {
        id = spec.id, at = spec.at,
        name = (spec.name and spec.name ~= '') and spec.name or template.name,
        tier = tier, phase = 'fight', open = true, turn = 1,
        energy = 3, maxEnergy = 3,
        cards = cards, draw = draw, hand = {}, discard = {},
        hp = run.hp, maxHp = run.maxHp, block = 0, str = 0, weak = 0, vuln = 0,
        enemy = {
            hp = hp, maxHp = hp, block = 0, str = 0, weak = 0, vuln = 0,
            moves = CB.copy(template.moves), step = CB.rand(run, #template.moves), bonus = run.level - 1,
        },
        log = {}, played = {}, note = '',
    }
    CB.drawCards(run, b, 5)
    return b
end

function CB.intentText(b)
    local e = b.enemy
    local move = e.moves[e.step] or {}
    local parts = {}
    if move.atk then
        local per = CB.attackDamage(move.atk + e.bonus, e, b)
        parts[#parts + 1] = '⚔️ ' .. per .. ((move.n or 1) > 1 and ('×' .. move.n) or '')
    end
    if move.def then parts[#parts + 1] = '🛡️' end
    if move.str then parts[#parts + 1] = '💪' end
    if move.weak or move.vuln then parts[#parts + 1] = '☠️' end
    return table.concat(parts, ' ')
end

--- Play hand card k. False (with a note) when it cannot be played.
function CB.play(run, b, k)
    local id = b.hand[k]
    local card = id and b.cards[id]
    if not card then return false end
    if card.cost > b.energy then
        b.note = '에너지가 모자랍니다'
        return false
    end
    b.energy = b.energy - card.cost
    table.remove(b.hand, k)
    b.selected = nil
    local fx, e, parts = card.fx or {}, b.enemy, {}
    if fx.dmg then
        local blocked, lost = 0, 0
        for _ = 1, (fx.hits or 1) do
            local a, l = CB.hit(e, CB.attackDamage(fx.dmg, b, e))
            blocked, lost = blocked + a, lost + l
        end
        parts[#parts + 1] = '피해 ' .. lost .. (blocked > 0 and (' (막힘 ' .. blocked .. ')') or '')
    end
    if fx.block then b.block = b.block + fx.block parts[#parts + 1] = '방어 ' .. fx.block end
    if fx.weak then e.weak = e.weak + fx.weak parts[#parts + 1] = '약화 ' .. fx.weak end
    if fx.vuln then e.vuln = e.vuln + fx.vuln parts[#parts + 1] = '취약 ' .. fx.vuln end
    if fx.str then b.str = b.str + fx.str parts[#parts + 1] = '힘 +' .. fx.str end
    if fx.heal then
        local before = b.hp
        b.hp = math.min(b.maxHp, b.hp + fx.heal)
        parts[#parts + 1] = '회복 ' .. (b.hp - before)
    end
    if fx.energy then b.energy = b.energy + fx.energy parts[#parts + 1] = '에너지 +' .. fx.energy end
    b.discard[#b.discard + 1] = id
    if fx.draw then CB.drawCards(run, b, fx.draw) parts[#parts + 1] = fx.draw .. '장 뽑음' end
    local what = table.concat(parts, ', ')
    b.played[#b.played + 1] = card.name .. '(' .. what .. ')'
    b.note = card.name .. ' → ' .. what
    if e.hp <= 0 then b.phase = 'won' end
    return true
end

--- The enemy's move: defend, attack, then grow or weaken. Returns its log text.
function CB.enemyAct(b)
    local e = b.enemy
    local move = e.moves[e.step] or {}
    local parts = {}
    if move.def then
        e.block = e.block + move.def + e.bonus
        parts[#parts + 1] = '방어 ' .. (move.def + e.bonus)
    end
    if move.atk then
        local per = CB.attackDamage(move.atk + e.bonus, e, b)
        local blocked, lost = 0, 0
        for _ = 1, (move.n or 1) do
            local a, l = CB.hit(b, per)
            blocked, lost = blocked + a, lost + l
        end
        parts[#parts + 1] = '공격 ' .. per .. ((move.n or 1) > 1 and ('×' .. move.n) or '')
            .. ' (막음 ' .. blocked .. ', 받은 피해 ' .. lost .. ')'
    end
    if move.str then e.str = e.str + move.str parts[#parts + 1] = '힘 +' .. move.str end
    if move.weak then b.weak = b.weak + move.weak parts[#parts + 1] = '약화 ' .. move.weak end
    if move.vuln then
        b.vuln = b.vuln + move.vuln
        b.vulnFresh = true
        parts[#parts + 1] = '취약 ' .. move.vuln
    end
    e.step = e.step % #e.moves + 1
    return table.concat(parts, ', ')
end

-- A turn of weak or vulnerable is spent at the end of the turn it counts in:
-- the player's weak and the enemy's vulnerable on the player's turn, the
-- enemy's weak and the player's vulnerable on the enemy's (vulnerable the
-- enemy put on the player this turn waits for its next one).
function CB.endTurn(run, b)
    for _, id in ipairs(b.hand) do b.discard[#b.discard + 1] = id end
    b.hand, b.selected = {}, nil
    if b.weak > 0 then b.weak = b.weak - 1 end
    if b.enemy.vuln > 0 then b.enemy.vuln = b.enemy.vuln - 1 end
    local e = b.enemy
    e.block = 0
    local acted = CB.enemyAct(b)
    if e.weak > 0 then e.weak = e.weak - 1 end
    if b.vulnFresh then b.vulnFresh = nil elseif b.vuln > 0 then b.vuln = b.vuln - 1 end
    local mine = #b.played > 0 and table.concat(b.played, ', ') or '카드 없음'
    b.log[#b.log + 1] = b.turn .. '턴: ' .. mine .. ' / 적: ' .. acted
    b.played = {}
    b.note = '적: ' .. acted
    if b.hp <= 0 then
        b.phase = 'lost'
        return
    end
    b.turn = b.turn + 1
    b.block = 0
    b.energy = b.maxEnergy
    CB.drawCards(run, b, 5)
end

CB.OUTCOME_LABEL = { won = '승리', lost = '패배', fled = '도망' }

--- A fight is over: hit points back to the run, experience, a level up.
--- Losing leaves a third of the hit points (the story goes on).
function CB.settle(run, b)
    if #b.played > 0 then
        b.log[#b.log + 1] = b.turn .. '턴: ' .. table.concat(b.played, ', ')
        b.played = {}
    end
    b.hand, b.selected = {}, nil
    run.hp = b.hp
    if b.phase == 'lost' then run.hp = math.max(1, math.floor(run.maxHp * 0.3)) end
    b.levelUp = false
    if b.phase == 'won' then
        run.xp = run.xp + (CB.XP[b.tier] or 1)
        while run.xp >= CB.XP_PER_LEVEL do
            run.xp = run.xp - CB.XP_PER_LEVEL
            run.level = run.level + 1
            run.maxHp = run.maxHp + 5
            run.hp = math.min(run.maxHp, run.hp + 5)
            b.levelUp = true
        end
    end
    b.hp, b.maxHp = run.hp, run.maxHp
end

--- The block the next reply reads.
function CB.logBlock(run, b, user, full)
    local lines = { '⚔️ ' .. b.name .. ' (' .. CB.TIER_LABEL[b.tier] .. ') — ' .. CB.OUTCOME_LABEL[b.phase] .. ', ' .. b.turn .. '턴' }
    if full then
        for _, line in ipairs(b.log) do lines[#lines + 1] = line end
    end
    local tail = '결과: ' .. user .. ' 체력 ' .. run.hp .. '/' .. run.maxHp
    if b.levelUp then tail = tail .. ', 레벨 업 (Lv.' .. run.level .. ')' end
    if b.phase == 'lost' then tail = tail .. ', 쓰러졌다가 겨우 살아남음' end
    lines[#lines + 1] = tail
    return '<battle-log>\n' .. table.concat(lines, '\n') .. '\n</battle-log>'
end

------------------------------------------------------------------------------
-- Writing new cards
------------------------------------------------------------------------------

local function clipTail(text, limit)
    text = tostring(text or '')
    if #text <= limit then return text end
    return '…' .. text:sub(#text - limit + 1)
end

function CB.deckNames(run)
    local seen, names = {}, {}
    for _, card in ipairs(run.deck) do
        if not seen[card.name] then
            seen[card.name] = true
            names[#names + 1] = card.name
        end
    end
    return table.concat(names, ', ')
end

--- The request for the auxiliary model: the bot, the last few messages, the
--- deck so far and the three slots; the answer is a JSON array.
function CB.cardPrompt(tid, run, slots)
    local name = getName(tid) or ''
    local okDesc, desc = pcall(getDescription, tid)
    local user = getPersonaName(tid) or ''
    local messages = getFullChat(tid) or {}
    local recent = {}
    for i = math.max(1, #messages - 5), #messages do
        local m = messages[i]
        recent[#recent + 1] = (m.role == 'user' and user or name) .. ': ' .. CB.stripMarks(m.data or '')
    end
    local context = table.concat({
        '# Story: ' .. name,
        okDesc and clipTail(desc, 1500) or '',
        '# The player: ' .. user,
        '# Latest messages',
        clipTail(table.concat(recent, '\n\n'), 2400),
        '# Cards the player already has',
        CB.deckNames(run),
    }, '\n')
    return {
        { role = 'system', content = 'You design cards for a deck-building card battle game played inside a role-play story. '
            .. 'Answer with a JSON array of exactly ' .. #slots .. ' cards and nothing else.\n' .. CB.CARD_RULES },
        { role = 'user', content = context .. '\n\n# Write these cards\n' .. CB.slotText(slots)
            .. '\n\n' .. user .. ' just reached level ' .. run.level .. '. Avoid repeating the cards above.' },
    }
end

local function ask(tid, prompt)
    local ok, response = pcall(function() return axLLM(tid, prompt) end)
    if not ok or type(response) ~= 'table' or not response.success then return nil end
    return response.result
end

--- The note asking the main model for cards in its next reply.
function CB.mainCardNote(run, slots, user)
    return '[Card Battle] ' .. user .. ' reached level ' .. run.level .. '. After the story in this reply, at the very end, write the three new cards '
        .. 'as a JSON array between <cards> and </cards>; it is hidden from the reader.\n' .. CB.CARD_RULES
        .. '\n' .. CB.slotText(slots) .. '\nCards the player already has: ' .. CB.deckNames(run)
end

------------------------------------------------------------------------------
-- The request
------------------------------------------------------------------------------

function CB.instruction(b, run, settings, user)
    local lines = {
        '[Card Battle] Fights in this story are played as a card game outside the text. When ' .. user .. ' is about to fight (an enemy attacks, a duel is accepted, combat cannot be avoided), stop the reply at the moment the fight begins and end it with one tag on its own line:',
        '<battle tier="normal" name="enemy name">',
        'tier is normal for common foes, elite for strong ones, boss for a major one; name in the story\'s language. Do not narrate the fight itself.',
        'A <battle-log> block at the end of a message is a fight that already happened: tell it from the log, keep its outcome, then go on with the story.',
    }
    if b and b.phase == 'fight' then
        lines[#lines + 1] = 'A fight against ' .. b.name .. ' is going on in the game right now: do not tell how it ends.'
    end
    if b and type(b.reward) == 'table' and b.reward.waiting and settings.cards == 'main' then
        lines[#lines + 1] = CB.mainCardNote(run, b.reward.slots, user)
    end
    return table.concat(lines, '\n')
end

listenEdit('editRequest', function(tid, request, meta)
    if type(request) ~= 'table' then return request end
    for _, message in ipairs(request) do
        if type(message) == 'table' and type(message.content) == 'string' then
            message.content = CB.stripMarks(message.content)
        end
    end
    local settings = CB.settings(tid)
    local note = CB.instruction(tableState(tid, 'cb_battle'), CB.loadRun(tid), settings, getPersonaName(tid) or 'the player')
    local at = #request + 1
    for i = #request, 1, -1 do
        if type(request[i]) == 'table' and request[i].role == 'user' then at = i break end
    end
    table.insert(request, at, { role = 'system', content = note })
    return request
end)

------------------------------------------------------------------------------
-- Display
------------------------------------------------------------------------------

local BTN = 'display:inline-block;cursor:pointer;user-select:none;text-align:center;border-radius:9px;font-weight:700;padding:9px 12px;'
local PRIMARY = BTN .. 'background:#2f6fd6;color:#fff;'
local SECONDARY = BTN .. 'background:#333a52;color:#dfe4f2;'
local BAR = 'flex:1;height:9px;background:#11141f;border-radius:5px;overflow:hidden'

local function bar(value, max, color)
    local pct = max > 0 and math.floor(value / max * 100) or 0
    return '<div style="' .. BAR .. '"><div style="width:' .. pct .. '%;height:100%;background:' .. color .. '"></div></div>'
end

local function statuses(who)
    local parts = {}
    if (who.block or 0) > 0 then parts[#parts + 1] = '🛡️ 방어 ' .. who.block end
    if (who.str or 0) > 0 then parts[#parts + 1] = '💪 힘 ' .. who.str end
    if (who.weak or 0) > 0 then parts[#parts + 1] = '약화 ' .. who.weak end
    if (who.vuln or 0) > 0 then parts[#parts + 1] = '취약 ' .. who.vuln end
    return table.concat(parts, ' · ')
end

local function icon(card)
    local fx = card.fx or {}
    if fx.dmg then return '⚔️' end
    if fx.block then return '🛡️' end
    if fx.heal then return '💚' end
    return '✨'
end

--- One card face. size: 1 in the hand, larger on the reward screen.
function CB.cardFace(card, extra, size)
    size = size or 1
    local w, h = math.floor(78 * size), math.floor(112 * size)
    return '<div style="position:relative;width:' .. w .. 'px;height:' .. h .. 'px;box-sizing:border-box;border:2px solid ' .. (CB.RARITY_COLOR[card.rarity] or '#8a8f98')
        .. ';border-radius:9px;background:#f4eedf;color:#2b241c;padding:4px;box-shadow:0 2px 6px rgba(0,0,0,.5);' .. (extra or '') .. '">'
        .. '<div style="position:absolute;top:-9px;left:-9px;width:24px;height:24px;border-radius:50%;background:#2f6fd6;color:#fff;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;border:2px solid #f4eedf">' .. card.cost .. '</div>'
        .. '<div style="height:5px;border-radius:3px;background:' .. (CB.isAttack(card) and '#d9534f' or '#3c9a5f') .. ';margin:3px 4px 0 14px"></div>'
        .. '<div style="text-align:center;font-size:' .. math.floor(17 * size) .. 'px;margin-top:3px">' .. icon(card) .. '</div>'
        .. '<div style="font-size:' .. math.floor(11 * size) .. 'px;font-weight:700;text-align:center;margin-top:2px;line-height:1.2;word-break:keep-all">' .. escapeHtml(card.name) .. '</div>'
        .. '<div style="font-size:' .. math.floor(10 * size) .. 'px;text-align:center;margin-top:3px;line-height:1.3;color:#4a4036">' .. escapeHtml(CB.effectText(card)) .. '</div>'
        .. '</div>'
end

local function frame(inner)
    return '<div style="position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;background:rgba(8,10,18,.86);display:flex;align-items:center;justify-content:center;padding:10px;box-sizing:border-box;font-size:14px;line-height:1.35">'
        .. '<div style="width:100%;max-width:420px;max-height:100%;overflow-y:auto;background:#1b1f2e;color:#e9ecf5;border:1px solid #3a4160;border-radius:14px;padding:12px;box-sizing:border-box;text-align:left">'
        .. inner .. '</div></div>'
end

local function header(left, b)
    return '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#aab2cc">'
        .. '<span>' .. left .. '</span><span style="display:flex;gap:14px">'
        .. (b and ('<span risu-btn="cb|deck" style="cursor:pointer">🂠 덱 ' .. #b.cards .. '</span>') or '')
        .. '<span risu-btn="cb|close" style="cursor:pointer">✕ 닫기</span></span></div>'
end

function CB.fightView(b, run, user)
    local e = b.enemy
    local out = { header('⚔️ ' .. b.turn .. '턴 · Lv.' .. run.level, b) }
    out[#out + 1] = '<div style="margin-top:10px;background:#262b3d;border-radius:10px;padding:10px">'
        .. '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:15px">' .. escapeHtml(b.name) .. '</b>'
        .. '<span style="font-size:12px;background:#4a1f24;color:#ffb3b3;padding:2px 8px;border-radius:6px;white-space:nowrap">다음: ' .. CB.intentText(b) .. '</span></div>'
        .. '<div style="display:flex;align-items:center;gap:8px;margin-top:8px">' .. bar(e.hp, e.maxHp, '#e0524f')
        .. '<span style="font-size:12px;color:#c9cfdf">' .. e.hp .. '/' .. e.maxHp .. '</span></div>'
        .. '<div style="font-size:11px;color:#aab2cc;margin-top:5px;min-height:14px">' .. statuses(e) .. '</div></div>'
    out[#out + 1] = '<div style="margin:8px 0;min-height:18px;font-size:12px;color:#ffd98a;text-align:center">' .. escapeHtml(b.note or '') .. '</div>'
    out[#out + 1] = '<div style="display:flex;align-items:center;gap:10px">'
        .. '<div style="width:46px;height:46px;border-radius:50%;background:#f0a830;color:#3a2400;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex:none">' .. b.energy .. '/' .. b.maxEnergy .. '</div>'
        .. '<div style="flex:1;min-width:0"><div style="display:flex;justify-content:space-between;font-size:12px"><b>' .. escapeHtml(user) .. '</b>'
        .. '<span style="color:#c9cfdf">❤️ ' .. b.hp .. '/' .. b.maxHp .. '</span></div>'
        .. '<div style="display:flex;margin-top:5px">' .. bar(b.hp, b.maxHp, '#5fbf4a') .. '</div>'
        .. '<div style="font-size:11px;color:#aab2cc;margin-top:4px;min-height:14px">' .. statuses(b) .. '</div></div></div>'
    -- The hand, fanned: one tap lifts a card, a second plays it. The fan is
    -- at most 220px between the outer cards' centres, so with their tilt it
    -- fits a 375px phone (a wider spread cut the outer cards off).
    local n = #b.hand
    local step = n > 1 and math.min(50, math.floor(220 / (n - 1))) or 0
    local cards = {}
    for k, id in ipairs(b.hand) do
        local card = b.cards[id]
        local off = k - (n + 1) / 2
        local selected = b.selected == k
        local transform = selected and 'translateY(-30px) scale(1.15)'
            or ('rotate(' .. string.format('%.1f', off * 6) .. 'deg) translateY(' .. math.floor(math.abs(off) * 5) .. 'px)')
        local style = 'position:absolute;bottom:0;left:calc(50% - 39px + ' .. math.floor(off * step) .. 'px);transform:' .. transform
            .. ';transform-origin:50% 120%;z-index:' .. (selected and 50 or k) .. ';cursor:pointer;' .. (card.cost > b.energy and 'opacity:.55;' or '')
        cards[#cards + 1] = '<div risu-btn="cb|' .. (selected and 'play' or 'sel') .. '|' .. k .. '" style="' .. style .. '">' .. CB.cardFace(card) .. '</div>'
    end
    out[#out + 1] = '<div style="position:relative;height:150px;margin-top:16px">' .. table.concat(cards) .. '</div>'
    local picked = b.selected and b.cards[b.hand[b.selected]]
    if picked then
        out[#out + 1] = '<div style="font-size:12px;color:#c9cfdf;text-align:center;margin-top:6px">' .. escapeHtml(picked.name) .. ' — ' .. escapeHtml(CB.effectText(picked))
            .. (picked.desc ~= '' and ('<br><i style="color:#8d96b3">' .. escapeHtml(picked.desc) .. '</i>') or '') .. '</div>'
        out[#out + 1] = '<div style="display:flex;gap:8px;margin-top:8px"><span risu-btn="cb|play|' .. b.selected .. '" style="' .. PRIMARY .. 'flex:2">▶ 사용</span>'
            .. '<span risu-btn="cb|unsel" style="' .. SECONDARY .. 'flex:1">취소</span></div>'
    else
        out[#out + 1] = '<div style="display:flex;gap:8px;margin-top:8px"><span risu-btn="cb|end" style="' .. PRIMARY .. 'flex:2">턴 종료</span>'
            .. '<span risu-btn="cb|flee" style="' .. SECONDARY .. 'flex:1">도망</span></div>'
    end
    out[#out + 1] = '<div style="display:flex;justify-content:space-between;font-size:11px;color:#8d96b3;margin-top:8px"><span>뽑을 더미 ' .. #b.draw .. '</span><span>버린 더미 ' .. #b.discard .. '</span></div>'
    return frame(table.concat(out))
end

function CB.deckView(b)
    local faces = {}
    for _, card in ipairs(b.cards) do faces[#faces + 1] = '<div style="margin:10px 6px 0 10px">' .. CB.cardFace(card) .. '</div>' end
    return frame(header('🂠 덱 ' .. #b.cards .. '장', nil)
        .. '<div style="display:flex;flex-wrap:wrap;justify-content:center;margin-top:6px">' .. table.concat(faces) .. '</div>'
        .. '<div style="display:flex;margin-top:12px"><span risu-btn="cb|back" style="' .. SECONDARY .. 'flex:1">돌아가기</span></div>')
end

function CB.endView(b, run, settings)
    local title = ({ won = '🏆 승리', lost = '💀 패배', fled = '💨 도망' })[b.phase]
    local out = { header(title .. ' · ' .. escapeHtml(b.name), nil) }
    out[#out + 1] = '<div style="text-align:center;font-size:22px;font-weight:700;margin-top:12px">' .. title .. '</div>'
    out[#out + 1] = '<div style="text-align:center;font-size:12px;color:#aab2cc;margin-top:4px">' .. b.turn .. '턴 · 체력 ' .. run.hp .. '/' .. run.maxHp
        .. (b.levelUp and (' · 레벨 업! Lv.' .. run.level) or '') .. '</div>'
    local reward = b.reward
    if type(reward) == 'table' and reward.choices then
        local faces = {}
        for k, card in ipairs(reward.choices) do
            -- The flavour line grows, so the three 고르기 buttons line up.
            local flavour = '<div style="flex:1;width:94px;font-size:11px;line-height:1.3;color:#8d96b3;text-align:center;font-style:italic">' .. escapeHtml(card.desc) .. '</div>'
            faces[#faces + 1] = '<div style="display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:12px">' .. CB.cardFace(card, '', 1.2)
                .. flavour .. '<span risu-btn="cb|pick|' .. k .. '" style="' .. PRIMARY .. 'padding:6px 12px">고르기</span></div>'
        end
        out[#out + 1] = '<div style="text-align:center;margin-top:14px;font-size:13px">새 카드 하나를 고르세요' .. (reward.note and ('<br><span style="font-size:11px;color:#8d96b3">' .. escapeHtml(reward.note) .. '</span>') or '') .. '</div>'
        out[#out + 1] = '<div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap">' .. table.concat(faces) .. '</div>'
        out[#out + 1] = '<div style="display:flex;margin-top:12px"><span risu-btn="cb|skip" style="' .. SECONDARY .. 'flex:1">건너뛰기</span></div>'
    elseif type(reward) == 'table' and reward.making then
        out[#out + 1] = '<div style="text-align:center;margin-top:14px;font-size:13px">보조 모델이 새 카드를 쓰는 중…</div>'
    elseif type(reward) == 'table' and reward.waiting then
        out[#out + 1] = '<div style="text-align:center;margin-top:14px;font-size:13px">다음 답에서 메인 모델이 새 카드 3장을 씁니다.<br>창을 닫고 보내기를 누르세요.</div>'
        out[#out + 1] = '<div style="display:flex;margin-top:12px"><span risu-btn="cb|close" style="' .. PRIMARY .. 'flex:1">닫기</span></div>'
    else
        out[#out + 1] = '<div style="text-align:center;margin-top:14px;font-size:13px">전투 기록을 마지막 메시지에 붙였습니다.<br>창을 닫고 보내기를 누르면 이야기가 이어집니다.</div>'
        out[#out + 1] = '<div style="display:flex;margin-top:12px"><span risu-btn="cb|done" style="' .. PRIMARY .. 'flex:1">닫기</span></div>'
    end
    return frame(table.concat(out))
end

local function pill(action, text)
    return '<div style="margin:6px 0"><span risu-btn="cb|' .. action .. '" style="display:inline-block;cursor:pointer;border:1px solid rgba(224,82,79,.6);border-radius:999px;padding:5px 12px;font-size:.9em">' .. text .. '</span></div>'
end

local function startCard(spec, action)
    return '<div style="border:1px solid rgba(224,82,79,.6);border-radius:10px;padding:10px 12px;margin:6px 0">'
        .. '<div>⚔️ 전투 · <b>' .. escapeHtml(spec.name ~= '' and spec.name or '적') .. '</b> (' .. (CB.TIER_LABEL[spec.tier] or '일반') .. ')</div>'
        .. '<div style="display:flex;gap:8px;margin-top:8px"><span risu-btn="cb|' .. action .. '" style="' .. PRIMARY .. 'padding:6px 14px">전투 시작</span>'
        .. '<span risu-btn="cb|later" style="' .. SECONDARY .. 'padding:6px 14px">무시</span></div></div>'
end

--- A <battle-log> block shown folded.
function CB.logCard(body)
    local lines = {}
    for line in tostring(body or ''):gmatch('[^\n]+') do
        line = CB.trim(line)
        if line ~= '' then lines[#lines + 1] = escapeHtml(line) end
    end
    local title = table.remove(lines, 1) or '⚔️ 전투'
    return '<details style="border:1px solid rgba(127,127,127,.45);border-radius:8px;padding:6px 10px;margin:6px 0;font-size:.9em">'
        .. '<summary style="cursor:pointer">' .. title .. ' · 전투 기록</summary>'
        .. '<div style="margin-top:6px;opacity:.85">' .. table.concat(lines, '<br>') .. '</div></details>'
end

--- What is still to see of the fight on the chat's last message.
function CB.lastExtras(tid, text, b, run, settings)
    local pending = tableState(tid, 'cb_pending')
    if pending then return startCard(pending, 'start') end
    -- A tag nobody turned into a fight (written by hand, or the module was
    -- off when the reply came): start it from here.
    if type(text) == 'string' and text:find(CB.TAG_PATTERN) then
        local _, spec = CB.takeBattleTag(text, { seed = 1 })
        if spec then return startCard(spec, 'tag') end
    end
    if not b or b.done then return '' end
    local user = getPersonaName(tid) or ''
    if b.open then
        if b.phase == 'fight' then
            if b.view == 'deck' then return CB.deckView(b) end
            return CB.fightView(b, run, user)
        end
        return CB.endView(b, run, settings)
    end
    if b.phase == 'fight' then return pill('open', '⚔️ 전투로 돌아가기 · ' .. escapeHtml(b.name)) end
    if type(b.reward) == 'table' and b.reward.choices then return pill('open', '🎁 새 카드 고르기') end
    return ''
end

listenEdit('editDisplay', function(tid, text, meta)
    if type(text) ~= 'string' then return text end
    local clean = CB.stripMarks(text):gsub('\n?' .. CB.CARDS_PATTERN, '')
    -- A log image or text log (PocketRisu says so in meta.logCapture): the
    -- text as written, the fight as its log.
    if type(meta) == 'table' and meta.logCapture then
        return (clean:gsub('<battle%-log>\n?', ''):gsub('\n?</battle%-log>', ''):gsub('\n?' .. CB.TAG_PATTERN, ''))
    end
    local index = type(meta) == 'table' and tonumber(meta.index) or nil
    clean = clean:gsub(CB.LOG_PATTERN, function(body) return CB.logCard(body) end)
    if not index then return clean end
    local isLast = index == getChatLength(tid) - 1
    if not isLast then
        clean = clean:gsub('\n?' .. CB.TAG_PATTERN, '')
        local id = text:match(CB.START_PATTERN)
        local b = id and tableState(tid, 'cb_battle') or nil
        if b and b.id == id and b.phase == 'fight' then
            clean = clean .. '\n\n' .. pill('open', '⚔️ ' .. escapeHtml(b.name) .. ' · 전투 중')
        end
        return clean
    end
    local extra = CB.lastExtras(tid, text, tableState(tid, 'cb_battle'), CB.loadRun(tid), CB.settings(tid))
    clean = clean:gsub('\n?' .. CB.TAG_PATTERN, '')
    if extra ~= '' then clean = clean .. '\n\n' .. extra end
    return clean
end)

------------------------------------------------------------------------------
-- Starting, ending
------------------------------------------------------------------------------

local function lastIndex(tid)
    return getChatLength(tid) - 1
end

function CB.begin(tid, run, spec, settings)
    local b = CB.newBattle(run, spec, settings)
    setState(tid, 'cb_pending', false)
    setState(tid, 'cb_battle', b)
    setState(tid, 'cb_run', run)
    return b
end

--- After the last move: settle the run, put the log on the last message,
--- and on a level up get three new cards (or wait for the main model's).
function CB.finish(tid, run, b, settings)
    CB.settle(run, b)
    local messages = getFullChat(tid) or {}
    local last = messages[#messages]
    if last then
        local text = (last.data or ''):gsub('%s+$', '') .. '\n\n' .. CB.logBlock(run, b, getPersonaName(tid) or '', settings.fullLog)
        setChat(tid, #messages - 1, text)
    end
    if not b.levelUp then return end
    local slots = CB.rollSlots(run)
    if settings.cards == 'main' then
        b.reward = { slots = slots, waiting = true }
    elseif settings.cards == 'pool' then
        b.reward = { slots = slots, choices = CB.parseCards(run, nil, slots) }
    else
        b.reward = { slots = slots, making = true }
        setState(tid, 'cb_battle', b)
        setState(tid, 'cb_run', run)
        reloadDisplay(tid)
        local cards, written = CB.parseCards(run, ask(tid, CB.cardPrompt(tid, run, slots)), slots)
        b.reward = { slots = slots, choices = cards }
        if written < #slots then
            b.reward.note = written == 0 and '보조 모델이 카드를 쓰지 못해 기본 카드에서 골랐습니다 (모듈의 저수준 접근과 보조 모델 설정을 확인해 주세요)'
                or '보조 모델이 쓰지 못한 자리는 기본 카드로 채웠습니다'
        end
    end
end

onOutput = async(function(tid)
    local messages = getFullChat(tid)
    if type(messages) ~= 'table' or #messages == 0 then return end
    local last = messages[#messages]
    if last.role == 'user' then return end
    local settings = CB.settings(tid)
    local run = CB.loadRun(tid)
    local b = tableState(tid, 'cb_battle')
    local text, cardsBody = CB.takeCards(last.data or '')
    local spec
    text, spec = CB.takeBattleTag(text, run)
    if text ~= last.data then setChat(tid, #messages - 1, text) end

    -- The main model's cards, asked for in this reply.
    if b and type(b.reward) == 'table' and b.reward.waiting then
        local cards, written = CB.parseCards(run, cardsBody, b.reward.slots)
        b.reward = { slots = b.reward.slots, choices = cards }
        if written < #cards then
            b.reward.note = written == 0 and '메인 모델이 카드를 쓰지 않아 기본 카드에서 골랐습니다' or '메인 모델이 쓰지 못한 자리는 기본 카드로 채웠습니다'
        end
        b.open = true
        setState(tid, 'cb_battle', b)
    end

    if spec then
        spec.at = #messages
        local start = not settings.popup
        if settings.popup then
            local ok, picked = pcall(function()
                return alertSelect(tid, { '⚔️ 전투 시작 · ' .. (spec.name ~= '' and spec.name or '적'), '나중에' }):await()
            end)
            start = ok and tonumber(picked) == 0
        end
        if start then
            CB.begin(tid, run, spec, settings)
        else
            setState(tid, 'cb_pending', spec)
        end
    end
    setState(tid, 'cb_run', run)
    reloadDisplay(tid)
end)

------------------------------------------------------------------------------
-- Buttons
------------------------------------------------------------------------------

onButtonClick = async(function(tid, data)
    local action, argument = tostring(data or ''):match('^cb|(%a+)|?(.*)$')
    if not action then return end
    local settings = CB.settings(tid)
    local run = CB.loadRun(tid)
    local b = tableState(tid, 'cb_battle')
    local whole = false
    local k = tonumber(argument)

    if action == 'start' or action == 'tag' then
        local spec
        if action == 'tag' then
            local messages = getFullChat(tid) or {}
            local last = messages[#messages]
            if not last then return end
            local text
            text, spec = CB.takeBattleTag(last.data or '', run)
            if not spec then return end
            setChat(tid, #messages - 1, text)
            spec.at = #messages
        else
            spec = tableState(tid, 'cb_pending')
            if not spec then return end
        end
        b = CB.begin(tid, run, spec, settings)
        whole = true
    elseif action == 'later' then
        setState(tid, 'cb_pending', false)
    elseif not b then
        return
    elseif action == 'open' then
        b.open = true
        whole = true
    elseif action == 'close' then
        b.open = false
        b.view = nil
        whole = true
    elseif action == 'deck' then
        b.view = 'deck'
    elseif action == 'back' then
        b.view = nil
    elseif b.phase == 'fight' then
        if action == 'sel' and k then
            b.selected = k
            local card = b.cards[b.hand[k] or 0]
            b.note = (card and card.cost > b.energy) and '에너지가 모자랍니다' or ''
        elseif action == 'unsel' then
            b.selected = nil
        elseif action == 'play' and k then
            CB.play(run, b, k)
        elseif action == 'end' then
            CB.endTurn(run, b)
        elseif action == 'flee' then
            local ok, sure = pcall(function() return alertConfirm(tid, '도망칠까요? 경험치 없이 전투가 끝납니다.'):await() end)
            if ok and sure then b.phase = 'fled' end
        end
        if b.phase ~= 'fight' then
            CB.finish(tid, run, b, settings)
            whole = true
        end
    elseif action == 'pick' and k and type(b.reward) == 'table' and b.reward.choices and b.reward.choices[k] then
        run.deck[#run.deck + 1] = CB.copy(b.reward.choices[k])
        b.reward, b.done, b.open = nil, true, false
        whole = true
    elseif action == 'skip' then
        b.reward, b.done, b.open = nil, true, false
        whole = true
    elseif action == 'done' then
        b.done, b.open = true, false
        whole = true
    end

    if b then setState(tid, 'cb_battle', b) end
    setState(tid, 'cb_run', run)
    if whole then reloadDisplay(tid) else reloadChat(tid, lastIndex(tid)) end
end)
