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
-- Everything lives in hidden marks on the messages, not in chat variables:
-- the fight on the message that started it, the run (level, hit points,
-- deck) on the message whose fight last changed it. A reroll, a deleted
-- message or another swipe takes its marks along, so the numbers go back to
-- what the chat still holds. Chat state keeps only where the fight was last
-- seen (cb_live), to find it without reading the whole chat.
--
-- The window plays each tap as a scene (CSS only: messages run no script):
-- a card flies to the enemy and hits, and the enemy's turn comes as scenes
-- of their own, the button handler pausing between them. The first fight
-- puts a signature card in the deck, written by the auxiliary model or made
-- by hand in the window; a beaten enemy can be taken as a card.
--
-- 1.0 puts creatures on a field of three lanes a side. A creature card (a
-- summon card, the signature card, a beaten enemy's card) stays in a lane,
-- standing on its card, and fights until its health runs out; the enemy
-- calls creatures of its own and looks a couple of rounds ahead before it
-- picks its next move and its creatures' targets.

local CB = {}
CB.VERSION = '1.0.0'

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
-- in budget points (a point is one damage or one block). A flag is on or
-- off; ofDamage is worth that share of the card's damage. Each one is played
-- by CB.play and the turn code below: a model can only combine these, never
-- make up a rule the module does not have.
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
    { key = 'poison', max = 12, points = 2 },     -- the enemy loses that much at its turn's start, one less each turn
    { key = 'thorns', max = 5, points = 3 },      -- whoever hits the player takes that much a hit, all fight
    { key = 'armor', max = 6, points = 4 },       -- that much block at the end of each of the player's turns
    { key = 'dex', max = 3, points = 6 },         -- every block card blocks that much more, all fight
    { key = 'charge', max = 2, points = 3.5 },    -- energy next turn
    { key = 'prepare', max = 3, points = 3 },     -- cards drawn next turn
    -- A creature: summon is its health, power its attack (only with summon).
    -- It stays in a lane and attacks every turn, so attack costs most.
    { key = 'summon', max = 30, points = 1, creature = true },
    { key = 'power', max = 12, points = 3.5, creature = true },
    { key = 'hpCost', max = 12, points = -0.8 },  -- hit points paid to play it, which pay for the rest
    { key = 'pierce', flag = true, ofDamage = 0.25 }, -- its damage goes through block
    { key = 'drain', flag = true, ofDamage = 0.5 },   -- heals the damage that got through
    { key = 'retain', flag = true, points = 2 },      -- stays in hand at the end of the turn
    { key = 'exhaust', flag = true },                 -- gone for the fight once played: worth a third more
}
CB.EXHAUST_BONUS = 1.35

-- Points a card may carry by its cost, scaled by rarity, plus a little slack.
CB.BUDGET = { [0] = 5, [1] = 9, [2] = 16, [3] = 23 }
CB.RARITY_SCALE = { basic = 1, common = 1, rare = 1.3, epic = 1.6 }
CB.SLACK = 1.15

CB.RARITY_LABEL = { basic = '기본', common = '일반', rare = '희귀', epic = '영웅' }
CB.RARITY_COLOR = { basic = '#9a9184', common = '#6fa8dc', rare = '#e6b450', epic = '#c77dff' }

--- All the damage a card deals (before strength and the rest).
function CB.damageTotal(fx)
    return (fx.dmg or 0) * (fx.hits or 1)
end

function CB.points(fx)
    local total = 0
    for _, effect in ipairs(CB.EFFECTS) do
        local value = fx[effect.key]
        if value then
            if effect.ofDamage then
                total = total + CB.damageTotal(fx) * effect.ofDamage
            elseif effect.points then
                if effect.key == 'dmg' then value = CB.damageTotal(fx) end
                total = total + value * effect.points
            end
        end
    end
    return total
end

--- What a card may carry; fx (optional) adds what exhaust pays for.
function CB.budget(cost, rarity, fx)
    local budget = (CB.BUDGET[cost] or CB.BUDGET[1]) * (CB.RARITY_SCALE[rarity] or 1) * CB.SLACK
    if fx and fx.exhaust then budget = budget * CB.EXHAUST_BONUS end
    return budget
end

function CB.isAttack(card)
    return (card.fx or {}).dmg ~= nil
end

--- Whether a card puts a creature on the field.
function CB.isCreature(card)
    return type(card) == 'table' and (card.fx or {}).summon ~= nil
end

--- What a card does, the creature left out (its face shows that apart).
function CB.arrivalText(card)
    local fx, parts = card.fx or {}, {}
    if fx.hpCost then parts[#parts + 1] = '체력 ' .. fx.hpCost .. ' 소모' end
    if fx.dmg then
        local hits = fx.hits or 1
        parts[#parts + 1] = (hits > 1 and ('피해 ' .. fx.dmg .. '×' .. hits) or ('피해 ' .. fx.dmg))
            .. (fx.pierce and ' (방어 무시)' or '') .. (fx.drain and ' (흡혈)' or '')
    end
    if fx.block then parts[#parts + 1] = '방어 ' .. fx.block end
    if fx.weak then parts[#parts + 1] = '약화 ' .. fx.weak end
    if fx.vuln then parts[#parts + 1] = '취약 ' .. fx.vuln end
    if fx.poison then parts[#parts + 1] = '독 ' .. fx.poison end
    if fx.str then parts[#parts + 1] = '힘 +' .. fx.str end
    if fx.dex then parts[#parts + 1] = '민첩 +' .. fx.dex end
    if fx.thorns then parts[#parts + 1] = '가시 ' .. fx.thorns end
    if fx.armor then parts[#parts + 1] = '매 턴 방어 ' .. fx.armor end
    if fx.draw then parts[#parts + 1] = fx.draw .. '장 뽑기' end
    if fx.energy then parts[#parts + 1] = '에너지 +' .. fx.energy end
    if fx.charge then parts[#parts + 1] = '다음 턴 에너지 +' .. fx.charge end
    if fx.prepare then parts[#parts + 1] = '다음 턴 ' .. fx.prepare .. '장 더' end
    if fx.heal then parts[#parts + 1] = '체력 ' .. fx.heal .. ' 회복' end
    if fx.retain then parts[#parts + 1] = '보존' end
    if fx.exhaust then parts[#parts + 1] = '소멸' end
    return table.concat(parts, ', ')
end

function CB.effectText(card)
    local fx = card.fx or {}
    local rest = CB.arrivalText(card)
    if not fx.summon then return rest end
    return '생물 ' .. (fx.power or 0) .. '/' .. fx.summon .. (rest ~= '' and (', ' .. rest) or '')
end

-- What the card window explains when a card with these is lifted.
CB.KEYWORD_HELP = {
    summon = '생물: 비어 있는 내 레인에 남아 싸웁니다(앞 숫자는 공격력, 뒤는 체력). 체력이 0이 되면 버린 더미로 가고, 전투가 끝나면 덱으로 돌아옵니다.',
    poison = '독: 적이 자기 턴을 시작할 때 그만큼 체력을 잃고, 독은 1 줄어듭니다.',
    thorns = '가시: 이번 전투 동안 나를 때릴 때마다 그만큼 되돌려 줍니다.',
    armor = '매 턴 방어: 이번 전투 동안 내 턴이 끝날 때마다 방어를 얻습니다.',
    dex = '민첩: 이번 전투 동안 방어 카드마다 방어가 그만큼 늘어납니다.',
    pierce = '방어 무시: 적의 방어를 뚫고 들어갑니다.',
    drain = '흡혈: 들어간 피해만큼 체력을 회복합니다.',
    retain = '보존: 턴이 끝나도 버리지 않고 손에 남습니다.',
    exhaust = '소멸: 한 번 쓰면 이번 전투에서 빠집니다.',
}

function CB.keywordHelp(card)
    local lines = {}
    for _, key in ipairs({ 'summon', 'poison', 'thorns', 'armor', 'dex', 'pierce', 'drain', 'retain', 'exhaust' }) do
        if (card.fx or {})[key] then lines[#lines + 1] = CB.KEYWORD_HELP[key] end
    end
    return lines
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
    -- A creature comes as summon = { atk, hp } (how the writers are asked
    -- for it) or as the two numbers the module keeps.
    if type(source.summon) == 'table' then
        local creature = source.summon
        source = CB.copy(source)
        source.summon = creature.hp or creature.health
        source.power = source.power or creature.atk or creature.attack
    end
    local fx = {}
    for _, effect in ipairs(CB.EFFECTS) do
        local value = source[effect.key]
        if effect.flag then
            if value == true or (tonumber(value) or 0) >= 1 or value == 'true' then fx[effect.key] = 1 end
        else
            value = tonumber(value)
            if value then
                value = math.floor(value)
                if value >= 1 then fx[effect.key] = math.min(value, effect.max) end
            end
        end
    end
    if fx.hits and (not fx.dmg or fx.hits == 1) then fx.hits = nil end
    if not fx.dmg then fx.pierce, fx.drain = nil, nil end
    -- Attack needs a creature; a creature leaves the fight only by falling.
    if not fx.summon then fx.power = nil else fx.exhaust = nil end
    if not CB.hasEffect(fx) then return nil end
    local rarity = (slot and slot.rarity) or raw.rarity
    if not CB.RARITY_SCALE[rarity] then rarity = 'common' end
    local cost = math.floor(tonumber((slot and slot.cost) or raw.cost) or 1)
    cost = math.max(0, math.min(3, cost))
    while CB.points(fx) > CB.budget(cost, rarity, fx) and cost < 3 do cost = cost + 1 end
    local over = CB.points(fx) / CB.budget(cost, rarity, fx)
    if over > 1 then
        for _, effect in ipairs(CB.EFFECTS) do
            local value = fx[effect.key]
            if value and (effect.points or 0) > 0 and not effect.flag then fx[effect.key] = math.max(1, math.floor(value / over)) end
        end
    end
    -- What rounding left over: the effect worth most loses one at a time (a
    -- many-hit attack loses a hit once each hit is small). What pays (hit
    -- points) and keywords stay as they are.
    for _ = 1, 200 do
        if CB.points(fx) <= CB.budget(cost, rarity, fx) then break end
        local top, worth = nil, -1
        for _, effect in ipairs(CB.EFFECTS) do
            local value = fx[effect.key]
            if value and (effect.points or 0) > 0 and not effect.flag then
                local w = value * effect.points * (effect.key == 'dmg' and (fx.hits or 1) or 1)
                if w > worth then top, worth = effect.key, w end
            end
        end
        if not top then break end
        if top == 'dmg' and (fx.hits or 1) > 1 and fx.dmg <= 3 then
            fx.hits = fx.hits - 1
        else
            fx[top] = fx[top] - 1
            if fx[top] <= 0 then fx[top] = nil end
        end
    end
    if fx.hits and (not fx.dmg or fx.hits <= 1) then fx.hits = nil end
    if not fx.dmg then fx.pierce, fx.drain = nil, nil end
    if not fx.summon then fx.power = nil end
    if not CB.hasEffect(fx) or CB.points(fx) > CB.budget(cost, rarity, fx) then return nil end
    -- A creature card may name the figure it stands as (CB.ART).
    local art = fx.summon and CB.artKey(raw.art) or nil
    return { name = name, cost = cost, fx = fx, rarity = rarity, desc = CB.clip(CB.trim(raw.desc), 60), art = art }
end

--- What a card keeps through cleanCard, which only knows effects: whether it
--- is the signature card, and the face of the enemy it was taken from.
function CB.keepTags(card, from)
    if not card or type(from) ~= 'table' then return card end
    card.sig = from.sig == true or nil
    card.foe = from.foe == true or nil
    card.art = CB.artKey(from.art)
    if type(from.glyph) == 'string' and from.glyph ~= '' then card.glyph = CB.clip(from.glyph, 4) end
    return card
end

--- Whether a card does something: keywords and a hit point cost alone do not.
function CB.hasEffect(fx)
    for _, effect in ipairs(CB.EFFECTS) do
        if fx[effect.key] and (effect.points or 0) > 0 and not effect.flag then return true end
    end
    return false
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
        { name = '독 바르기', cost = 1, fx = { poison = 5 }, desc = '칼날에 독을 먹인다.' },
        { name = '가시 갑옷', cost = 1, fx = { thorns = 3 }, desc = '건드리면 다친다.' },
        { name = '피의 일격', cost = 1, fx = { dmg = 12, hpCost = 3 }, desc = '내 피로 값을 치른다.' },
        { name = '꿰뚫기', cost = 1, fx = { dmg = 7, pierce = 1 }, desc = '방패 틈으로 찔러 넣는다.' },
        { name = '새싹 기사', cost = 1, fx = { summon = 3, power = 2 }, art = 'sprout', desc = '작은 잎 방패를 들고 앞에 선다.' },
        { name = '불도마뱀', cost = 2, fx = { summon = 5, power = 3, dmg = 2 }, art = 'salamander', desc = '나오자마자 불을 뿜는다.' },
        { name = '돌방패 거북', cost = 1, fx = { summon = 6, power = 1 }, art = 'turtle', desc = '느리지만 무엇이든 받아 낸다.' },
    },
    rare = {
        { name = '회오리 베기', cost = 2, fx = { dmg = 6, hits = 3 }, desc = '몸을 돌려 연달아 벤다.' },
        { name = '전투의 함성', cost = 1, fx = { str = 2 }, desc = '피가 끓어오른다.' },
        { name = '반격 태세', cost = 1, fx = { block = 8, draw = 1 }, desc = '막고, 노린다.' },
        { name = '급소 공격', cost = 1, fx = { dmg = 7, vuln = 2 }, desc = '정확히 그곳을.' },
        { name = '흡혈 베기', cost = 1, fx = { dmg = 7, drain = 1 }, desc = '벤 만큼 되찾는다.' },
        { name = '철갑 두르기', cost = 1, fx = { armor = 3 }, desc = '한 겹씩 단단해진다.' },
        { name = '숨겨 둔 수', cost = 1, fx = { block = 6, charge = 1 }, desc = '지금은 막고, 다음에 몰아친다.' },
        { name = '맹독', cost = 2, fx = { poison = 9 }, desc = '천천히, 그러나 확실하게.' },
        { name = '수정 여우', cost = 1, fx = { summon = 5, power = 2 }, art = 'fox', desc = '푸른 결정 꼬리가 길을 밝힌다.' },
        { name = '폭풍 올빼미', cost = 2, fx = { summon = 7, power = 4 }, art = 'owl', desc = '바람을 타고 내리꽂힌다.' },
    },
    epic = {
        { name = '결전', cost = 2, fx = { dmg = 18, vuln = 2 }, desc = '모든 것을 건 일격.' },
        { name = '각성', cost = 1, fx = { energy = 1, draw = 2 }, desc = '시야가 맑아진다.' },
        { name = '불굴', cost = 2, fx = { block = 14, str = 1 }, desc = '쓰러지지 않는다.' },
        { name = '최후의 일격', cost = 1, fx = { dmg = 22, exhaust = 1 }, desc = '두 번은 없다.' },
        { name = '날렵한 몸놀림', cost = 1, fx = { dex = 2 }, desc = '흘려 넘기는 법을 안다.' },
        { name = '반격의 가시', cost = 2, fx = { thorns = 4, block = 10 }, desc = '막는 순간이 곧 반격이다.' },
        { name = '달빛 해파리', cost = 2, fx = { summon = 9, power = 3, heal = 5 }, art = 'jelly', desc = '은은한 빛이 상처를 감싼다.' },
    },
}

--- A card from the pool; a slot that asks for a creature (or the signature
--- card, always one) takes one of the pool's creatures.
function CB.poolCard(run, slot)
    local list = CB.POOL[slot.rarity] or CB.POOL.common
    if slot.creature or slot.sig then
        local creatures = {}
        for _, card in ipairs(list) do
            if card.fx.summon then creatures[#creatures + 1] = card end
        end
        if #creatures > 0 then list = creatures end
    end
    local card = CB.copy(list[CB.rand(run, #list)])
    card.rarity = slot.rarity
    return CB.cleanCard(card, { rarity = slot.rarity, cost = card.cost })
end

--- The three cards a level up offers: a rarity (heroic from level 3) and a
--- cost for each, which the writer fills in. Half the time one of them is
--- asked as a creature card.
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
    if CB.rand(run) < 0.5 then
        local slot = slots[CB.rand(run, 3)]
        slot.creature = true
        if slot.cost == 0 then slot.cost = 1 end
    end
    return slots
end

function CB.slotText(slots)
    local lines = {}
    for i, slot in ipairs(slots) do
        local what = ''
        if slot.sig then
            what = 'the signature card of this story, the one move that most belongs to it (the player\'s own skill, weapon or power, or what the story\'s main character does for them); '
                .. 'it is a creature card: summon is the player\'s own figure on the field, and it may have other effects too; '
        elseif slot.foe then
            what = string.format('the enemy just beaten, "%s", turned into a creature card the player can now summon: summon with its attack and health, and it may add a small effect of its own (in the fight it did: %s); ',
                slot.foe.name, slot.foe.moves or '')
        elseif slot.creature then
            what = 'a creature card (with summon, and an art key); '
        end
        lines[i] = string.format('card %d: %srarity %s, cost %d, about %d points', i, what, slot.rarity, slot.cost,
            math.floor(CB.budget(slot.cost, slot.rarity) / CB.SLACK))
    end
    return table.concat(lines, '\n')
end

CB.CARD_RULES = table.concat({
    'Each card is JSON: {"name": short name in the story\'s language (12 characters at most), "effects": {...}, "desc": one short line of flavour, "art": only for a creature card}.',
    'Effects (points per unit): dmg = damage to the enemy (1), hits = how many times dmg lands (multiplies dmg), block = blocks damage this turn (1),',
    'weak = enemy deals 25% less for that many turns (3), vuln = enemy takes 50% more for that many turns (3), str = +1 damage per hit for the rest of the fight (6),',
    'draw = draw cards (4), energy = gain energy this turn (5), heal = restore hit points (1.5),',
    'poison = the enemy loses that many hit points at the start of its turn, one less each turn (2), thorns = whoever hits the player takes that much per hit for the rest of the fight (3),',
    'armor = the player gains that much block at the end of each turn for the rest of the fight (4), dex = every block card blocks that much more for the rest of the fight (6),',
    'charge = energy next turn (3.5), prepare = draw that many more cards next turn (3), hpCost = the player loses that many hit points to play it (-0.8: it pays for the rest).',
    'Keywords, written as true: pierce = its damage ignores block (a quarter of its damage), drain = heals the damage that got through (half of its damage),',
    'retain = stays in hand at the end of the turn (2), exhaust = gone for the rest of the fight once played (the card may carry a third more points).',
    'Use only these; anything else is dropped. A card can combine a few of them.',
    'Keep each card near its points. Make them fit this story: its people, their skills, items, moments and relationships.',
}, '\n')

--- The rules with creature cards: what summon is, and the figures a
--- creature card may stand as (only those the module has art for).
function CB.cardRules()
    local figures = {}
    for _, row in ipairs(CB.artRows('ally')) do figures[#figures + 1] = row.key .. ' (' .. row.about .. ')' end
    return CB.CARD_RULES .. '\n' .. table.concat({
        'Creature cards: "summon": {"atk": attack, "hp": health} puts a creature on an empty lane of the player\'s field (three lanes); it stays, attacks every turn and fights until its health runs out (attack 3.5 points each, health 1 point each).',
        'A creature card may have other effects too, which happen when it is played. Give a creature card "art", the figure it stands as: '
            .. table.concat(figures, ', ') .. '; leave art out when none fits.',
    }, '\n')
end

--- The cards in an answer: the first [...] in it, one per slot, each made
--- safe; a slot the answer does not fill takes a pool card (a beaten
--- enemy's, the card the module made of it). An enemy's card keeps its name
--- and face. Also returns how many were written, and which.
function CB.parseCards(run, text, slots)
    local list = nil
    local body = type(text) == 'string' and text:match('%b[]') or nil
    if body then
        local ok, decoded = pcall(json.decode, body)
        if ok and type(decoded) == 'table' then list = decoded end
    end
    local cards, written, wrote = {}, 0, {}
    for i, slot in ipairs(slots) do
        local card = list and CB.cleanCard(list[i], slot) or nil
        wrote[i] = card ~= nil
        if card then
            written = written + 1
        elseif slot.foe and slot.foe.card then
            card = CB.copy(slot.foe.card)
        else
            card = CB.poolCard(run, slot)
        end
        if slot.foe then
            card.name, card.glyph, card.foe = CB.clip(slot.foe.name, 14), slot.foe.glyph, true
            card.art = slot.foe.card and slot.foe.card.art
        end
        if slot.sig then card.sig = true end
        -- The signature card and a beaten enemy always stand on the field.
        if slot.sig or slot.foe then card = CB.asCreature(card) end
        cards[i] = card
    end
    return cards, written, wrote
end

------------------------------------------------------------------------------
-- The signature card and a beaten enemy's card
------------------------------------------------------------------------------

--- The run's signature card, or nil.
function CB.sigCard(run)
    for _, card in ipairs(run.deck or {}) do
        if card.sig then return card end
    end
    return nil
end

-- A beaten enemy's card is as rare as the enemy was strong.
CB.FOE_RARITY = { normal = 'common', elite = 'rare', boss = 'epic' }

--- What an enemy did, for a card writer making its card.
function CB.movesText(moves)
    local list = {}
    for _, move in ipairs(moves or {}) do
        local parts = {}
        if move.def then parts[#parts + 1] = 'defend ' .. move.def end
        if move.atk then parts[#parts + 1] = 'attack ' .. move.atk .. ((move.n or 1) > 1 and (' x' .. move.n) or '') end
        if move.str then parts[#parts + 1] = 'strength +' .. move.str end
        if move.thorns then parts[#parts + 1] = 'thorns ' .. move.thorns end
        if move.poison then parts[#parts + 1] = 'poison ' .. move.poison end
        if move.weak then parts[#parts + 1] = 'weak ' .. move.weak end
        if move.vuln then parts[#parts + 1] = 'vulnerable ' .. move.vuln end
        if move.summon then parts[#parts + 1] = 'calls a creature (' .. tostring(move.summon) .. ')' end
        list[#list + 1] = table.concat(parts, ' + ')
    end
    return table.concat(list, '; ')
end

-- What a beaten enemy's creature costs at level 1; every three levels it
-- costs one more (to 3), and its attack and health are what that pays for.
CB.FOE_COST = { normal = 1, elite = 2, boss = 2 }

--- A beaten enemy's creature by its tier and the level it was beaten at:
--- the effects (about seven parts of ten in attack), the cost, the rarity.
function CB.foeStats(tier, level)
    local rarity = CB.FOE_RARITY[tier] or 'common'
    local cost = math.min(3, (CB.FOE_COST[tier] or 1) + math.floor((math.max(1, level or 1) - 1) / 3))
    local room = math.floor(CB.budget(cost, rarity))
    local power = math.max(1, math.floor(room * 0.7 / 3.5))
    local summon = math.max(1, math.floor(room - power * 3.5))
    return { summon = summon, power = power }, cost, rarity
end

--- A beaten enemy as a card the module makes itself: a creature as strong
--- as the enemy's tier and level, named after it, with its face. moves are
--- what it did (for a card writer, CB.movesText).
function CB.foeCard(name, tier, moves, art, level)
    local fx, cost, rarity = CB.foeStats(tier, level)
    local card = CB.cleanCard({ name = name, effects = fx, desc = '쓰러뜨린 적이 이제 내 편에서 싸운다.' }, { rarity = rarity, cost = cost })
    if not card then return nil end
    card.foe, card.glyph = true, CB.foeGlyph(name, tier)
    card.art = CB.foeArt(name, art) or CB.artKey(art)
    return card
end

--- A card made a creature (a signature or enemy card written without
--- summon, or one from before 1.0): at the same cost, three fifths of what
--- it may carry go to the creature and its other effects shrink to the
--- rest. A card that has a creature already comes back as it is.
function CB.asCreature(card)
    if type(card) ~= 'table' or CB.isCreature(card) then return card end
    local room = CB.budget(card.cost or 1, card.rarity)
    local share = room * 0.6
    local power = math.max(1, math.floor(share * 0.5 / 3.5))
    local summon = math.max(2, math.floor(share - power * 3.5))
    local fx = CB.copy(card.fx or {})
    fx.exhaust = nil
    local left, rest = room - (power * 3.5 + summon), CB.points(fx)
    if rest > left then
        for _, effect in ipairs(CB.EFFECTS) do
            local value = fx[effect.key]
            if value and (effect.points or 0) > 0 and not effect.flag then
                value = math.floor(value * math.max(0, left) / rest)
                fx[effect.key] = value >= 1 and value or nil
            end
        end
    end
    fx.summon, fx.power = summon, power
    local made = CB.cleanCard({ name = card.name, effects = fx, desc = card.desc, art = card.art }, { rarity = card.rarity, cost = card.cost })
    return CB.keepTags(made, card) or card
end

--- A card as the signature form holds it.
function CB.rawCard(card)
    return { name = card.name, cost = card.cost, effects = CB.copy(card.fx or {}), desc = card.desc }
end

-- What the signature form calls each effect, in its menus.
CB.EFFECT_LABEL = {
    dmg = '피해', hits = '타수 (피해 횟수)', block = '방어', weak = '약화', vuln = '취약', str = '힘', draw = '카드 뽑기',
    energy = '에너지', heal = '회복', poison = '독', thorns = '가시', armor = '매 턴 방어', dex = '민첩',
    charge = '다음 턴 에너지', prepare = '다음 턴 카드', hpCost = '체력 소모', summon = '생물 체력', power = '생물 공격력',
}
CB.FLAG_LABEL = { pierce = '방어 무시', drain = '흡혈', retain = '보존', exhaust = '소멸' }
CB.FLAG_ORDER = { 'pierce', 'drain', 'retain', 'exhaust' }

--- The card a submitted signature form describes, before cleanCard. field
--- reads one of its values as text.
function CB.formCard(field)
    local raw = { name = CB.trim(field('cname')), cost = math.floor(tonumber(field('cost')) or 1), effects = {}, desc = CB.trim(field('cdesc')) }
    for i = 1, 3 do
        local key, value = field('k' .. i), tonumber(field('v' .. i))
        if CB.EFFECT_LABEL[key] and value then raw.effects[key] = (raw.effects[key] or 0) + math.floor(value) end
    end
    for _, key in ipairs(CB.FLAG_ORDER) do
        if field(key) ~= '' then raw.effects[key] = true end
    end
    -- The creature: its attack (ca) and health (ch).
    local atk, hp = tonumber(field('ca')), tonumber(field('ch'))
    if (hp and hp >= 1) or (atk and atk >= 1) then
        raw.effects.summon = math.max(1, math.floor(hp or 1))
        raw.effects.power = atk and math.floor(atk) or nil
    end
    return raw
end

--- The signature card made by hand (a rare creature card), and what the
--- module had to change so it fits; nil and why when nothing usable is left.
--- Left without attack and health, the creature gets what the cost pays for.
function CB.handCard(raw)
    local card = CB.cleanCard(raw, { rarity = 'rare', cost = raw.cost })
    if not card then return nil, '이름과 피해·방어 같은 효과가 하나는 있어야 합니다.' end
    card.sig = true
    local notes = {}
    if not CB.isCreature(card) then
        card = CB.asCreature(card)
        notes[#notes + 1] = '생물 능력치를 정했습니다 (공격 ' .. (card.fx.power or 0) .. ' · 체력 ' .. card.fx.summon .. ')'
    end
    local asked = math.max(0, math.min(3, raw.cost or 1))
    if card.cost ~= asked then notes[#notes + 1] = '비용 ' .. asked .. ' → ' .. card.cost end
    for _, effect in ipairs(CB.EFFECTS) do
        local value = raw.effects[effect.key]
        if not effect.flag and type(value) == 'number' and value >= 1 and (card.fx[effect.key] or 0) < value then
            notes[#notes + 1] = '담을 수 있는 양을 넘어 숫자를 줄였습니다'
            break
        end
    end
    return card, #notes > 0 and table.concat(notes, ', ') or nil
end

------------------------------------------------------------------------------
-- Enemies
------------------------------------------------------------------------------

CB.TIER_LABEL = { normal = '일반', elite = '정예', boss = '보스' }
CB.XP = { normal = 1, elite = 2, boss = 3 }
CB.XP_PER_LEVEL = 2

-- Each enemy goes through its moves in order, from a random first one (it
-- may make the next one first, see CB.planMove). A move may defend (def),
-- attack (atk, n times), grow stronger (str), weaken (weak) or expose
-- (vuln) the player, and call a creature to its lanes (summon, a minion of
-- CB.ART). The numbers grow with the level.
CB.ENEMIES = {
    normal = {
        { name = '적', hp = 42, moves = { { atk = 7 }, { atk = 4, n = 2 }, { def = 6, atk = 5 } } },
        { name = '적', hp = 46, moves = { { def = 8 }, { atk = 9 }, { summon = 'moth' }, { weak = 2, atk = 4 } } },
        { name = '적', hp = 38, moves = { { str = 2 }, { atk = 6 }, { atk = 6 } } },
        { name = '적', hp = 40, moves = { { poison = 3 }, { summon = 'imp' }, { atk = 6 }, { atk = 5, poison = 1 } } },
    },
    elite = {
        { name = '강적', hp = 72, moves = { { atk = 12 }, { atk = 5, n = 3 }, { summon = 'imp' }, { str = 3, def = 8 }, { vuln = 2, atk = 6 } } },
        { name = '강적', hp = 80, moves = { { def = 12, atk = 6 }, { atk = 15 }, { weak = 2, vuln = 1 } } },
        { name = '강적', hp = 76, moves = { { thorns = 3, def = 10 }, { summon = 'golem', def = 6 }, { atk = 11 }, { atk = 4, n = 3 } } },
    },
    boss = {
        { name = '우두머리', hp = 130, moves = { { str = 2, def = 12 }, { atk = 16 }, { summon = 'imp' }, { atk = 6, n = 3 }, { weak = 2, vuln = 2 }, { summon = 'golem', def = 8 }, { atk = 22 } } },
    },
}

-- How much stronger an elite's or a boss's minions are: health times hp,
-- attack plus atk. Level adds a fifth of health a level and an attack
-- every two, as it does to the enemy itself.
CB.TIER_MINION = { normal = { hp = 1, atk = 0 }, elite = { hp = 1.4, atk = 1 }, boss = { hp = 1.8, atk = 2 } }

--- The creature an enemy calls with summon = key, as strong as the enemy's
--- tier and level. It is never the enemy's own figure: then the next
--- minion of CB.ART comes instead.
function CB.minion(b, key)
    local rows = CB.artRows('minion', true)
    local at = 1
    for i, row in ipairs(rows) do
        if row.key == key then at = i end
    end
    local row = rows[at]
    if row and #rows > 1 and CB.foeArt(b.name, b.art, true) == row.key then row = rows[at % #rows + 1] end
    local base = (row and row.minion) or { name = '하수인', atk = 2, hp = 6 }
    local tier = CB.TIER_MINION[b.tier] or CB.TIER_MINION.normal
    local level = math.max(1, b.level or 1)
    local hp = math.max(1, math.floor(base.hp * tier.hp * (1 + 0.2 * (level - 1))))
    return { name = base.name, art = row and row.key, atk = base.atk + tier.atk + math.floor((level - 1) / 2), hp = hp, maxHp = hp, minion = true }
end

------------------------------------------------------------------------------
-- Art
------------------------------------------------------------------------------

-- Every figure the module knows, one row each: its key, its file in art/
-- (shipped as the module asset cb-art-<file>), what it is (for the models),
-- its kind (enemy: a foe the main model may name in <battle art>; minion:
-- what an enemy may call to its lanes, with its numbers; ally: a creature
-- card's figure), the words in an enemy's name that pick it, a glyph for
-- when there is no picture, and the attribute its creature card shows.
-- New art: drop the webp into art/ and add a row here. A row whose file is
-- not in the module falls back as a missing override does (CB.hasArt).
CB.ART = {
    -- Checked in this order for an enemy's name: the wizard before the
    -- magician, who also answers to wizard when there is no wizard art.
    { key = 'wizard', file = 'foe-wizard', kind = 'enemy', about = 'robed old wizard or sorcerer', glyph = '🧙', attr = 'dark',
        words = { 'wizard', 'sorcerer', 'warlock', '마도사', '흑마법사' } },
    { key = 'magician', file = 'foe-magician', kind = 'enemy', about = 'apprentice magician girl', glyph = '🧙', attr = 'light',
        words = { 'magician', 'wizard', 'mage', '마법사', '마술사' } },
    { key = 'maid', file = 'foe-maid', kind = 'enemy', about = 'dragon maid', glyph = '🧹', attr = 'fire', words = { 'maid', '메이드', '하녀' } },
    { key = 'pitcher', file = 'foe-pitcher', kind = 'enemy', about = 'carnivorous-plant girl', glyph = '🌺', attr = 'leaf',
        words = { 'pitcher', 'carnivorous', '식충', '벌레잡이', '네펜데스' } },
    { key = 'yokai', file = 'foe-yokai', kind = 'enemy', about = 'umbrella-spirit girl', glyph = '☂️', attr = 'dark', words = { 'yokai', 'umbrella', '요괴', '우산' } },
    { key = 'golem', file = 'foe-golem', kind = 'enemy minion', about = 'moss stone golem', glyph = '🗿', attr = 'earth', words = { 'golem', '골렘' },
        minion = { name = '이끼 골렘', atk = 1, hp = 11 } },
    { key = 'imp', file = 'foe-imp', kind = 'enemy minion', about = 'ember imp', glyph = '👹', attr = 'fire', words = { 'imp', '임프' },
        minion = { name = '불씨 임프', atk = 3, hp = 5 } },
    { key = 'moth', file = 'foe-moth', kind = 'enemy minion', about = 'crystal moth', glyph = '🦋', attr = 'wind', words = { 'moth', '나방' },
        minion = { name = '수정 나방', atk = 2, hp = 7 } },
    { key = 'dragon', file = 'foe-dragon', kind = 'enemy', about = 'dragon', glyph = '🐉', attr = 'fire', words = { 'dragon', 'wyvern', 'drake', '드래곤', '와이번' } },
    { key = 'warrior', file = 'foe-warrior', kind = 'enemy', about = 'armoured warrior or knight', glyph = '🛡️', attr = 'light',
        words = { 'warrior', 'knight', 'soldier', 'swordsman', '전사', '기사', '검사', '병사' } },
    { key = 'fiend', file = 'foe-fiend', kind = 'enemy', about = 'fiend or demon', glyph = '😈', attr = 'dark', words = { 'fiend', 'demon', 'devil', '악마', '마왕', '악귀' } },
    { key = 'machine', file = 'foe-machine', kind = 'enemy', about = 'machine or robot', glyph = '🤖', attr = 'metal',
        words = { 'machine', 'robot', 'automaton', '기계', '로봇', '자동인형' } },
    { key = 'sprout', file = 'ally-sprout', kind = 'ally', about = 'plant knight', glyph = '🌱', attr = 'leaf' },
    { key = 'salamander', file = 'ally-salamander', kind = 'ally', about = 'fire lizard', glyph = '🦎', attr = 'fire' },
    { key = 'fox', file = 'ally-fox', kind = 'ally', about = 'crystal fox', glyph = '🦊', attr = 'light' },
    { key = 'owl', file = 'ally-owl', kind = 'ally', about = 'storm owl', glyph = '🦉', attr = 'wind' },
    { key = 'turtle', file = 'ally-turtle', kind = 'ally', about = 'stone shield turtle', glyph = '🐢', attr = 'earth' },
    { key = 'jelly', file = 'ally-jelly', kind = 'ally', about = 'moon jellyfish', glyph = '🌙', attr = 'water' },
}

CB.ART_BY_KEY = {}
for _, row in ipairs(CB.ART) do CB.ART_BY_KEY[row.key] = row end

--- Whether the module carries a row's picture: its own asset list says so
--- (CB.visuals reads it); when that list cannot be read, every row counts.
function CB.hasArt(row)
    if not row then return false end
    if not CB.OWN or next(CB.OWN) == nil then return true end
    return CB.OWN['cb-art-' .. row.file] == true
end

--- The rows of a kind, in order: those with a picture, or all with any.
function CB.artRows(kind, any)
    local rows = {}
    for _, row in ipairs(CB.ART) do
        if (' ' .. row.kind .. ' '):find(' ' .. kind .. ' ', 1, true) and (any or CB.hasArt(row)) then rows[#rows + 1] = row end
    end
    return rows
end

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
-- How long the scenes stay (a share of CB.HOLD), and who makes the
-- signature card.
CB.PACES = { [0] = 1, [1] = 0.55, [2] = 0 }
CB.SIG_MAKERS = { [0] = 'ai', [1] = 'hand', [2] = 'none' }
CB.VIEWS = { [0] = 'stage', [1] = 'mixed', [2] = 'board', [3] = 'simple' }
CB.ATTACKS = { [0] = 'auto', [1] = 'chosen' }

function CB.settings(tid)
    return {
        cards = CB.CARD_WRITERS[choice(tid, 'cards')] or 'aux',  -- 보조 모델, 메인 모델, 기본 카드만
        popup = choice(tid, 'popup') == 0,                      -- 띄우기, 바로 전투 화면
        healEach = choice(tid, 'hp') == 0,                      -- 전투마다 회복, 이어짐
        fullLog = choice(tid, 'log') == 0,                      -- 턴마다 요약, 결과만
        -- 턴마다, 끝나고 한 번에. 0.5 asked this as cardbattle.story with
        -- 끝나고 한 번에 first; a new key starts everyone turn by turn
        -- without reading a saved 턴마다 as the other one.
        perTurn = choice(tid, 'tell') == 0,
        pace = CB.PACES[choice(tid, 'fx')] or 1,                -- 보통, 빠르게, 끄기
        view = CB.VIEWS[choice(tid, 'view')] or 'stage',        -- 무대, 합친 판, 레인 판, 간단
        sig = CB.SIG_MAKERS[choice(tid, 'sig')] or 'ai',        -- AI가 만들기, 직접 만들기, 없음
        capture = choice(tid, 'capture') == 0,                  -- 받을지 고르기, 안 받기
        attack = CB.ATTACKS[choice(tid, 'attack')] or 'auto',   -- 자동, 직접 고르기
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

------------------------------------------------------------------------------
-- State in the messages
------------------------------------------------------------------------------

-- A mark is an HTML comment at the end of a message, invisible wherever this
-- module does not run:
--   <!--cb:b:…-->  the fight this message holds: waiting to start, going on,
--                  or its end screen until that is closed
--   <!--cb:r:…-->  the run after this message's fight
-- The body is JSON with every character that could end the comment, start a
-- template ({{…}}) or need escaping inside a JSON string written as %XX, so
-- a mark reads the same in a message's text and in getChatMain's JSON.
CB.MARK_PATTERN = '<!%-%-cb:(%a):([^>]*)%-%->'
CB.ANY_MARK_PATTERN = '\n?<!%-%-cb:[^>]*%-%->'

function CB.packMark(kind, value)
    local body = json.encode(value):gsub('[%%%-<>{}"\\]', function(c) return string.format('%%%02X', c:byte()) end)
    return '<!--cb:' .. kind .. ':' .. body .. '-->'
end

function CB.unpackMark(body)
    local text = tostring(body or ''):gsub('%%(%x%x)', function(hex) return string.char(tonumber(hex, 16)) end)
    local ok, value = pcall(json.decode, text)
    if ok and type(value) == 'table' then return value end
    return nil
end

--- The value of the last mark of this kind in a text, or nil.
function CB.readMark(text, kind)
    if type(text) ~= 'string' then return nil end
    local found = nil
    for k, body in text:gmatch(CB.MARK_PATTERN) do
        if k == kind then found = body end
    end
    return found and CB.unpackMark(found) or nil
end

--- The text with its marks of this kind replaced by one holding value, or
--- with none when value is nil.
function CB.writeMark(text, kind, value)
    text = tostring(text or ''):gsub('\n?<!%-%-cb:' .. kind .. ':[^>]*%-%->', ''):gsub('%s+$', '')
    if value == nil then return text end
    return text .. '\n' .. CB.packMark(kind, value)
end

--- A message as getChatMain gives it (JSON text): enough to look for marks
--- without decoding every message.
local function rawMessage(tid, index)
    local ok, raw = pcall(getChatMain, tid, index)
    if ok and type(raw) == 'string' then return raw end
    return nil
end

local function messageText(tid, index)
    local ok, message = pcall(getChat, tid, index)
    if ok and type(message) == 'table' and type(message.data) == 'string' then return message.data end
    return nil
end

--- The run: the newest r mark in the chat, or a new run when there is none
--- (0.2.0 kept it in chat state; that is the start for its chats).
function CB.loadRun(tid)
    for i = getChatLength(tid) - 1, 0, -1 do
        local raw = rawMessage(tid, i)
        if raw and raw:find('<!--cb:r:', 1, true) then
            local run = CB.readMark(raw, 'r')
            if run and type(run.deck) == 'table' then return run end
        end
    end
    local old = tableState(tid, 'cb_run')
    if old and type(old.deck) == 'table' then return old end
    return CB.newRun()
end

--- The fight and the index of its message, or nil. The last message is
--- read first (given as lastText when the caller has it), then the message
--- the fight was last seen on; deep also reads the whole chat back from the
--- end when that one no longer holds it (a message before it was deleted).
function CB.findFight(tid, deep, lastText)
    -- The newest mark is the one that counts; a closed one means no fight.
    local function live(b, at)
        if b and b.phase ~= 'done' then return b, at end
        return nil
    end
    local len = getChatLength(tid)
    if len == 0 then return nil end
    local b = CB.readMark(lastText or rawMessage(tid, len - 1), 'b')
    if b then return live(b, len - 1) end
    local seen = tableState(tid, 'cb_live')
    if not seen then return nil end
    local at = tonumber(seen.at)
    if at and at >= 0 and at < len - 1 then
        b = CB.readMark(rawMessage(tid, at), 'b')
        if b and b.id == seen.id then return live(b, at) end
    end
    if not deep then return nil end
    for i = len - 2, 0, -1 do
        local raw = rawMessage(tid, i)
        if raw and raw:find('<!--cb:b:', 1, true) then
            b = CB.readMark(raw, 'b')
            if b then return live(b, i) end
        end
    end
    return nil
end

--- Put the fight on message at (nil takes it off) and remember where.
function CB.saveFight(tid, at, b)
    local text = messageText(tid, at)
    if not text then return end
    setChat(tid, at, CB.writeMark(text, 'b', b))
    setState(tid, 'cb_live', (b and b.phase ~= 'done') and { id = b.id, at = at } or false)
end

--- What a fight leaves when it is closed for good: nothing, or, turn by turn
--- (older messages still hold it as it stood then), a closed mark that
--- covers them.
function CB.closedMark(b)
    if b and b.perTurn then return { id = b.id, phase = 'done' } end
    return nil
end

------------------------------------------------------------------------------
-- The battle tag
------------------------------------------------------------------------------

-- The tag the main model ends a reply with when a fight starts. It becomes
-- the fight's b mark, waiting to start.
CB.TAG_PATTERN = '<[Bb][Aa][Tt][Tt][Ll][Ee]%f[%s/>]([^>]*)>'
CB.CLOSE_TAG_PATTERN = '</[Bb][Aa][Tt][Tt][Ll][Ee]>'
CB.CARDS_PATTERN = '<cards>(.-)</cards>'
CB.LOG_PATTERN = '<battle%-log>(.-)</battle%-log>'
CB.TURN_PATTERN = '<battle%-turn>(.-)</battle%-turn>'

local function attributes(text)
    local out = {}
    for key, value in tostring(text or ''):gmatch('(%w+)%s*=%s*"([^"]*)"') do out[key:lower()] = value end
    for key, value in tostring(text or ''):gmatch("(%w+)%s*=%s*'([^']*)'") do out[key:lower()] = value end
    return out
end

-- Not from the run's generator: a fight told again after a reroll starts
-- from the same run, and must not take the old fight's id.
local function newId()
    return string.format('%04x%04x', math.random(0, 65535), math.random(0, 65535))
end

--- The text without battle tags, and the fight its last one asks for (to
--- start: { id, name, tier, phase = 'pending' }); or the text as it was.
function CB.takeBattleTag(text)
    if type(text) ~= 'string' or not text:find(CB.TAG_PATTERN) then return text, nil end
    local found = nil
    for attrs in text:gmatch(CB.TAG_PATTERN) do found = attrs end
    local attrs = attributes(found)
    local tier = tostring(attrs.tier or ''):lower()
    if not CB.TIER_LABEL[tier] then tier = 'normal' end
    local spec = { id = newId(), name = CB.clip(CB.trim(attrs.name), 24), tier = tier, phase = 'pending' }
    spec.art = CB.artKey(attrs.art)
    local cleaned = text:gsub('\n?' .. CB.TAG_PATTERN, ''):gsub('\n?' .. CB.CLOSE_TAG_PATTERN, '')
    cleaned = cleaned:gsub('%s+$', '')
    return cleaned, spec
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

-- A fight draws from its own generator (b.seed), started from the run's.
function CB.drawCards(b, n)
    for _ = 1, n do
        if #b.hand >= 10 then return end
        if #b.draw == 0 then
            if #b.discard == 0 then return end
            b.draw, b.discard = b.discard, {}
            CB.shuffle(b, b.draw)
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

--- Block takes it first (not when it pierces). Returns what was blocked and
--- what was lost.
function CB.hit(target, amount, pierce)
    local blocked = pierce and 0 or math.min(target.block or 0, amount)
    target.block = (target.block or 0) - blocked
    local lost = amount - blocked
    target.hp = math.max(0, target.hp - lost)
    return blocked, lost
end

function CB.newBattle(run, spec, settings)
    local rng = { seed = CB.rand(run, 2147483646) }
    local tier = CB.TIER_LABEL[spec.tier] and spec.tier or 'normal'
    local list = CB.ENEMIES[tier]
    local template = list[CB.rand(rng, #list)]
    local hp = math.floor(template.hp * (1 + 0.2 * (run.level - 1)))
    if settings.healEach then run.hp = run.maxHp end
    local cards = {}
    for _, card in ipairs(run.deck) do
        local checked = card.rarity == 'basic' and CB.copy(card) or CB.keepTags(CB.cleanCard(card, { rarity = card.rarity, cost = card.cost }), card)
        -- A signature or enemy card from before 1.0 has no creature yet.
        if checked and (checked.sig or checked.foe) then checked = CB.asCreature(checked) end
        if checked then cards[#cards + 1] = checked end
    end
    local draw = {}
    for i = 1, #cards do draw[i] = i end
    CB.shuffle(rng, draw)
    local b = {
        id = spec.id, level = run.level, perTurn = settings.perTurn or nil, told = 0,
        name = (spec.name and spec.name ~= '') and spec.name or template.name,
        art = CB.artKey(spec.art),
        tier = tier, phase = 'fight', open = true, turn = 1,
        energy = 3, maxEnergy = 3,
        cards = cards, draw = draw, hand = {}, discard = {},
        hp = run.hp, maxHp = run.maxHp, block = 0, str = 0, weak = 0, vuln = 0,
        poison = 0, thorns = 0, armor = 0, dex = 0, nextEnergy = 0, nextDraw = 0, exhausted = {},
        field = { false, false, false },
        enemy = {
            hp = hp, maxHp = hp, block = 0, str = 0, weak = 0, vuln = 0, poison = 0, thorns = 0,
            moves = CB.copy(template.moves), step = CB.rand(rng, #template.moves), bonus = run.level - 1,
            field = { false, false, false },
        },
        log = {}, played = {}, note = '',
        -- What the next drawing animates (cleared at the next tap, so a
        -- redraw does not play it again): the window opening, a new hand
        -- dealt, a hit on the enemy or the player and the number it shows,
        -- and the rest of a scene (CB.play, CB.endTurn).
        anim = { open = true, deal = true },
        -- Counts the window's drawings (taps and scenes), see frame.
        n = 0,
    }
    b.seed = rng.seed
    CB.drawCards(b, 5)
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
    if move.thorns then parts[#parts + 1] = '🌵' end
    if move.poison then parts[#parts + 1] = '🧪' end
    if move.weak or move.vuln then parts[#parts + 1] = '☠️' end
    -- A summon shows the creature's attack and health (the window puts its
    -- picture in place of the paw).
    if move.summon then
        local m = CB.minion(b, move.summon)
        parts[#parts + 1] = '🐾' .. m.atk .. '/' .. m.hp
    end
    return table.concat(parts, ' ')
end

--- Poison at the start of who's turn: that much hit points, then one less.
--- Returns what it took.
function CB.tickPoison(who)
    local poison = who.poison or 0
    if poison <= 0 then return 0 end
    who.hp = math.max(0, who.hp - poison)
    who.poison = poison - 1
    return poison
end

--- Play hand card k. target: for a creature card the lane it goes to
--- ('L1'..'L3', else the first empty one), for an attack card an enemy
--- creature to hit ('E1'..'E3', else the enemy itself). False (with a
--- note) when it cannot be played.
function CB.play(b, k, target)
    local id = b.hand[k]
    local card = id and b.cards[id]
    if not card then return false end
    if card.cost > b.energy then
        b.note = '에너지가 모자랍니다'
        return false
    end
    local fx, e, parts = card.fx or {}, b.enemy, {}
    local lane, aim = nil, nil
    if fx.summon then
        lane = tonumber(tostring(target or ''):match('^L(%d)$'))
        if not lane or CB.lanesOf(b)[lane] ~= false then lane = CB.freeLane(b) end
        if not lane then
            b.note = '레인이 가득 찼습니다'
            return false
        end
    elseif fx.dmg then
        aim = tonumber(tostring(target or ''):match('^E(%d)$'))
        if aim and not CB.lanesOf(e)[aim] then aim = nil end
    end
    b.energy = b.energy - card.cost
    table.remove(b.hand, k)
    b.selected, b.aiming = nil, nil
    -- The card flies to the enemy when it attacks it, else rises from the
    -- player (to the lane, for a creature).
    local anim = { cast = id, castAt = (fx.dmg and not aim) and 'foe' or 'me', enemyFrom = e.hp, playerFrom = b.hp }
    local paid = 0
    if fx.hpCost then
        -- It never takes the last hit point.
        paid = math.max(0, math.min(fx.hpCost, b.hp - 1))
        b.hp = b.hp - paid
        parts[#parts + 1] = '체력 -' .. paid
    end
    local healed, pricked = 0, 0
    if fx.dmg and aim then
        -- At a creature: no block, no thorns; what lands is what it loses.
        local t = CB.lanesOf(e)[aim]
        local lost, landed = 0, 0
        for _ = 1, (fx.hits or 1) do
            local took = math.min(t.hp, CB.attackDamage(fx.dmg, b, t))
            t.hp, lost, landed = t.hp - took, lost + took, landed + 1
            if t.hp <= 0 then break end
        end
        local fell = t.hp <= 0
        parts[#parts + 1] = t.name .. '에게 피해 ' .. lost .. (fell and ' (쓰러뜨림)' or '')
        anim.strikes = { { side = 'card', at = aim, dmg = lost, hits = landed, killed = fell or nil, victim = fell and CB.copy(t) or nil, wait = 0.25 } }
        if fell then CB.remove(b, 'foe', aim) end
        if fx.drain and lost > 0 then
            local before = b.hp
            b.hp = math.min(b.maxHp, b.hp + lost)
            healed = healed + (b.hp - before)
            if b.hp > before then parts[#parts + 1] = '흡혈 ' .. (b.hp - before) end
        end
    elseif fx.dmg then
        local blocked, lost, landed = 0, 0, 0
        local shield = e.block or 0
        for _ = 1, (fx.hits or 1) do
            local a, l = CB.hit(e, CB.attackDamage(fx.dmg, b, e), fx.pierce)
            blocked, lost, landed = blocked + a, lost + l, landed + 1
            if (e.thorns or 0) > 0 then
                local _, t = CB.hit(b, e.thorns)
                pricked = pricked + t
            end
            if e.hp <= 0 then break end
        end
        parts[#parts + 1] = '피해 ' .. lost .. (blocked > 0 and (' (막힘 ' .. blocked .. ')') or '')
        if pricked > 0 then parts[#parts + 1] = '가시에 ' .. pricked end
        anim.enemy, anim.enemyText = 'hit', lost > 0 and ('-' .. lost) or '막힘'
        anim.hits = landed
        -- A hit worth a quarter of the enemy shakes the whole window.
        anim.big = lost >= 15 or lost * 4 >= e.maxHp or nil
        anim.enemyBreak = (shield > 0 and blocked > 0 and e.block == 0) or nil
        anim.playerSpark = pricked > 0 or nil
        if fx.drain and lost > 0 then
            local before = b.hp
            b.hp = math.min(b.maxHp, b.hp + lost)
            healed = healed + (b.hp - before)
            if b.hp > before then parts[#parts + 1] = '흡혈 ' .. (b.hp - before) end
        end
    end
    local blockGain = fx.block and (fx.block + (b.dex or 0)) or nil
    if blockGain then b.block = b.block + blockGain parts[#parts + 1] = '방어 ' .. blockGain end
    if fx.weak then e.weak = e.weak + fx.weak parts[#parts + 1] = '약화 ' .. fx.weak end
    if fx.vuln then e.vuln = e.vuln + fx.vuln parts[#parts + 1] = '취약 ' .. fx.vuln end
    if fx.poison then e.poison = (e.poison or 0) + fx.poison parts[#parts + 1] = '독 ' .. fx.poison end
    if fx.str then b.str = b.str + fx.str parts[#parts + 1] = '힘 +' .. fx.str end
    if fx.dex then b.dex = (b.dex or 0) + fx.dex parts[#parts + 1] = '민첩 +' .. fx.dex end
    if fx.thorns then b.thorns = (b.thorns or 0) + fx.thorns parts[#parts + 1] = '가시 +' .. fx.thorns end
    if fx.armor then b.armor = (b.armor or 0) + fx.armor parts[#parts + 1] = '매 턴 방어 +' .. fx.armor end
    if fx.charge then b.nextEnergy = (b.nextEnergy or 0) + fx.charge parts[#parts + 1] = '다음 턴 에너지 +' .. fx.charge end
    if fx.prepare then b.nextDraw = (b.nextDraw or 0) + fx.prepare parts[#parts + 1] = '다음 턴 ' .. fx.prepare .. '장 더' end
    if fx.heal then
        local before = b.hp
        b.hp = math.min(b.maxHp, b.hp + fx.heal)
        healed = healed + (b.hp - before)
        parts[#parts + 1] = '회복 ' .. (b.hp - before)
    end
    if healed > 0 then
        anim.player, anim.playerText, anim.heal = 'buff', '+' .. healed, true
    elseif blockGain then
        anim.player, anim.playerText = 'buff', '🛡️+' .. blockGain
    elseif pricked + paid > 0 then
        anim.player, anim.playerText = 'hurt', '-' .. (pricked + paid)
    end
    if blockGain then anim.playerBlock = 'pop' end
    anim.enemyPoison = fx.poison and true or nil
    anim.enemyCurse = (fx.weak or fx.vuln) and true or nil
    anim.thornsUp = fx.thorns and true or nil
    if fx.str or fx.dex or fx.armor or fx.energy or fx.charge or fx.prepare or fx.draw then anim.playerGlow = true end
    b.anim = anim
    if fx.energy then b.energy = b.energy + fx.energy parts[#parts + 1] = '에너지 +' .. fx.energy end
    if lane then
        -- The card goes to the field, not the discard pile, until it falls.
        CB.lanesOf(b)[lane] = CB.creatureOf(card, id)
        table.insert(parts, 1, '소환 ' .. (fx.power or 0) .. '/' .. fx.summon .. ' (' .. lane .. '번 레인)')
        anim.summon = lane
    elseif fx.exhaust then
        b.exhausted = b.exhausted or {}
        b.exhausted[#b.exhausted + 1] = id
        parts[#parts + 1] = '소멸'
    else
        b.discard[#b.discard + 1] = id
    end
    if fx.draw then CB.drawCards(b, fx.draw) parts[#parts + 1] = fx.draw .. '장 뽑음' end
    local what = table.concat(parts, ', ')
    b.played[#b.played + 1] = card.name .. '(' .. what .. ')'
    b.note = card.name .. ' → ' .. what
    if e.hp <= 0 then
        b.phase = 'won'
    elseif b.hp <= 0 then
        b.phase = 'lost'
    end
    return true
end

--- The enemy's move: defend, attack, grow or weaken, then call a creature
--- (to the lane CB.summonLane picks). Returns its log text, when it
--- attacked what got through and what was blocked, what the player's
--- thorns gave back, and the lane a creature came to.
function CB.enemyAct(b)
    local e = b.enemy
    local move = e.moves[e.step] or {}
    local parts = {}
    local lostTotal, blockedTotal, prickedTotal = nil, nil, 0
    if move.def then
        e.block = e.block + move.def + e.bonus
        parts[#parts + 1] = '방어 ' .. (move.def + e.bonus)
    end
    if move.atk then
        local per = CB.attackDamage(move.atk + e.bonus, e, b)
        local blocked, lost, pricked = 0, 0, 0
        for _ = 1, (move.n or 1) do
            local a, l = CB.hit(b, per)
            blocked, lost = blocked + a, lost + l
            if (b.thorns or 0) > 0 then
                local _, t = CB.hit(e, b.thorns)
                pricked = pricked + t
            end
            if e.hp <= 0 or b.hp <= 0 then break end
        end
        parts[#parts + 1] = '공격 ' .. per .. ((move.n or 1) > 1 and ('×' .. move.n) or '')
            .. ' (막음 ' .. blocked .. ', 받은 피해 ' .. lost .. ')'
        if pricked > 0 then parts[#parts + 1] = '가시에 ' .. pricked end
        lostTotal, blockedTotal, prickedTotal = lost, blocked, pricked
    end
    if move.str then e.str = e.str + move.str parts[#parts + 1] = '힘 +' .. move.str end
    if move.thorns then e.thorns = (e.thorns or 0) + move.thorns parts[#parts + 1] = '가시 +' .. move.thorns end
    if move.poison then b.poison = (b.poison or 0) + move.poison parts[#parts + 1] = '독 ' .. move.poison end
    if move.weak then b.weak = b.weak + move.weak parts[#parts + 1] = '약화 ' .. move.weak end
    if move.vuln then
        b.vuln = b.vuln + move.vuln
        b.vulnFresh = true
        parts[#parts + 1] = '취약 ' .. move.vuln
    end
    local summoned = nil
    if move.summon and b.hp > 0 and e.hp > 0 then
        local m = CB.minion(b, move.summon)
        summoned = CB.summonLane(b, m)
        if summoned then
            m.fresh = true
            CB.lanesOf(e)[summoned] = m
            parts[#parts + 1] = '소환 ' .. m.name .. ' ' .. m.atk .. '/' .. m.hp .. ' (' .. summoned .. '번 레인)'
        else
            parts[#parts + 1] = '소환할 레인 없음'
        end
    end
    -- A move it put off (CB.planMove) is made now, and may be put off again.
    if e.held == e.step then e.held = nil end
    e.step = e.step % #e.moves + 1
    return table.concat(parts, ', '), lostTotal, blockedTotal, prickedTotal, summoned
end

------------------------------------------------------------------------------
-- The field
------------------------------------------------------------------------------

-- Each side has three lanes (b.field, b.enemy.field): a creature or false
-- for an empty lane, so the list stays a JSON array. A creature is
-- { name, atk, hp, maxHp }, with card (its card in b.cards) on the
-- player's side or minion and art on the enemy's; fresh until its side's
-- next turn, acted once it attacked this turn. A fight from before 1.0 has
-- no field: it gets empty lanes when it is next played.
CB.LANES = 3

function CB.lanesOf(who)
    if type(who.field) ~= 'table' then who.field = {} end
    for i = 1, CB.LANES do
        if type(who.field[i]) ~= 'table' then who.field[i] = false end
    end
    return who.field
end

function CB.freeLane(b)
    for i, c in ipairs(CB.lanesOf(b)) do
        if not c then return i end
    end
    return nil
end

function CB.anyCreature(who)
    for _, c in ipairs(CB.lanesOf(who)) do
        if c then return true end
    end
    return false
end

function CB.creatureOf(card, id)
    local fx = card.fx or {}
    return { card = id, name = card.name, atk = fx.power or 0, hp = fx.summon, maxHp = fx.summon, fresh = true }
end

--- A fallen creature leaves its lane; the player's card goes to the
--- discard pile.
function CB.remove(b, side, lane)
    local lanes = CB.lanesOf(side == 'mine' and b or b.enemy)
    local c = lanes[lane]
    lanes[lane] = false
    if c and c.card and side == 'mine' and b.discard then b.discard[#b.discard + 1] = c.card end
    return c
end

--- What a creature is worth on the board, to the search.
function CB.worth(c)
    return c and ((c.atk or 0) * 2 + c.hp) or 0
end

--- One creature of side ('mine' or 'foe') in lane attacks: the other
--- side's hero ('H'; its block and the hero's vulnerable count, its thorns
--- prick back) or the creature in lane at. Returns what happened, for the
--- log and the scene, or nil when there was nothing to hit.
function CB.strike(b, side, lane, at)
    local own, other = b, b.enemy
    if side == 'foe' then own, other = b.enemy, b end
    local c = CB.lanesOf(own)[lane]
    if not c then return nil end
    local hit = { side = side, lane = lane, at = at, name = c.name }
    if at == 'H' then
        local blocked, lost = CB.hit(other, CB.attackDamage(c.atk, c, other))
        hit.dmg, hit.blocked = lost, blocked
        if (other.thorns or 0) > 0 then
            hit.pricked = math.min(c.hp, other.thorns)
            c.hp = c.hp - hit.pricked
        end
    else
        local t = CB.lanesOf(other)[at]
        if not t then return nil end
        hit.target = t.name
        hit.dmg = math.min(t.hp, math.max(0, c.atk))
        t.hp = t.hp - hit.dmg
        if t.hp <= 0 then
            hit.killed, hit.victim = true, CB.copy(t)
            CB.remove(b, side == 'mine' and 'foe' or 'mine', at)
        end
    end
    c.acted = true
    if c.hp <= 0 then
        hit.died, hit.self = true, CB.copy(c)
        CB.remove(b, side, lane)
    end
    return hit
end

--- A hit as the log tells it: 새싹 기사 공격 → 적 3 (막힘 2).
function CB.hitText(hit)
    local who = hit.at == 'H' and (hit.side == 'mine' and '적' or '나') or hit.target
    local text = hit.name .. ' 공격 → ' .. who .. ' ' .. hit.dmg
    if (hit.blocked or 0) > 0 then text = text .. ' (막힘 ' .. hit.blocked .. ')' end
    if hit.killed then text = text .. ', ' .. hit.target .. ' 쓰러짐' end
    if hit.pricked then text = text .. ', 가시에 ' .. hit.pricked end
    if hit.died then text = text .. ', ' .. hit.name .. ' 쓰러짐' end
    return text
end

--- 자동: the creature across the lane, or the hero behind it.
function CB.laneTarget(b, side, lane)
    local other = side == 'mine' and b.enemy or b
    return CB.lanesOf(other)[lane] and lane or 'H'
end

--- A quick pick of a target, for the search's own play: the hero when that
--- ends the fight, else the creature worth most it can finish, else the
--- hero.
function CB.quickTarget(b, side, lane)
    local own, other = b, b.enemy
    if side == 'foe' then own, other = b.enemy, b end
    local c = CB.lanesOf(own)[lane]
    if CB.attackDamage(c.atk, c, other) >= other.hp + (other.block or 0) then return 'H' end
    local best, worth = 'H', -1
    for j, t in ipairs(CB.lanesOf(other)) do
        if t and t.hp <= c.atk and CB.worth(t) > worth then best, worth = j, CB.worth(t) end
    end
    return best
end

--- Every creature of a side attacks, from lane 1 (at the end of its
--- side's turn). 자동: across its lane. 직접 고르기: the player's attack
--- by hand during the turn (the search plays them with the quick pick);
--- the enemy's, not fresh, pick with the search. Returns the hits.
function CB.sideAttacks(b, side)
    local hits = {}
    local lanes = CB.lanesOf(side == 'mine' and b or b.enemy)
    for i = 1, CB.LANES do
        local c = lanes[i]
        local at = nil
        if c and (c.atk or 0) > 0 then
            if not b.chosen then
                at = CB.laneTarget(b, side, i)
            elseif not c.fresh and not c.acted and (side == 'foe' or b.sim) then
                at = b.sim and CB.quickTarget(b, side, i) or CB.bestTarget(b, i)
            end
        end
        if at then
            local hit = CB.strike(b, side, i, at)
            if hit then hits[#hits + 1] = hit end
            if b.hp <= 0 or b.enemy.hp <= 0 then break end
        end
    end
    return hits
end

--- 직접 고르기: the player's creature in lane attacks at ('H' or an enemy
--- lane), once a turn and not on the turn it came. False when it cannot.
function CB.attack(b, lane, at)
    local c = CB.lanesOf(b)[lane]
    if not c or c.fresh or c.acted or (c.atk or 0) <= 0 then return false end
    if at ~= 'H' and not CB.lanesOf(b.enemy)[at] then return false end
    local anim = { enemyFrom = b.enemy.hp, playerFrom = b.hp }
    local hit = CB.strike(b, 'mine', lane, at)
    b.aiming, b.selected = nil, nil
    b.played[#b.played + 1] = CB.hitText(hit)
    b.note = CB.hitText(hit)
    b.anim = CB.strikeAnim({ hit }, anim)
    if b.enemy.hp <= 0 then b.phase = 'won' end
    return true
end

------------------------------------------------------------------------------
-- The turn, in phases (the turn's scenes and the search both go through
-- them)
------------------------------------------------------------------------------

--- The end of the player's turn: 자동, their creatures attack; the hand
--- goes but for what it keeps, armor blocks, and the player's weak and the
--- enemy's vulnerable count a turn. Returns the hits, the cards tossed and
--- whether armor blocked.
function CB.endOfMine(b)
    local hits = CB.sideAttacks(b, 'mine')
    local tossed = {}
    if b.hand then
        local kept = {}
        for _, id in ipairs(b.hand) do
            local card = b.cards[id]
            if card and (card.fx or {}).retain then
                kept[#kept + 1] = id
            else
                b.discard[#b.discard + 1] = id
                tossed[#tossed + 1] = id
            end
        end
        b.hand = kept
    end
    b.selected, b.aiming = nil, nil
    local armored = (b.armor or 0) > 0
    if armored then b.block = b.block + b.armor end
    if b.weak > 0 then b.weak = b.weak - 1 end
    if b.enemy.vuln > 0 then b.enemy.vuln = b.enemy.vuln - 1 end
    b.enemy.block = 0
    return hits, tossed, armored
end

--- The enemy's turn begins: its creatures may attack from now, and its
--- poison bites (what it took).
function CB.startOfTheirs(b)
    for _, c in ipairs(CB.lanesOf(b.enemy)) do
        if c then c.fresh = nil end
    end
    return CB.tickPoison(b.enemy)
end

--- The end of the enemy's turn, after its creatures: its weak and the
--- player's vulnerable count a turn (not vulnerable it put on this turn).
function CB.endOfTheirs(b)
    if b.enemy.weak > 0 then b.enemy.weak = b.enemy.weak - 1 end
    if b.vulnFresh then b.vulnFresh = nil elseif b.vuln > 0 then b.vuln = b.vuln - 1 end
end

--- The player's turn begins: a new turn, block gone, their creatures ready,
--- and their poison bites (what it took).
function CB.startOfMine(b)
    b.turn = (b.turn or 1) + 1
    b.block = 0
    for _, c in ipairs(CB.lanesOf(b)) do
        if c then c.fresh, c.acted = nil, nil end
    end
    return CB.tickPoison(b)
end

------------------------------------------------------------------------------
-- The enemy's search
------------------------------------------------------------------------------

-- The enemy looks ahead with the module's own rules: it copies the fight
-- (without the cards: what the player draws and plays is not known, so
-- only their creatures answer), plays each choice out and scores the end.
-- Nothing in it is random, so the same fight always picks the same.
-- CB.searched counts the rounds played out (a test bounds it).
CB.searched = 0

function CB.simCopy(b)
    local s = { sim = true }
    for _, key in ipairs({ 'hp', 'maxHp', 'block', 'str', 'weak', 'vuln', 'poison', 'thorns', 'armor', 'dex', 'vulnFresh', 'chosen', 'tier', 'level', 'name', 'art', 'turn' }) do
        s[key] = b[key]
    end
    s.field = CB.copy(CB.lanesOf(b))
    s.enemy = CB.copy(b.enemy)
    CB.lanesOf(s.enemy)
    return s
end

--- How good a fight stands for the enemy: hit points on both sides and the
--- creatures each has; the end of the fight outweighs everything. Block and
--- the other states count only through what they did in the rounds played
--- (scored as they stand at the end, a move made later would look better
--- for its block or its weak not yet spent).
function CB.score(s)
    if s.hp <= 0 then return 1000 end
    if s.enemy.hp <= 0 then return -1000 end
    local e = s.enemy
    local v = e.hp - s.hp
    for i = 1, CB.LANES do
        v = v + CB.worth(CB.lanesOf(e)[i] or nil) - CB.worth(CB.lanesOf(s)[i] or nil)
    end
    return v
end

local function over(s)
    return s.hp <= 0 or s.enemy.hp <= 0
end

--- A round for the search, from the player's turn to the end of the
--- enemy's, the enemy making move k.
local function playRound(s, k)
    CB.searched = CB.searched + 1
    CB.startOfMine(s)
    if over(s) then return end
    CB.endOfMine(s)
    if over(s) then return end
    CB.startOfTheirs(s)
    if over(s) then return end
    s.enemy.step = k
    CB.enemyAct(s)
    if over(s) then return end
    CB.sideAttacks(s, 'foe')
    CB.endOfTheirs(s)
end

--- The enemy's next move, at the end of its turn (the intent shows it):
--- it keeps to its moves in order, but may make the one after first; the
--- one it passes over comes right after and is never passed over twice.
--- Both orders are played out for two rounds and the better wins (ties
--- keep the order); a win sooner counts more, a loss sooner counts worse.
function CB.planMove(b)
    local e = b.enemy
    local n = #(e.moves or {})
    if n < 2 or e.held == e.step then return end
    local i, j = e.step, e.step % n + 1
    local best, bestScore = i, nil
    for _, order in ipairs({ { i, j }, { j, i } }) do
        local s, score = CB.simCopy(b), nil
        for round = 1, 2 do
            playRound(s, order[round])
            if over(s) then score = CB.score(s) / round break end
        end
        score = score or CB.score(s)
        if not bestScore or score > bestScore then best, bestScore = order[1], score end
    end
    if best == j then
        e.moves[i], e.moves[j] = e.moves[j], e.moves[i]
        e.held = j
    end
end

--- Where the enemy puts a creature it calls: each empty lane is played out
--- (its creatures attacking this turn, the player's answering next) and the
--- best is taken. Inside the search: the first empty lane across from a
--- creature of the player's, else the first empty one.
function CB.summonLane(b, minion)
    local free = {}
    for i, c in ipairs(CB.lanesOf(b.enemy)) do
        if not c then free[#free + 1] = i end
    end
    if #free == 0 then return nil end
    if b.sim or #free == 1 then
        for _, i in ipairs(free) do
            if CB.lanesOf(b)[i] then return i end
        end
        return free[1]
    end
    local best, bestScore = free[1], nil
    for _, i in ipairs(free) do
        local s = CB.simCopy(b)
        local m = CB.copy(minion)
        m.fresh = true
        s.enemy.field[i] = m
        CB.searched = CB.searched + 1
        CB.sideAttacks(s, 'foe')
        if not over(s) then CB.startOfMine(s) CB.endOfMine(s) end
        local score = CB.score(s)
        if not bestScore or score > bestScore then best, bestScore = i, score end
    end
    return best
end

--- 직접 고르기: the target an enemy creature in lane picks. Each one is
--- played out (its attack, the rest of its side's with the quick pick, the
--- player's creatures answering) and the best taken; the hero on a tie.
function CB.bestTarget(b, lane)
    local options = { 'H' }
    for j, c in ipairs(CB.lanesOf(b)) do
        if c then options[#options + 1] = j end
    end
    local best, bestScore = 'H', nil
    for _, at in ipairs(options) do
        local s = CB.simCopy(b)
        CB.searched = CB.searched + 1
        CB.strike(s, 'foe', lane, at)
        for k = lane + 1, CB.LANES do
            local c = s.enemy.field[k]
            if over(s) then break end
            if c and not c.fresh and (c.atk or 0) > 0 then CB.strike(s, 'foe', k, CB.quickTarget(s, 'foe', k)) end
        end
        if not over(s) then CB.startOfMine(s) CB.endOfMine(s) end
        local score = CB.score(s)
        if not bestScore or score > bestScore then best, bestScore = at, score end
    end
    return best
end

-- A turn of weak or vulnerable is spent at the end of the turn it counts in:
-- the player's weak and the enemy's vulnerable on the player's turn, the
-- enemy's weak and the player's vulnerable on the enemy's (vulnerable the
-- enemy put on the player this turn waits for its next one). Poison takes
-- its due at the start of its bearer's turn; armor is block for the enemy's.
--
-- How long each scene stays on screen (ms, before the pace setting): the
-- enemy's turn coming, its move, a scene that ends the fight, and the
-- first of a side's creature attacks (each more adds 300).
CB.HOLD = { foe = 950, act = 900, over = 1000, strike = 850 }

--- The player's turn ends; the enemy's comes, then the player's next. It
--- goes in three scenes: the hand goes and the enemy's poison bites (1),
--- the enemy moves (2), the new hand comes (3). Creature attacks come as
--- scenes of their own: 'ours' first (자동), 'theirs' after the enemy's
--- move. scene(n, anim, hold) is called at each with what it animates and
--- how long it wants on screen; a scene that ends the fight is the last.
function CB.turnScenes(b, scene)
    local e = b.enemy
    local enemyFrom, playerFrom = e.hp, b.hp
    -- 자동: the player's creatures attack first, in a scene of their own
    -- (the hand falls away in it).
    local hits, tossed, armored = CB.endOfMine(b)
    for _, hit in ipairs(hits) do b.played[#b.played + 1] = CB.hitText(hit) end
    local mine = #b.played > 0 and table.concat(b.played, ', ') or '카드 없음'
    b.played = {}
    if #hits > 0 then
        local strikes = CB.strikeAnim(hits, { busy = true, toss = tossed, enemyFrom = enemyFrom, playerFrom = playerFrom,
            playerBlock = armored and 'pop' or nil })
        tossed, armored = nil, false
        b.note = hits[#hits] and CB.hitText(hits[#hits]) or ''
        if e.hp <= 0 then
            b.log[#b.log + 1] = b.turn .. '턴: ' .. mine
            b.phase = 'won'
            return scene('ours', strikes, CB.HOLD.over)
        end
        scene('ours', strikes, CB.HOLD.strike + 300 * (#hits - 1))
    end

    local first = { banner = 'foe', foeTurn = true, toss = tossed, playerBlock = armored and 'pop' or nil }
    local before = e.hp
    local poisoned = CB.startOfTheirs(b)
    if poisoned > 0 then first.enemy, first.enemyText, first.enemyFrom, first.enemyPoison = 'hit', '-' .. poisoned, before, true end
    if e.hp <= 0 then
        b.log[#b.log + 1] = b.turn .. '턴: ' .. mine .. ' / 적: 독 ' .. poisoned .. '에 쓰러짐'
        b.note = '적이 독에 쓰러졌습니다'
        b.phase = 'won'
        return scene(1, first, CB.HOLD.over)
    end
    scene(1, first, CB.HOLD.foe)

    local move = e.moves[e.step] or {}
    local second = { foeTurn = true, enemyFrom = e.hp, playerFrom = b.hp }
    local shield = b.block
    local acted, lost, blocked, pricked, summoned = CB.enemyAct(b)
    if poisoned > 0 then acted = '독 ' .. poisoned .. ', ' .. acted end
    if lost then
        second.lunge = math.min(move.n or 1, 4)
        second.player, second.playerText = 'hurt', lost > 0 and ('-' .. lost) or '막음'
        second.flash = lost > 0 or nil
        second.big = (lost >= 15 or lost * 4 >= b.maxHp) or nil
        second.playerBreak = (shield > 0 and blocked > 0 and b.block == 0) or nil
    end
    if pricked > 0 then second.enemy, second.enemyText, second.enemySpark = 'hit', '-' .. pricked, true end
    if move.def then second.enemyBlock = 'pop' end
    if move.str or move.thorns then second.enemyGlow = true end
    if move.poison then second.playerPoison = true end
    if move.weak or move.vuln then second.playerCurse = true end
    second.foeSummon = summoned
    local hold = CB.HOLD.act + 280 * ((second.lunge or 1) - 1)
    local function close(text)
        b.log[#b.log + 1] = b.turn .. '턴: ' .. mine .. ' / 적: ' .. text
        b.note = '적: ' .. text
    end
    if b.hp <= 0 or e.hp <= 0 then
        CB.endOfTheirs(b)
        close(acted)
        b.phase = b.hp <= 0 and 'lost' or 'won'
        return scene(2, second, CB.HOLD.over)
    end
    -- Its creatures attack at the end of its turn, after its move is seen.
    local creatures = CB.anyCreature(e)
    if creatures then
        b.note = '적: ' .. acted
        scene(2, second, hold)
    end
    enemyFrom, playerFrom = e.hp, b.hp
    local theirs = CB.sideAttacks(b, 'foe')
    CB.endOfTheirs(b)
    for _, hit in ipairs(theirs) do acted = acted .. ', ' .. CB.hitText(hit) end
    close(acted)
    if b.hp <= 0 then b.phase = 'lost' elseif e.hp <= 0 then b.phase = 'won' end
    if not creatures then
        if b.phase ~= 'fight' then return scene(2, second, CB.HOLD.over) end
        scene(2, second, hold)
    elseif #theirs > 0 then
        local strikes = CB.strikeAnim(theirs, { foeTurn = true, enemyFrom = enemyFrom, playerFrom = playerFrom })
        if b.phase ~= 'fight' then return scene('theirs', strikes, CB.HOLD.over) end
        scene('theirs', strikes, CB.HOLD.strike + 300 * (#theirs - 1))
    end

    -- What it does next, now that its turn is over (the intent shows it).
    CB.planMove(b)
    local third = { banner = 'mine', deal = true, refill = true }
    local hpBefore = b.hp
    local hurt = CB.startOfMine(b)
    if hurt > 0 then
        b.note = b.note .. ' / 독 ' .. hurt
        third.player, third.playerText, third.playerFrom, third.playerPoison = 'hurt', '-' .. hurt, hpBefore, true
        if b.hp <= 0 then
            b.log[#b.log + 1] = b.turn .. '턴: 독 ' .. hurt .. '에 쓰러짐'
            b.phase = 'lost'
            third.banner, third.deal, third.refill = nil, nil, nil
            return scene(3, third, CB.HOLD.over)
        end
    end
    b.energy = b.maxEnergy + (b.nextEnergy or 0)
    b.nextEnergy = 0
    CB.drawCards(b, 5 + (b.nextDraw or 0))
    b.nextDraw = 0
    scene(3, third, 0)
end

--- A scene of creature attacks: each attacker lunges in turn, a third of a
--- second apart; its target shakes and shows the number, and the fallen
--- fade. Hits on a hero add up on that hero.
function CB.strikeAnim(hits, anim)
    local onEnemy, onPlayer, enemyAt, playerAt = nil, nil, nil, nil
    for i, hit in ipairs(hits) do
        hit.wait = (i - 1) * 0.3
        if hit.at == 'H' then
            if hit.side == 'foe' then
                onPlayer, playerAt = (onPlayer or 0) + hit.dmg, playerAt or hit.wait + 0.3
            else
                onEnemy, enemyAt = (onEnemy or 0) + hit.dmg, enemyAt or hit.wait + 0.3
            end
        end
    end
    anim.strikes = hits
    if onEnemy then anim.enemy, anim.enemyText, anim.foeAt = 'hit', onEnemy > 0 and ('-' .. onEnemy) or '막힘', enemyAt end
    if onPlayer then
        anim.player, anim.playerText, anim.meAt = 'hurt', onPlayer > 0 and ('-' .. onPlayer) or '막음', playerAt
        anim.flash = onPlayer > 0 or nil
    end
    return anim
end

--- End the player's turn (CB.turnScenes). show(n, hold), when given, is
--- called at each scene with b.anim set to it; without it b.anim ends as
--- the scenes put together, for one drawing.
function CB.endTurn(b, show)
    if show then
        return CB.turnScenes(b, function(n, anim, hold)
            b.anim = anim
            show(n, hold)
        end)
    end
    local merged = {}
    CB.turnScenes(b, function(_, anim)
        for key, value in pairs(anim) do merged[key] = value end
    end)
    b.anim = merged
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
    -- The run's generator goes on from where the fight's stopped.
    run.seed = b.seed or run.seed
    b.hp, b.maxHp, b.level = run.hp, run.maxHp, run.level
end

--- The creatures on the field, for the story: ", 내 생물: 새싹 기사 2/3,
--- 적 생물: 불씨 임프 3/5" (nothing when the field is empty).
function CB.fieldText(b)
    local out = ''
    for _, side in ipairs({ { b, '내 생물' }, { b.enemy, '적 생물' } }) do
        local list = {}
        for _, c in ipairs(CB.lanesOf(side[1])) do
            if c then list[#list + 1] = c.name .. ' ' .. c.atk .. '/' .. c.hp end
        end
        if #list > 0 then out = out .. ', ' .. side[2] .. ': ' .. table.concat(list, ' · ') end
    end
    return out
end

--- The block the next reply reads.
function CB.logBlock(run, b, user, full)
    local lines = { '⚔️ ' .. b.name .. ' (' .. CB.TIER_LABEL[b.tier] .. ') — ' .. CB.OUTCOME_LABEL[b.phase] .. ', ' .. b.turn .. '턴' }
    -- Turn by turn, the story has told the turns before; the last ones it
    -- has not are always here, whatever the log setting.
    if full or b.perTurn then
        for i = (b.perTurn and (b.told or 0) or 0) + 1, #b.log do lines[#lines + 1] = b.log[i] end
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
--- deck so far and the slots (a level up's three, a beaten enemy, the
--- signature card); the answer is a JSON array.
function CB.cardPrompt(tid, run, slots)
    CB.readAssets(tid)
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
    local why = {}
    for i, slot in ipairs(slots) do
        if slot.sig then
            why[#why + 1] = 'Card ' .. i .. ' is ' .. user .. '\'s signature card: it goes into the deck before the first fight.'
        elseif slot.foe then
            why[#why + 1] = user .. ' just beat ' .. slot.foe.name .. '; card ' .. i .. ' is that enemy itself, now on ' .. user .. '\'s side.'
        elseif not why.level then
            why.level = true
            why[#why + 1] = user .. ' just reached level ' .. run.level .. '.'
        end
    end
    why[#why + 1] = 'Avoid repeating the cards above.'
    return {
        { role = 'system', content = 'You design cards for a deck-building card battle game played inside a role-play story. '
            .. 'Answer with a JSON array of exactly ' .. #slots .. ' cards and nothing else.\n' .. CB.cardRules() },
        { role = 'user', content = context .. '\n\n# Write these cards\n' .. CB.slotText(slots)
            .. '\n\n' .. table.concat(why, ' ') },
    }
end

local function ask(tid, prompt)
    local ok, response = pcall(function() return axLLM(tid, prompt) end)
    if not ok or type(response) ~= 'table' or not response.success then return nil end
    return response.result
end

--- The note asking the main model for cards in its next reply (the reward
--- keeps the level and the deck's names from the fight's end).
function CB.mainCardNote(reward, user)
    return '[Card Battle] ' .. user .. ' reached level ' .. tostring(reward.level or '') .. '. After the story in this reply, at the very end, write the three new cards '
        .. 'as a JSON array between <cards> and </cards>; it is hidden from the reader.\n' .. CB.cardRules()
        .. '\n' .. CB.slotText(reward.slots) .. '\nCards the player already has: ' .. tostring(reward.deck or '')
end

------------------------------------------------------------------------------
-- The request
------------------------------------------------------------------------------

function CB.instruction(b, settings, user)
    local figures = {}
    for _, row in ipairs(CB.artRows('enemy')) do figures[#figures + 1] = row.key .. ' (' .. row.about .. ')' end
    local lines = {
        '[Card Battle] Fights in this story are played as a card game outside the text. When ' .. user .. ' is about to fight (an enemy attacks, a duel is accepted, combat cannot be avoided), stop the reply at the moment the fight begins and end it with one tag on its own line:',
        '<battle tier="normal" name="enemy name" art="magician">',
        'art is optional: ' .. table.concat(figures, ', ') .. '. Pick only when it fits the enemy; otherwise omit art.',
        'tier is normal for common foes, elite for strong ones, boss for a major one; name in the story\'s language. Do not narrate the fight itself.',
        'A <battle-turn> block is a turn of a fight the player just played: tell that turn as story, the moves and hits as the block has them, keep every number, and stop as the next turn begins. Never finish the fight yourself and never tell turns that have not been played.',
        'In these fights creatures stand on a field of three lanes a side: a block may tell of creatures summoned, their attacks and their falls; tell those as part of the fight.',
        'A <battle-log> block at the end of a message is a fight that already happened: tell it from the log, keep its outcome, then go on with the story.',
    }
    if b and (b.phase == 'fight' or b.phase == 'sig') then
        if b.awaitStory then
            lines[#lines + 1] = 'The fight against ' .. b.name .. ' goes on: tell the turn in the <battle-turn> block at the end of the chat, then stop; the next turn is played in the game. Do not start a new fight.'
        else
            lines[#lines + 1] = 'A fight against ' .. b.name .. ' is going on in the game right now: do not tell how it ends, and do not start a new one.'
        end
    end
    if b and type(b.reward) == 'table' and b.reward.waiting and settings.cards == 'main' then
        lines[#lines + 1] = CB.mainCardNote(b.reward, user)
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
    CB.readAssets(tid)
    local note = CB.instruction(CB.findFight(tid), settings, getPersonaName(tid) or 'the player')
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

-- The window's look: one <style> block (Risu scopes it to the chat and
-- prefixes its classes, as it does the class attributes), so the markup
-- stays small. Layout that must hold even without it (the full-screen
-- window, the fan) stays inline.
CB.CSS = ([[
.cbx-root{--g:#e3bd72;--gd:#8a6a35;--ink:#f1e6cf;--mute:#a99c86;color:var(--ink)}
.cbx-panel{position:relative;background:linear-gradient(180deg,#2c2333 0%,#1d1723 52%,#130f18 100%);border:2px solid var(--gd);border-radius:16px;box-shadow:0 0 0 1px #000,inset 0 1px 0 rgba(255,235,190,.1),inset 0 0 40px rgba(0,0,0,.55),0 18px 50px rgba(0,0,0,.7)}
.cbx-in{animation:cbIn .28s ease-out both}
.cbx-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--mute)}
.cbx-turn{color:var(--g);font-weight:800;letter-spacing:.03em}
.cbx-ic{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(227,189,114,.28);color:var(--ink);cursor:pointer;white-space:nowrap}
.cbx-arena{position:relative;margin-top:16px;padding:24px 12px 10px;border-radius:14px;border:1px solid rgba(255,255,255,.07);background:radial-gradient(ellipse at 50% 0%,rgba(120,90,140,.28),rgba(0,0,0,0) 70%),rgba(0,0,0,.28)}
.cbx-elite{background:radial-gradient(ellipse at 50% 0%,rgba(170,50,40,.38),rgba(0,0,0,0) 70%),rgba(0,0,0,.3);border-color:rgba(192,69,60,.35)}
.cbx-boss{background:radial-gradient(ellipse at 50% 0%,rgba(150,90,200,.4),rgba(0,0,0,0) 72%),rgba(0,0,0,.32);border-color:rgba(227,189,114,.45)}
.cbx-intentrow{position:absolute;top:-13px;left:0;right:0;display:flex;justify-content:center}
.cbx-intent{display:flex;align-items:center;gap:6px;padding:3px 12px;border-radius:999px;background:linear-gradient(180deg,#45171a,#220a0c);border:1px solid #c0453c;color:#ffd9d0;font-weight:800;font-size:14px;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.55);animation:cbBob 2.4s ease-in-out infinite}
.cbx-foe{display:flex;flex-direction:column;align-items:center;gap:6px}
.cbx-medal{position:relative;width:74px;height:74px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:36px;background:radial-gradient(circle at 35% 30%,#5d4b66,#221a28 70%);border:2px solid var(--gd);box-shadow:0 0 0 3px rgba(0,0,0,.45),0 6px 18px rgba(0,0,0,.6)}
.cbx-elite .cbx-medal{background:radial-gradient(circle at 35% 30%,#8f3d37,#2a1012 70%);border-color:#c0453c}
.cbx-boss .cbx-medal{background:radial-gradient(circle at 35% 30%,#6e4392,#1d0f29 70%);border-color:var(--g);box-shadow:0 0 0 3px rgba(0,0,0,.45),0 0 22px rgba(227,189,114,.5)}
.cbx-name{font-size:16px;font-weight:800;color:#fff3dc;text-shadow:0 1px 0 #000;text-align:center}
.cbx-tier{display:inline-block;font-size:10px;font-weight:700;padding:0 7px;margin-left:6px;border-radius:999px;border:1px solid currentColor;color:var(--mute);vertical-align:2px}
.cbx-elite .cbx-tier{color:#ff8a7a}
.cbx-boss .cbx-tier{color:var(--g)}
.cbx-barrow{display:flex;align-items:center;gap:6px;width:100%}
.cbx-bar{position:relative;flex:1;height:16px;border-radius:9px;overflow:hidden;background:#0b0810;border:1px solid rgba(255,255,255,.09);box-shadow:inset 0 2px 4px rgba(0,0,0,.8)}
.cbx-fill{height:100%}
.cbx-red{background:linear-gradient(180deg,#ff7d6d,#c0281f)}
.cbx-green{background:linear-gradient(180deg,#93e27c,#3a9628)}
.cbx-bartext{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;text-shadow:0 1px 2px #000}
.cbx-block{position:relative;flex:none;display:flex;align-items:center;justify-content:center;gap:1px;min-width:30px;height:22px;padding:0 5px;border-radius:7px;background:linear-gradient(180deg,#5f93dc,#2c579c);border:1px solid #a7c9ff;color:#fff;font-weight:800;font-size:12px;box-shadow:0 2px 4px rgba(0,0,0,.5)}
.cbx-chips{display:flex;gap:5px;flex-wrap:wrap;justify-content:center;min-height:18px}
.cbx-chip{font-size:11px;padding:1px 7px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);color:#eadfca;white-space:nowrap}
.cbx-note{margin:10px 2px 8px;min-height:18px;text-align:center;font-size:12px;color:#f3d79b;font-style:italic}
.cbx-me{position:relative;display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:14px;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.07)}
.cbx-who{display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:12px}
.cbx-orb{flex:none;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:17px;color:#3a1d00;background:radial-gradient(circle at 35% 30%,#fff3b8,#f6b23c 45%,#a85406 100%);border:2px solid #ffe08a;box-shadow:0 0 14px rgba(255,180,60,.55),inset 0 -3px 6px rgba(0,0,0,.3)}
.cbx-spent{filter:grayscale(.85) brightness(.7);box-shadow:none}
.cbx-card{position:relative;box-sizing:border-box;border-radius:10px;padding:3px;box-shadow:0 4px 10px rgba(0,0,0,.65)}
.cbx-atk{background:linear-gradient(160deg,#d1584b,#6a1d18)}
.cbx-skl{background:linear-gradient(160deg,#4f9fbd,#1b4557)}
.cbx-pow{background:linear-gradient(160deg,#a97ada,#45276b)}
.cbx-inner{height:100%;box-sizing:border-box;border-radius:8px;overflow:hidden;display:flex;flex-direction:column;background:#efe4cc;border:2px solid #9a9184}
.cbx-root img{margin:0!important}
.cbx-art{display:flex;align-items:center;justify-content:center}
.cbx-atk .cbx-art{background:radial-gradient(circle at 50% 35%,#f6c1b6,#b9473c)}
.cbx-skl .cbx-art{background:radial-gradient(circle at 50% 35%,#c4e6f2,#3f87a3)}
.cbx-pow .cbx-art{background:radial-gradient(circle at 50% 35%,#e3cff7,#7c4fb0)}
.cbx-cname{position:relative;margin:-8px 4px 0;padding:2px 3px;text-align:center;font-weight:800;line-height:1.15;color:#2b1d10;word-break:keep-all;background:linear-gradient(180deg,#f8e9c0,#d9b26a);border:1px solid #8a6a35;border-radius:4px;box-shadow:0 2px 3px rgba(0,0,0,.35)}
.cbx-desc{flex:1;display:flex;align-items:center;justify-content:center;padding:2px 4px;text-align:center;line-height:1.25;color:#3b2e22;font-weight:600}
.cbx-cost{position:absolute;top:-8px;left:-8px;z-index:2;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:14px;color:#fff;text-shadow:0 1px 1px #000;background:radial-gradient(circle at 35% 30%,#9ccaff,#2c62c9 60%,#163a80);border:2px solid #f8e9c0;box-shadow:0 2px 4px rgba(0,0,0,.6)}
.cbx-gem{position:absolute;bottom:-5px;left:50%;margin-left:-5px;width:10px;height:10px;transform:rotate(45deg);border:1px solid #2b1d10}
.cbx-poor{filter:grayscale(.75) brightness(.72)}
.cbx-picked .cbx-card{box-shadow:0 0 0 2px #ffe08a,0 0 18px rgba(255,214,110,.85),0 8px 18px rgba(0,0,0,.6)}
.cbx-deal{animation:cbDeal .38s cubic-bezier(.2,.8,.3,1) both}
.cbx-btn{display:flex;align-items:center;justify-content:center;gap:6px;padding:11px 14px;border-radius:12px;font-weight:800;text-align:center;cursor:pointer;user-select:none}
.cbx-gold{background:linear-gradient(180deg,#ffe49c,#d9a441 55%,#a8731f);color:#3a2205;border:1px solid #fff0bf;box-shadow:0 3px 0 #6b4510,0 6px 14px rgba(0,0,0,.45)}
.cbx-gold:active{transform:translateY(2px);box-shadow:0 1px 0 #6b4510}
.cbx-dark{background:linear-gradient(180deg,#3d3345,#251e2a);color:#eadfca;border:1px solid rgba(227,189,114,.35)}
.cbx-pile{flex:none;display:flex;flex-direction:column;align-items:center;gap:2px;font-size:10px;color:var(--mute)}
.cbx-pilen{min-width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;background:linear-gradient(180deg,#3a3042,#211a26);border:1px solid rgba(255,255,255,.16)}
.cbx-detail{margin-top:6px;padding:7px 10px;border-radius:10px;text-align:center;font-size:12px;background:rgba(0,0,0,.3);border:1px solid rgba(227,189,114,.25)}
.cbx-flavour{color:var(--mute);font-style:italic}
.cbx-shake{animation:cbShake .42s ease}
.cbx-float{position:absolute;left:50%;top:6px;z-index:5;font-size:22px;font-weight:900;color:#ff6b5b;white-space:nowrap;pointer-events:none;text-shadow:0 2px 0 #000,0 0 8px rgba(0,0,0,.8);animation:cbFloat 1.15s ease-out both}
.cbx-good{color:#9fd8ff}
.cbx-title{position:relative;text-align:center;font-size:28px;font-weight:900;margin-top:10px;color:#ffe49c;text-shadow:0 0 18px rgba(255,200,90,.55),0 2px 0 #000;animation:cbPop .5s ease-out both}
.cbx-lost .cbx-title{color:#ff9d8d;text-shadow:0 0 18px rgba(255,80,60,.5),0 2px 0 #000}
.cbx-fled .cbx-title{color:#cfd6e6;text-shadow:0 2px 0 #000}
.cbx-sub{text-align:center;font-size:12px;color:var(--mute);margin-top:4px}
.cbx-lvl{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;font-weight:800;color:#3a2205;background:linear-gradient(180deg,#ffe49c,#d9a441)}
.cbx-pulse{animation:cbPulse 1.2s ease-in-out infinite}
.cbx-medalw{position:relative}
.cbx-lunge{animation:cbLunge .5s ease-in-out both}
.cbx-act{animation:cbAct .45s ease-in-out 3}
.cbx-crit{font-size:36px;color:#ffd04d;text-shadow:0 2px 0 #000,0 0 14px rgba(255,90,40,.95)}
.cbx-heal{color:#8dff9a}
.cbx-ghost{position:absolute;left:50%;top:14px;margin-left:-34px;z-index:7;pointer-events:none;animation:cbFly .42s cubic-bezier(.35,.1,.45,1) both}
.cbx-ghostme{position:absolute;left:50%;top:-30px;margin-left:-34px;z-index:7;pointer-events:none;animation:cbCast .6s ease-out both}
.cbx-slashw{position:absolute;left:-22px;top:34px;width:118px;height:6px;z-index:6;pointer-events:none}
.cbx-slash{display:block;width:100%;height:100%;border-radius:6px;background:linear-gradient(90deg,rgba(255,255,255,0),#fff 40%,#ffd7c9 62%,rgba(255,80,60,0));box-shadow:0 0 12px rgba(255,140,100,.95);transform-origin:0 50%;animation:cbSlash .32s ease-out both}
.cbx-impact{position:absolute;left:-14px;top:-14px;right:-14px;bottom:-14px;border-radius:50%;z-index:5;pointer-events:none;background:radial-gradient(circle,rgba(255,255,240,.95),rgba(255,170,120,.5) 40%,rgba(255,80,60,0) 70%);animation:cbImpact .4s ease-out both}
.cbx-quake{animation:cbQuake .75s ease both}
.cbx-flash{position:absolute;left:0;top:0;right:0;bottom:0;z-index:8;pointer-events:none;border-radius:14px;background:rgba(255,0,0,.12);box-shadow:inset 0 0 70px rgba(255,20,20,.85);animation:cbFlash .5s ease-out both}
.cbx-banner{position:absolute;left:0;right:0;top:36%;z-index:9;pointer-events:none;padding:12px 0;text-align:center;font-size:24px;font-weight:900;letter-spacing:.12em;color:#ffe2dc;background:linear-gradient(90deg,rgba(150,20,20,0),rgba(150,20,20,.92) 18%,rgba(150,20,20,.92) 82%,rgba(150,20,20,0));text-shadow:0 2px 0 #000,0 0 14px rgba(255,80,60,.8);animation:cbBanner 1s ease-in-out both}
.cbx-mine{color:#3a2205;background:linear-gradient(90deg,rgba(240,196,96,0),rgba(240,196,96,.95) 18%,rgba(240,196,96,.95) 82%,rgba(240,196,96,0));text-shadow:0 1px 0 rgba(255,255,255,.6)}
.cbx-burst{position:absolute;left:50%;top:50%;width:0;height:0;z-index:7;pointer-events:none}
.cbx-pt{position:absolute;left:-6px;top:-6px;width:12px;height:12px;display:flex;align-items:center;justify-content:center;font-size:13px;font-style:normal;line-height:1;animation:cbOut .6s ease-out both}
.cbx-spark{color:#e6ff8a;text-shadow:0 0 6px #8dff5a}
.cbx-star{color:#ffe49c;text-shadow:0 0 8px #ffb84d;font-size:16px}
.cbx-shard{width:7px;height:7px;left:-3px;top:-3px;background:#cfe3ff;border:1px solid #fff;box-shadow:0 0 6px #7fb2ff}
.cbx-bub{position:absolute;bottom:10px;width:9px;height:9px;border-radius:50%;z-index:6;pointer-events:none;background:radial-gradient(circle at 35% 30%,#e9ffd0,#6ee05a 55%,#2f8a25);box-shadow:0 0 6px rgba(120,255,90,.8);animation:cbBubble .9s ease-out both}
.cbx-ring{position:absolute;left:50%;top:50%;width:80px;height:80px;margin:-40px 0 0 -40px;box-sizing:border-box;border-radius:50%;border:3px solid #b07cff;z-index:6;pointer-events:none;box-shadow:0 0 14px #8a4dff;animation:cbRing .7s ease-out both}
.cbx-aura{position:absolute;left:-3px;top:-3px;right:-3px;bottom:-3px;border-radius:inherit;z-index:4;pointer-events:none;animation:cbGlow .9s ease-out both}
.cbx-healaura{animation-name:cbHeal}
.cbx-trail{position:absolute;top:0;bottom:0;background:#fff1b8;transform-origin:0 50%;animation:cbTrail .7s ease-in both}
.cbx-pop{animation:cbPopIn .42s cubic-bezier(.2,1.6,.4,1) both}
.cbx-break{animation:cbBreak .55s ease-out both}
.cbx-toss{animation:cbToss .45s ease-in both}
.cbx-drift{position:absolute;top:-6px;z-index:9;pointer-events:none;font-style:normal;color:#ffe49c;text-shadow:0 0 8px #ffb84d;animation:cbDrift 2.4s ease-in both}
.cbx-reveal{animation:cbReveal .7s cubic-bezier(.2,1.2,.3,1) both}
.cbx-showcase{position:relative;display:inline-block}
.cbx-badge{position:absolute;top:-9px;right:-9px;z-index:3;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:900;color:#3a2205;background:linear-gradient(180deg,#ffe49c,#d9a441);border:1px solid #fff0bf;box-shadow:0 2px 4px rgba(0,0,0,.6)}
.cbx-sigcard .cbx-inner{box-shadow:0 0 10px rgba(255,214,110,.85)}
.cbx-form{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.cbx-row{display:flex;gap:6px;align-items:center}
.cbx-lab{flex:none;width:44px;font-size:12px;color:var(--mute)}
.cbx-field{flex:1;min-width:0;box-sizing:border-box;padding:7px 8px;border-radius:8px;border:1px solid rgba(227,189,114,.4);background:#130f18;color:#f1e6cf;font-size:16px}
.cbx-num{flex:none;width:62px}
.cbx-check{display:inline-flex;align-items:center;gap:4px;font-size:13px;margin:0 10px 4px 0}
.cbx-hint{font-size:11px;line-height:1.5;color:var(--mute)}
.cbx-sum{background:linear-gradient(160deg,#e2c27a,#7a5524 42%,#2c4a33)}
.cbx-mframe{position:relative;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:.2em;padding:.25em;border-radius:8px;border:2px solid #9a9184;background:linear-gradient(170deg,#2b4633,#14231a 70%);box-shadow:inset 0 0 0 1px rgba(232,199,122,.45)}
.cbx-sigcard .cbx-mframe{box-shadow:inset 0 0 0 1px rgba(232,199,122,.45),0 0 10px rgba(255,214,110,.85)}
.cbx-mname{flex:none;display:flex;align-items:center;gap:.2em;height:1.55em;padding:0 .2em 0 1.15em;box-sizing:border-box;border-radius:.4em .4em .25em .25em;background:linear-gradient(180deg,#faefcf,#d3b06f);border:1px solid #7a5a2a;box-shadow:0 1px 2px rgba(0,0,0,.6)}
.cbx-mtitle{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:900;line-height:1;color:#2a1a0c}
.cbx-attr{flex:none;width:1.45em;height:1.45em;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.7em;font-weight:900;line-height:1;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.75);box-shadow:inset 0 -2px 3px rgba(0,0,0,.35),0 0 3px rgba(0,0,0,.6)}
.cbx-stars{flex:none;height:1em;line-height:1em;padding-left:.35em;font-size:.75em;letter-spacing:.05em;color:#ffd76a;text-shadow:0 0 3px #ff9d2e,0 1px 0 #000}
.cbx-mart{position:relative;flex:none;height:4.1em;border-radius:.35em;overflow:hidden;display:flex;align-items:center;justify-content:center;border:1px solid #e8c77a;background:radial-gradient(circle at 50% 38%,#6b8f70,#1d2c22 75%)}
.cbx-mglyph{font-size:2.2em;line-height:1}
.cbx-mtext{flex:1;min-height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:.1em .3em;border-radius:.3em;text-align:center;font-size:.72em;font-weight:700;line-height:1.15;color:#2b1d10;word-break:keep-all;background:linear-gradient(#f4e9cc,#dbc699);border:1px solid #8a6a35}
.cbx-mtext.cbx-flavour{font-style:italic;font-weight:600;color:#5a4630}
.cbx-mstats{flex:none;display:flex;justify-content:space-between;gap:.25em}
.cbx-matk,.cbx-mhp{display:inline-flex;align-items:center;justify-content:center;gap:.1em;min-width:2.5em;height:1.45em;padding:0 .3em;box-sizing:border-box;border-radius:.4em;font-size:1em;font-weight:900;line-height:1;color:#fff;text-shadow:0 1px 1px #000,0 0 2px #000}
.cbx-matk{background:linear-gradient(180deg,#f7c552,#a35a0c);border:1px solid #ffe7a6}
.cbx-mhp{background:linear-gradient(180deg,#f06d7d,#8a1c31);border:1px solid #ffc6cd}
.cbx-mhp.cbx-low{background:linear-gradient(180deg,#9e2a2a,#430812);border-color:#ff8a8a}
.cbx-mstats .cbx-icon{width:1.1em;height:1.1em}
.cbx-tfield{display:flex;flex-direction:column;gap:4px;margin-top:10px}
.cbx-frow{display:flex;gap:4px;align-items:stretch}
.cbx-flab{flex:none;width:18px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:var(--mute)}
.cbx-cell{position:relative;flex:1;min-width:0;padding:4px 5px;border-radius:7px;font-size:11px;line-height:1.25;text-align:center;word-break:keep-all;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);color:#f1e6cf}
.cbx-empty{color:var(--mute);border-style:dashed}
.cbx-cell.cbx-target{border-color:#9fffe0;box-shadow:0 0 8px rgba(120,255,208,.6);cursor:pointer}
.cbx-cell.cbx-aimable{border-color:#ff8a7a;box-shadow:0 0 8px rgba(255,106,90,.6);cursor:pointer}
.cbx-cell.cbx-ready{border-color:#ffe08a;cursor:pointer}
.cbx-cell.cbx-aiming{border-color:#ffd04d;box-shadow:0 0 10px rgba(255,208,77,.8)}
.cbx-cell .cbx-float{font-size:16px;top:-6px}
.cbx-targets{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:5px;margin-top:7px;font-size:11px;color:var(--mute)}
.cbx-tbtn{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:800;white-space:nowrap;cursor:pointer;color:#0f3a2e;background:linear-gradient(180deg,#c8fff0,#5fd3b0);border:1px solid #e8fff6}
.cbx-tfoe{color:#fff;background:linear-gradient(180deg,#ff8a7a,#b8322a);border-color:#ffd0c8}
.cbx-foe.cbx-aimable{cursor:pointer}
.cbx-foe.cbx-aimable .cbx-medal{filter:drop-shadow(0 0 8px #ff5a4a)}
@keyframes cbLunge{0%,100%{transform:none}35%{transform:translateY(30px) scale(1.2)}55%{transform:translateY(22px) scale(1.12)}}
@keyframes cbAct{0%,100%{transform:none}50%{transform:scale(1.12)}}
@keyframes cbFly{0%{opacity:1;transform:translateY(280px) scale(1.1) rotate(-6deg)}75%{opacity:1;transform:translateY(0) scale(.8) rotate(5deg)}100%{opacity:0;transform:scale(.45) rotate(10deg)}}
@keyframes cbCast{0%{opacity:0;transform:translateY(40px) scale(.9)}35%{opacity:1}100%{opacity:0;transform:translateY(-36px) scale(1.05)}}
@keyframes cbSlash{0%{opacity:0;transform:scaleX(0)}25%{opacity:1}70%{opacity:1;transform:scaleX(1)}100%{opacity:0;transform:scaleX(1.05)}}
@keyframes cbImpact{0%{opacity:0;transform:scale(.4)}30%{opacity:1}100%{opacity:0;transform:scale(1.35)}}
@keyframes cbQuake{0%,40%,100%{transform:none}50%{transform:translate(-7px,3px) rotate(-.6deg)}60%{transform:translate(6px,-4px) rotate(.5deg)}70%{transform:translate(-5px,2px)}80%{transform:translate(4px,-2px)}90%{transform:translate(-2px,1px)}}
@keyframes cbFlash{0%{opacity:0}25%{opacity:1}100%{opacity:0}}
@keyframes cbBanner{0%{opacity:0;transform:translateX(30%) scaleY(.6)}18%{opacity:1;transform:none}80%{opacity:1;transform:none}100%{opacity:0;transform:translateX(-20%)}}
@keyframes cbOut{0%{opacity:0;transform:translateX(0) scale(.4)}20%{opacity:1}100%{opacity:0;transform:translateX(40px) scale(1)}}
@keyframes cbBubble{0%{opacity:0;transform:translateY(0) scale(.4)}20%{opacity:1}100%{opacity:0;transform:translateY(-46px) scale(1.15)}}
@keyframes cbRing{0%{opacity:0;transform:scale(1.6)}30%{opacity:1}100%{opacity:0;transform:scale(.5) rotate(90deg)}}
@keyframes cbGlow{0%{opacity:0;box-shadow:0 0 0 0 rgba(255,214,110,0)}35%{opacity:1;box-shadow:0 0 0 3px rgba(255,214,110,.8),0 0 26px rgba(255,200,90,.75)}100%{opacity:0;box-shadow:0 0 0 0 rgba(255,214,110,0)}}
@keyframes cbHeal{0%{opacity:0;box-shadow:0 0 0 0 rgba(120,255,140,0)}35%{opacity:1;box-shadow:0 0 0 3px rgba(120,255,140,.8),0 0 26px rgba(90,240,120,.75)}100%{opacity:0;box-shadow:0 0 0 0 rgba(120,255,140,0)}}
@keyframes cbTrail{0%,35%{opacity:1;transform:none}100%{opacity:0;transform:scaleX(0)}}
@keyframes cbPopIn{0%{opacity:0;transform:scale(.4)}100%{opacity:1;transform:none}}
@keyframes cbBreak{0%{opacity:1;transform:none}30%{opacity:1;transform:scale(1.25) rotate(-8deg)}100%{opacity:0;transform:scale(1.6) rotate(14deg)}}
@keyframes cbToss{0%{opacity:1;transform:none}100%{opacity:0;transform:translateY(40px) rotate(10deg) scale(.7)}}
@keyframes cbDrift{0%{opacity:0;transform:translateY(0) rotate(0)}12%{opacity:1}100%{opacity:0;transform:translateY(190px) rotate(200deg)}}
@keyframes cbReveal{0%{opacity:0;transform:perspective(600px) rotateY(90deg) scale(.6)}60%{opacity:1;transform:perspective(600px) rotateY(-12deg) scale(1.06)}100%{opacity:1;transform:none}}
@keyframes cbIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
@keyframes cbBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes cbDeal{from{opacity:0;transform:translateY(70px)}to{opacity:1;transform:none}}
@keyframes cbShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(3px)}}
@keyframes cbFloat{0%{opacity:0;transform:translate(-50%,6px) scale(.8)}15%{opacity:1;transform:translate(-50%,-4px) scale(1.15)}100%{opacity:0;transform:translate(-50%,-40px) scale(1)}}
@keyframes cbPop{from{opacity:0;transform:scale(.6)}70%{transform:scale(1.08)}to{opacity:1;transform:none}}
@keyframes cbPulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.cbx-in,.cbx-intent,.cbx-deal,.cbx-shake,.cbx-float,.cbx-title,.cbx-pulse,.cbx-lunge,.cbx-act,.cbx-quake,.cbx-pop,.cbx-reveal,.cbx-cell{animation:none}.cbx-ghost,.cbx-ghostme,.cbx-slashw,.cbx-impact,.cbx-flash,.cbx-banner,.cbx-burst,.cbx-bub,.cbx-ring,.cbx-aura,.cbx-trail,.cbx-break,.cbx-toss,.cbx-drift{display:none}}
]]):gsub('%s*\n%s*', '')


-- A face for the enemy from its name: Korean words anywhere, English ones
-- as whole words ("bat" is not in "combat"). Longer words first, so 뱀파이어
-- is not a 뱀.
CB.FOE_GLYPHS = {
    { '뱀파이어', '🧛' }, { '흡혈귀', '🧛' }, { 'vampire', '🧛' },
    { '늑대', '🐺' }, { 'wolf', '🐺' }, { '고블린', '👺' }, { 'goblin', '👺' }, { '오크', '👹' }, { 'orc', '👹' },
    { '슬라임', '🟢' }, { 'slime', '🟢' }, { '드래곤', '🐉' }, { '와이번', '🐉' }, { 'dragon', '🐉' },
    { '스켈레톤', '💀' }, { '해골', '💀' }, { 'skeleton', '💀' }, { '유령', '👻' }, { 'ghost', '👻' },
    { '좀비', '🧟' }, { 'zombie', '🧟' }, { '거미', '🕷️' }, { 'spider', '🕷️' }, { '뱀', '🐍' }, { 'snake', '🐍' },
    { '곰', '🐻' }, { 'bear', '🐻' }, { '박쥐', '🦇' }, { 'bat', '🦇' }, { '멧돼지', '🐗' }, { 'boar', '🐗' },
    { '도적', '🗡️' }, { '산적', '🗡️' }, { 'bandit', '🗡️' }, { 'thief', '🗡️' }, { '기사', '🛡️' }, { 'knight', '🛡️' },
    { '마법사', '🧙' }, { '마녀', '🧙' }, { 'mage', '🧙' }, { 'witch', '🧙' }, { '악마', '😈' }, { 'demon', '😈' },
    { '마왕', '😈' }, { '골렘', '🗿' }, { 'golem', '🗿' }, { '로봇', '🤖' }, { 'robot', '🤖' }, { '닌자', '🥷' }, { 'ninja', '🥷' },
    { '요정', '🧚' }, { 'fairy', '🧚' }, { '상어', '🦈' }, { 'shark', '🦈' }, { '괴물', '👾' }, { 'monster', '👾' },
}
CB.TIER_GLYPH = { normal = '⚔️', elite = '🔥', boss = '👑' }

function CB.foeGlyph(name, tier)
    local text = tostring(name or '')
    local lower = text:lower()
    for _, pair in ipairs(CB.FOE_GLYPHS) do
        local word = pair[1]
        if word:find('^%a+$') then
            if lower:find('%f[%a]' .. word .. '%f[%A]') then return pair[2] end
        elseif text:find(word, 1, true) then
            return pair[2]
        end
    end
    return CB.TIER_GLYPH[tier] or '⚔️'
end

CB.ART_CSS = [[
.cbx-root{font-family:system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-weight:700}
.cbx-icon{display:inline-block;width:20px;height:20px;object-fit:contain;vertical-align:middle;flex:none}
.cbx-bartext,.cbx-cost,.cbx-orb,.cbx-block,.cbx-float,.cbx-intent,.cbx-pilen{font-weight:1000;-webkit-text-stroke:2.5px #241008;paint-order:stroke fill;letter-spacing:.3px}
.cbx-float{font-size:34px;color:#fff;-webkit-text-stroke:4px #800e0a}
.cbx-crit{font-size:44px;color:#ffd45b}.cbx-good{color:#bce7ff}.cbx-heal{color:#b0ffa0}
.cbx-picture{position:relative;display:block;width:100%;height:100%;min-width:0;min-height:0}
.cbx-picture>img{display:block;width:100%;height:100%;max-width:100%;object-fit:contain;filter:drop-shadow(0 4px 5px #0009)}
.cbx-picture>img[src=""],.cbx-picture>img:not([src]){display:none}.cbx-fallback{display:none}
.cbx-picture>img[src=""]+.cbx-fallback,.cbx-picture>img:not([src])+.cbx-fallback{display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:38px}
.cbx-cover>img{object-fit:cover;filter:none}
.cbx-standee{position:relative;display:block;box-sizing:border-box;height:100%;max-width:100%;margin:auto;filter:drop-shadow(0 5px 5px #0009)}
.cbx-standee:after{content:"";position:absolute;left:12%;right:12%;bottom:-5px;height:9px;border-radius:50%;background:linear-gradient(#d6b579,#72532e);border:1px solid #332215;box-shadow:0 5px 5px #0009}
.cbx-portrait{width:76%;padding:3px 3px 7px;border:2px solid #e6c178;border-radius:20px 20px 9px 9px;background:linear-gradient(#806341,#2e2119)}
.cbx-profile{display:block;height:100%;border-radius:15px 15px 5px 5px;background-size:cover;background-position:50% 28%;background-color:#352b35}
.cbx-glyph{display:flex;align-items:center;justify-content:center;width:76%;border:2px solid #b99254;border-radius:18px;background:radial-gradient(circle at 40% 30%,#645068,#241b2e);font-size:48px}
.cbx-stage{position:relative;height:306px;margin-top:10px;overflow:hidden;border-radius:14px;background:#182022;isolation:isolate}
.cbx-bg,.cbx-vignette{position:absolute;inset:0;pointer-events:none}
.cbx-bg{background-size:cover;background-position:50% 72%}
.cbx-vignette{z-index:2;background:radial-gradient(ellipse at 50% 45%,transparent 42%,#070510b8 100%)}
.cbx-stage .cbx-foe,.cbx-player,.cbx-companion{position:absolute;display:flex;flex-direction:column;align-items:center;gap:4px;z-index:3;min-width:0}
.cbx-stage .cbx-foe{right:2%;bottom:10px;width:34%}
.cbx-player{left:17%;bottom:10px;width:30%}
.cbx-companion{left:1%;bottom:37%;width:25%;z-index:2;filter:brightness(.76) saturate(.85)}
.cbx-figure{position:relative;width:100%;height:140px;transform-origin:50% 100%}
.cbx-companion .cbx-figure{height:105px}
.cbx-figure:after,.cbx-stage .cbx-medalw:after{content:"";position:absolute;left:10%;right:10%;bottom:-8px;height:15px;z-index:-1;border-radius:50%;background:radial-gradient(ellipse,#0009,transparent 70%)}
.cbx-stage .cbx-medal{width:100%;height:142px;border:0;border-radius:0;background:none;box-shadow:none}
.cbx-stage .cbx-medalw{width:100%;transform-origin:50% 100%}
.cbx-stage .cbx-medalw.cbx-lunge{animation-name:cbSideLunge}
.cbx-stage .cbx-name{max-width:100%;font-size:11px;line-height:1.2;overflow-wrap:anywhere}
.cbx-stage .cbx-tier{font-size:9px;margin-left:3px;padding:0 3px}
.cbx-stage .cbx-barrow{gap:1px}.cbx-stage .cbx-bar{height:15px;border:2px solid #190b08;box-shadow:0 2px 3px #0008}
.cbx-stage .cbx-bartext{font-size:10px}
.cbx-stage .cbx-block{padding:0;min-width:24px;background:none;border:0;box-shadow:none;font-size:12px}
.cbx-stage .cbx-block .cbx-icon{width:24px;height:24px;margin-right:-17px}
.cbx-stage .cbx-intent{font-size:16px;padding:1px 5px;border-color:#e27669;background:#200c12b8;gap:2px;max-width:100%;flex-wrap:wrap;justify-content:center;white-space:normal;text-align:center}
.cbx-stage .cbx-intent .cbx-icon{width:27px;height:27px}
.cbx-stage .cbx-chips{gap:2px;min-height:0}.cbx-stage .cbx-chip{font-size:9px;padding:0 3px;background:#0c0b12c9}
.cbx-stage .cbx-chip .cbx-icon{width:17px;height:17px}
.cbx-tag{box-sizing:border-box;max-width:100%;font-size:10px;color:#f7e5c2;border-radius:7px;padding:1px 5px;border:1px solid #b08a4b99;background:#160d09b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}
.cbx-visual>.cbx-note:empty{display:none}
.cbx-stage .cbx-slashw{left:0;top:50%;width:100%}.cbx-stage .cbx-float{top:25%;left:35%}
.cbx-stage .cbx-ghost{left:74%;top:100px;animation-name:cbSideFly}
.cbx-tray{position:relative;border-top:2px solid #5c4328;border-radius:10px;padding:3px 2px 8px;background:linear-gradient(#191320,#0e0b12);box-shadow:inset 0 10px 18px #0006}
.cbx-tray>.cbx-orb{position:absolute;left:3px;top:7px;z-index:4;width:44px;height:44px;font-size:17px;color:#fff}
.cbx-tray .cbx-hand{margin-top:0!important;height:153px!important}
.cbx-tray .cbx-card{box-shadow:inset 0 0 0 2px #35200c,0 6px 10px #000a}
.cbx-art{position:relative;overflow:hidden}.cbx-art .cbx-picture{position:absolute;inset:0}.cbx-art .cbx-standee{width:70%;height:94%}
.cbx-tray .cbx-inner{background:linear-gradient(#38291c,#211710);border-color:#d5ae68}.cbx-tray .cbx-desc{color:#efe3c8;font-size:9px!important}
.cbx-tray .cbx-cname{margin:-3px 0 0;font-size:10px!important;min-height:17px;z-index:1}
.cbx-tray .cbx-art{height:51px!important}.cbx-tray .cbx-cost{-webkit-text-stroke-color:#0b2140}
.cbx-tray .cbx-pile{font-size:9px}.cbx-tray .cbx-pilen{height:25px}
.cbx-mart .cbx-picture{position:absolute;inset:0}.cbx-mart .cbx-standee{width:70%;height:94%}
.cbx-view-stage{height:404px}
.cbx-view-stage .cbx-player{bottom:104px}.cbx-view-stage .cbx-foe{bottom:104px}.cbx-view-stage .cbx-companion{bottom:52%}
.cbx-view-stage .cbx-floor{left:1%;right:1%;top:auto;bottom:10px;height:92px;perspective:600px;perspective-origin:50% -80%;z-index:4}
.cbx-view-stage .cbx-plane{transform:rotateX(56deg)}
.cbx-view-stage .cbx-slot{width:14%;height:82%}
.cbx-view-stage .cbx-ours,.cbx-view-stage .cbx-theirs{background:#0a120c73;box-shadow:inset 0 0 0 1px #78e6f066}
.cbx-view-stage .cbx-theirs{box-shadow:inset 0 0 0 1px #ff787866}
.cbx-view-stage .cbx-stand{transform:translateX(-50%) rotateX(-56deg)}
.cbx-view-stage .cbx-fcard{width:40px;height:56px;margin:-28px 0 0 -20px}
.cbx-view-stage .cbx-crt{width:48px;height:60px}
.cbx-view-stage .cbx-crt>.cbx-mstats{left:-2px;right:-2px}
.cbx-view-mixed{height:352px}.cbx-view-mixed .cbx-bg{filter:brightness(.78)}
.cbx-view-mixed .cbx-floor{height:220px}
.cbx-floor{position:absolute;left:23%;right:22%;bottom:8px;height:190px;perspective:520px;perspective-origin:50% -40%;z-index:1}
.cbx-plane{position:absolute;inset:0;transform-origin:50% 100%;transform:rotateX(50deg);transform-style:preserve-3d}
.cbx-lane{position:absolute;left:1%;right:1%;height:31%;margin-top:-1%;border-radius:9px;background:linear-gradient(90deg,#28788c33,#ffffff08 50%,#8c1e2833)}
.cbx-slot{position:absolute;width:44%;height:29%;border-radius:8px;transform-style:preserve-3d}
.cbx-ours{background:linear-gradient(90deg,#28788c66,#3cb4be38);box-shadow:inset 0 0 0 2px #78e6f08c,0 0 12px #5adcf04d}
.cbx-theirs{background:linear-gradient(90deg,#aa323c38,#8c1e2866);box-shadow:inset 0 0 0 2px #ff787880,0 0 12px #ff5a5a40}
.cbx-slot.cbx-target{box-shadow:inset 0 0 0 2px #bfffe9,0 0 18px #96ffdcbb;cursor:pointer;animation:cbPulse 1.2s ease-in-out infinite}
.cbx-slot.cbx-aimable{box-shadow:inset 0 0 0 2px #ffb0a4,0 0 16px #ff5a4abb;cursor:pointer}
.cbx-laneno{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:13px;font-weight:900;color:#ffffff45}
.cbx-view-mixed .cbx-player{left:0;width:24%}.cbx-view-mixed .cbx-companion{bottom:45%;width:22%}
.cbx-view-mixed .cbx-foe{right:0;width:27%}.cbx-view-mixed .cbx-medal{height:130px}
.cbx-view-mixed .cbx-fcard{width:34px;height:46px;margin:-23px 0 0 -17px}
.cbx-view-mixed .cbx-crt{width:42px;height:52px}
.cbx-unit,.cbx-mover{position:absolute;inset:0;transform-style:preserve-3d}
.cbx-fcard{position:absolute;left:50%;top:50%;width:46px;height:64px;margin:-32px 0 0 -23px;box-sizing:border-box;display:flex;flex-direction:column;gap:1px;padding:2px;border-radius:5px;border:2px solid #9a9184;background:linear-gradient(170deg,#2b4633,#14231a);box-shadow:0 3px 6px #000a;font-size:8px}
.cbx-foecard{background:linear-gradient(170deg,#4a2026,#1c0c10)}
.cbx-fart{position:relative;flex:1;min-height:0;border-radius:3px;overflow:hidden;background:radial-gradient(circle,#6b8f70,#1d2c22)}
.cbx-fart .cbx-picture{position:absolute;inset:0}.cbx-fart .cbx-standee{width:80%;height:94%}
.cbx-fcard .cbx-stars{height:auto;padding:0 0 1px 2px;font-size:6px;line-height:6px}
.cbx-crt>.cbx-mstats{position:absolute;left:-7px;right:-7px;bottom:3px;z-index:2;gap:2px}
.cbx-crt .cbx-matk,.cbx-crt .cbx-mhp{flex:1;min-width:0;height:14px;padding:0 1px;font-size:11px;border-radius:4px;box-shadow:0 1px 2px #000c}
.cbx-crt .cbx-mstats .cbx-icon{width:10px;height:10px}
.cbx-spot{position:absolute;left:50%;top:60%;width:0;height:0;transform-style:preserve-3d}
.cbx-stand{position:absolute;left:0;bottom:0;transform-origin:50% 100%;transform:translateX(-50%) rotateX(-50deg)}
.cbx-crt{position:relative;width:46px;height:56px;transform-origin:50% 100%}
.cbx-crt:before{content:"";position:absolute;left:14%;right:14%;bottom:-4px;height:8px;border-radius:50%;background:radial-gradient(ellipse,#000c,transparent 70%)}
.cbx-crt .cbx-portrait{width:84%;padding:2px 2px 4px;border-radius:12px 12px 6px 6px}
.cbx-crt .cbx-standee:after{display:none}
.cbx-crt .cbx-glyph{width:92%;font-size:26px}
.cbx-crt .cbx-float{top:-16px;font-size:22px;-webkit-text-stroke:3px #800e0a}
.cbx-crt .cbx-impact{left:-8px;top:-8px;right:-8px;bottom:-8px}
.cbx-crt .cbx-slashw{left:-10%;top:45%;width:120%}
.cbx-holo{position:absolute;left:12%;right:12%;top:4%;bottom:8%;border-radius:6px;overflow:hidden;opacity:.86;border:1px solid #bfffe9;box-shadow:0 0 10px #78ffd0,inset 0 0 8px #78ffd0;background:#0b2a2a}
.cbx-holo:after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,#9fffe026 0 2px,transparent 2px 4px)}
.cbx-ready .cbx-crt{filter:drop-shadow(0 0 5px #ffe08a)}
.cbx-aiming .cbx-crt{filter:drop-shadow(0 0 4px #fff) drop-shadow(0 0 8px #ffd04d)}
.cbx-summonring{position:absolute;left:-10px;right:-10px;bottom:-6px;height:20px;border:3px solid #a0ffc8;border-radius:50%;box-shadow:0 0 16px #78ffb4cc,inset 0 0 12px #78ffb499;animation:cbSummonRing .7s .3s ease-out both}
.cbx-new .cbx-fcard{animation:cbLand .45s cubic-bezier(.2,.9,.3,1) both}
.cbx-new .cbx-crt{animation:cbRise .6s .3s cubic-bezier(.2,1.5,.4,1) both}
.cbx-go{animation:cbGo .62s ease-in-out both}
.cbx-hit{animation:cbShake .42s ease both}
.cbx-die .cbx-crt{animation:cbFall .55s ease-in both}
.cbx-die .cbx-fcard{animation:cbFlip .6s ease-in both}
.cbx-view-board{height:448px}.cbx-view-board .cbx-bg{filter:blur(2px) brightness(.45) saturate(.8)}
.cbx-view-board .cbx-floor{left:50%;right:auto;top:74px;bottom:auto;width:76%;max-width:320px;height:290px;transform:translateX(-50%);perspective:760px;perspective-origin:50% 10%}
.cbx-view-board .cbx-plane{border-radius:12px;transform:rotateX(46deg);background:url('{{raw::cb-art-bg-board}}') center/100% 100%;box-shadow:0 0 0 3px #3a2814,0 0 0 5px #8a6430,0 22px 30px #0009}
.cbx-view-board .cbx-slot{width:23%;height:27.5%}
.cbx-view-board .cbx-stand{transform:translateX(-50%) rotateX(-46deg)}
.cbx-view-board .cbx-fcard{width:48px;height:66px;margin:-33px 0 0 -24px}
.cbx-view-board .cbx-crt{width:50px;height:60px}
.cbx-view-board .cbx-foe{left:50%;right:auto;top:5px;bottom:auto;width:49%;transform:translateX(-50%);display:grid;grid-template-columns:65px minmax(0,1fr);gap:3px}
.cbx-view-board .cbx-medalw{grid-row:1/5;grid-column:1}.cbx-view-board .cbx-medal{height:90px}
.cbx-view-board .cbx-intent,.cbx-view-board .cbx-name,.cbx-view-board .cbx-foe>.cbx-barrow,.cbx-view-board .cbx-foe>.cbx-chips{grid-column:2}
.cbx-view-board .cbx-medalw.cbx-lunge{animation-name:cbBoardLunge}
.cbx-view-board .cbx-player{left:0;bottom:4px;width:24%}.cbx-view-board .cbx-player .cbx-figure{height:70px}
.cbx-view-board .cbx-companion{left:auto;right:0;bottom:4px;width:22%;filter:none}
.cbx-view-board .cbx-companion .cbx-figure{height:74px;transform:scaleX(-1)}
.cbx-view-board .cbx-ghost{left:50%;top:50px;animation-name:cbBoardFly}
.cbx-still *{animation:none!important}
.cbx-epilogue{position:relative;display:flex;align-items:flex-end;justify-content:space-around;height:120px;margin-top:12px;border-radius:12px;background-position:center;background-size:cover;overflow:hidden}
.cbx-epilogue .cbx-figure{width:23%;height:105px;margin-bottom:7px}.cbx-epilogue .cbx-fallen{filter:brightness(.55);opacity:.6;transform:rotate(12deg)}
@keyframes cbSideLunge{0%,100%{transform:none}40%{transform:translateX(-65px) scale(1.06)}}
@keyframes cbBoardLunge{0%,100%{transform:none}40%{transform:translateY(75px) scale(1.08)}}
@keyframes cbSideFly{0%{opacity:1;transform:translate(-180px,90px) rotate(-12deg)}75%{opacity:1;transform:scale(.8)}100%{opacity:0;transform:scale(.45) rotate(12deg)}}
@keyframes cbBoardFly{0%{opacity:1;transform:translateY(260px) rotate(-6deg)}75%{opacity:1;transform:scale(.8)}100%{opacity:0;transform:scale(.45)}}
@keyframes cbSummonRing{0%{opacity:1;transform:scale(.2)}100%{opacity:0;transform:scale(1.6)}}
@keyframes cbLand{0%{opacity:0;transform:translateY(-36px) scale(1.5) rotate(-14deg)}70%{opacity:1;transform:scale(.94)}100%{opacity:1;transform:none}}
@keyframes cbRise{0%{opacity:0;transform:scale(.15) translateY(8px)}100%{opacity:1;transform:none}}
@keyframes cbGo{0%,100%{transform:none}45%{transform:translate(var(--tx),var(--ty))}}
@keyframes cbFall{0%{opacity:1;transform:none;filter:none}35%{opacity:1;transform:scale(1.08) rotate(-6deg);filter:brightness(2.2)}100%{opacity:0;transform:scale(.35) rotate(20deg) translateY(10px);filter:brightness(2)}}
@keyframes cbFlip{0%{opacity:1;transform:none}100%{opacity:0;transform:translateY(24px) rotateY(180deg) scale(.6)}}
@media(prefers-reduced-motion:reduce){.cbx-root *{animation:none!important;transition:none!important}.cbx-summonring,.cbx-die{display:none}}
]]

function CB.artKey(key)
    key = CB.trim(key):lower()
    if #key > 0 and #key <= 32 and key:match('^[a-z0-9][a-z0-9_-]*$') then return key end
    return nil
end

--- The asset names the window may use, read exactly (the media parser is
--- never asked to fuzzy-match a name that may not be there): the bot's own
--- (cb-...) and a private art module's (namespace card-battle-art) in
--- CB.ASSETS, the module's own pictures (cb-art-...) in CB.OWN.
function CB.readAssets(tid)
    CB.ASSETS, CB.OWN = {}, {}
    local function names(macro)
        local ok, list = pcall(function() return json.decode(cbs(macro)) end)
        return (ok and type(list) == 'table') and list or {}
    end
    for _, macro in ipairs({ '{{assetlist}}', '{{moduleassetlist::card-battle-art}}' }) do
        for _, name in ipairs(names(macro)) do
            name = tostring(name):lower()
            if name:match('^cb%-[a-z0-9_-]+$') then CB.ASSETS[name] = true end
        end
    end
    for _, name in ipairs(names('{{moduleassetlist::card-battle}}')) do
        name = tostring(name):lower()
        if name:match('^cb%-art%-[a-z0-9_-]+$') then CB.OWN[name] = true end
    end
end

function CB.visuals(tid)
    CB.VIEW = CB.settings(tid).view
    CB.BOT = CB.clip(getName(tid) or '동료', 12)
    CB.readAssets(tid)
end

--- The figure an enemy stands as: its art key when there is a picture for
--- it (a cb-foe-<key> override, or a row of CB.ART whose file the module
--- has), else the first row whose words are in its name. any: whatever the
--- pictures (for the rules, which must not change with the art).
function CB.foeArt(name, art, any)
    art = CB.artKey(art)
    local row = art and CB.ART_BY_KEY[art]
    local known = row and (row.kind:find('enemy', 1, true) or row.kind:find('minion', 1, true))
    if art and ((CB.ASSETS or {})['cb-foe-' .. art] or (known and (any or CB.hasArt(row)))) then return art end
    local lower = tostring(name or ''):lower()
    for _, entry in ipairs(CB.artRows('enemy', any)) do
        for _, word in ipairs(entry.words or {}) do
            if word:find('^%a+$') then
                if lower:find('%f[%a]' .. word .. '%f[%A]') then return entry.key end
            elseif lower:find(word, 1, true) then return entry.key end
        end
    end
    return nil
end

function CB.foeSource(name, art)
    local key = CB.foeArt(name, art)
    if not key then return nil end
    if (CB.ASSETS or {})['cb-foe-' .. key] then return '{{raw::cb-foe-' .. key .. '}}' end
    local row = CB.ART_BY_KEY[key]
    return row and ('{{raw::cb-art-' .. row.file .. '}}') or nil
end

--- A creature card's figure: a cb-ally-<key> override, else the row's
--- picture when the module has it, else nil (the card stands as a
--- hologram of its art).
function CB.allySource(key)
    key = CB.artKey(key)
    if not key then return nil end
    if (CB.ASSETS or {})['cb-ally-' .. key] then return '{{raw::cb-ally-' .. key .. '}}' end
    local row = CB.ART_BY_KEY[key]
    if row and CB.hasArt(row) then return '{{raw::cb-art-' .. row.file .. '}}' end
    return nil
end

function CB.icon(key, glyph)
    if CB.VIEW == 'simple' then return glyph end
    return '<img class="cbx-icon" src="{{raw::cb-art-ic-' .. key .. '}}" alt="' .. glyph .. '">'
end

function CB.iconText(text)
    if CB.VIEW == 'simple' then return text end
    for _, pair in ipairs({ { '⚔️', 'attack' }, { '🛡️', 'block' }, { '🧪', 'poison' }, { '💚', 'heal' } }) do
        text = text:gsub(pair[1], function() return CB.icon(pair[2], pair[1]) end)
    end
    return text
end

function CB.picture(src, glyph, class)
    if not src then return '<span class="cbx-standee cbx-glyph">' .. escapeHtml(glyph) .. '</span>' end
    return '<span class="cbx-picture' .. (class and (' ' .. class) or '') .. '"><img src="' .. src .. '" alt="' .. escapeHtml(glyph) .. '">'
        .. '<span class="cbx-fallback">' .. escapeHtml(glyph) .. '</span></span>'
end

-- Portraits stay framed: most user images have a background. Only the
-- explicit cb-sd assets are treated as transparent full-body figures.
function CB.hero(who)
    local asset = who == 'user' and 'cb-sd-user' or 'cb-sd-char'
    if (CB.ASSETS or {})[asset] then return CB.picture('{{raw::' .. asset .. '}}', who == 'user' and '♟' or '♙') end
    local fallback = who == 'user' and 'hero-persona' or 'hero-bot'
    return '<span class="cbx-standee cbx-portrait"><span class="cbx-profile" style="background-image:url(\'{{source::' .. who .. '}}\'),url(\'{{raw::cb-art-' .. fallback .. '}}\')"></span></span>'
end

--- The card art by its main effect (a creature without a figure stands as
--- a hologram of it).
function CB.effectArt(card)
    local fx = card.fx or {}
    local art = fx.dmg and ((fx.poison or fx.exhaust) and 'fire' or 'slash') or (fx.block and 'shield') or (fx.heal and 'heal') or 'fire'
    return '{{raw::cb-art-ca-' .. art .. '}}'
end

function CB.cardArt(card)
    if card.foe then return CB.picture(CB.foeSource(card.name, card.art), card.glyph or CB.cardIcon(card)) end
    if card.sig then return CB.hero('user') end
    local ally = CB.isCreature(card) and CB.allySource(card.art)
    if ally then return CB.picture(ally, CB.cardIcon(card)) end
    return CB.picture(CB.effectArt(card), CB.cardIcon(card), 'cbx-cover')
end

--- A creature standing on the field: a beaten enemy's or a minion's figure,
--- the persona for the signature card, a summon card's figure, else its
--- card art as a hologram.
function CB.creatureFigure(c, card)
    if c.minion then return CB.picture(CB.foeSource(nil, c.art), (CB.ART_BY_KEY[c.art or ''] or {}).glyph or '👾') end
    card = card or {}
    if card.foe then return CB.picture(CB.foeSource(card.name, card.art), card.glyph or '👾') end
    if card.sig then return CB.hero('user') end
    local ally = CB.allySource(card.art)
    if ally then return CB.picture(ally, CB.cardIcon(card)) end
    return '<span class="cbx-holo">' .. CB.picture(CB.effectArt(card), CB.cardIcon(card), 'cbx-cover') .. '</span>'
end

-- The attribute gem a creature card wears: its colour and its mark.
CB.ATTR = {
    fire = { '#ff6a3d', '불' }, water = { '#3f9be8', '물' }, earth = { '#b88a4a', '흙' }, wind = { '#4fcf93', '풍' },
    light = { '#ffd65c', '빛' }, dark = { '#9a6ad8', '암' }, leaf = { '#7cc451', '잎' }, metal = { '#a9b6c4', '철' },
}
-- Its level stars, by rarity.
CB.STARS = { basic = 1, common = 2, rare = 3, epic = 4 }

function CB.attrOf(card)
    if card.sig then return 'light' end
    local key = card.foe and CB.foeArt(card.name, card.art, true) or CB.artKey(card.art)
    local row = key and CB.ART_BY_KEY[key]
    if row and row.attr then return row.attr end
    local fx = card.fx or {}
    return (fx.dmg and 'fire') or (fx.block and 'earth') or (fx.heal and 'water') or (fx.poison and 'dark') or 'wind'
end

function CB.cardType(card)
    local fx = card.fx or {}
    if fx.summon then return 'sum' end
    if fx.dmg then return 'atk' end
    if (fx.str or fx.dex or fx.thorns or fx.armor or fx.energy or fx.charge) and not fx.block and not fx.heal then return 'pow' end
    return 'skl'
end

function CB.cardIcon(card)
    local fx = card.fx or {}
    if fx.summon then
        local row = CB.ART_BY_KEY[CB.artKey(card.art) or '']
        return (row and row.glyph) or '🐾'
    end
    if fx.dmg and fx.drain then return '🩸' end
    if fx.dmg and fx.poison then return '🧪' end
    if fx.dmg and fx.pierce then return '🏹' end
    if fx.dmg and (fx.hits or 1) > 1 then return '🗡️' end
    if fx.dmg and (fx.vuln or fx.weak) then return '🎯' end
    if fx.dmg and fx.exhaust then return '💥' end
    if fx.dmg then return '⚔️' end
    if fx.thorns then return '🌵' end
    if fx.armor then return '🔰' end
    if fx.block then return '🛡️' end
    if fx.poison then return '🧪' end
    if fx.heal then return '💚' end
    if fx.str then return '💪' end
    if fx.dex then return '🤸' end
    if fx.energy or fx.charge then return '⚡' end
    if fx.draw or fx.prepare then return '📜' end
    if fx.weak or fx.vuln then return '☠️' end
    return '✨'
end

local function px(value)
    return string.format('%.1f', value):gsub('%.0$', '') .. 'px'
end

local function fmt(seconds)
    return string.format('%.2f', seconds)
end

--- An animation delay as a style attribute (nothing for none).
local function at(seconds)
    if not seconds or seconds <= 0 then return '' end
    return ' style="animation-delay:' .. fmt(seconds) .. 's"'
end

--- A creature's attack and health boxes (a sword, a heart); health shows
--- red once it is below max.
local function statBoxes(atk, hp, max)
    return '<div class="cbx-mstats"><span class="cbx-matk">' .. CB.icon('attack', '⚔') .. '<span>' .. atk .. '</span></span>'
        .. '<span class="cbx-mhp' .. ((max and hp < max) and ' cbx-low' or '') .. '">' .. CB.icon('heal', '❤') .. '<span>' .. hp .. '</span></span></div>'
end

--- A longer name gets a smaller font, so most fit the name bar.
local function titleSize(name)
    local ok, n = pcall(utf8.len, name or '')
    n = ok and n or #(name or '')
    return n <= 4 and '.95' or (n <= 5 and '.85' or (n <= 6 and '.74' or '.64'))
end

--- A creature card's face: a name bar with its attribute gem, its level
--- stars, the art window, a text box (what it does when it comes, else its
--- flavour) and its attack and health at the bottom. Sizes are in em of
--- the frame's font, so one scale sizes it all.
function CB.creatureFace(card, scale, poor)
    local fx = card.fx or {}
    local rarity = card.sig and '#ffd56b' or (CB.RARITY_COLOR[card.rarity] or CB.RARITY_COLOR.basic)
    local attr = CB.ATTR[CB.attrOf(card)] or CB.ATTR.wind
    local text = CB.arrivalText(card)
    return '<div class="cbx-card cbx-sum' .. (card.sig and ' cbx-sigcard' or '') .. (poor and ' cbx-poor' or '') .. '" style="width:' .. px(84 * scale) .. ';height:' .. px(120 * scale) .. '">'
        .. '<div class="cbx-cost">' .. card.cost .. '</div>'
        .. (card.sig and '<div class="cbx-badge">대표</div>' or '')
        .. '<div class="cbx-mframe" style="font-size:' .. px(10 * scale) .. ';border-color:' .. rarity .. '">'
        .. '<div class="cbx-mname"><span class="cbx-mtitle" style="font-size:' .. titleSize(card.name) .. 'em">' .. escapeHtml(card.name) .. '</span>'
        .. '<span class="cbx-attr" style="background:' .. attr[1] .. '">' .. attr[2] .. '</span></div>'
        .. '<div class="cbx-stars">' .. string.rep('★', CB.STARS[card.rarity] or 1) .. '</div>'
        .. '<div class="cbx-mart">' .. (CB.VIEW == 'simple' and ('<span class="cbx-mglyph">' .. escapeHtml(card.glyph or CB.cardIcon(card)) .. '</span>') or CB.cardArt(card)) .. '</div>'
        .. '<div class="cbx-mtext' .. (text == '' and ' cbx-flavour' or '') .. '">' .. escapeHtml(text ~= '' and text or (card.desc or '')) .. '</div>'
        .. statBoxes(fx.power or 0, fx.summon)
        .. '</div><div class="cbx-gem" style="background:' .. rarity .. '"></div></div>'
end

--- The card a creature lies on, face up on the field: its frame, its
--- level stars and its picture (an enemy's minion has a red frame). Its
--- attack and health stand up in front of it with the creature (on the
--- tilted floor they would be too flat to read). dieAt: when it flips
--- away with its fallen creature.
function CB.fieldCard(c, card, dieAt)
    local frame = c.minion and '#c0453c' or ((card and card.sig) and '#ffd56b' or CB.RARITY_COLOR[(card or {}).rarity or 'basic'] or '#9a9184')
    local art = c.minion and CB.picture(CB.foeSource(nil, c.art), (CB.ART_BY_KEY[c.art or ''] or {}).glyph or '👾')
        or (card and CB.cardArt(card) or '')
    return '<div class="cbx-fcard' .. (c.minion and ' cbx-foecard' or '') .. '" style="border-color:' .. frame
        .. (dieAt and (';animation-delay:' .. fmt(dieAt) .. 's') or '') .. '"><div class="cbx-stars">'
        .. string.rep('★', c.minion and 1 or (CB.STARS[(card or {}).rarity or 'basic'] or 1)) .. '</div><div class="cbx-fart">' .. art .. '</div></div>'
end

--- One card face. scale: 1 in the hand, larger on the reward screen. The
--- signature card has a gold frame; a beaten enemy's card shows its face;
--- a creature card has a frame of its own (CB.creatureFace).
function CB.cardFace(card, scale, poor)
    scale = scale or 1
    if CB.isCreature(card) then return CB.creatureFace(card, scale, poor) end
    local rarity = card.sig and '#ffd56b' or (CB.RARITY_COLOR[card.rarity] or CB.RARITY_COLOR.basic)
    return '<div class="cbx-card cbx-' .. CB.cardType(card) .. (card.sig and ' cbx-sigcard' or '') .. (poor and ' cbx-poor' or '') .. '" style="width:' .. px(84 * scale) .. ';height:' .. px(120 * scale) .. '">'
        .. '<div class="cbx-cost">' .. card.cost .. '</div>'
        .. (card.sig and '<div class="cbx-badge">대표</div>' or '')
        .. '<div class="cbx-inner" style="border-color:' .. rarity .. '">'
        .. '<div class="cbx-art" style="height:' .. px(42 * scale) .. ';font-size:' .. px(22 * scale) .. '">'
        .. (CB.VIEW == 'simple' and escapeHtml(card.glyph or CB.cardIcon(card)) or CB.cardArt(card)) .. '</div>'
        .. '<div class="cbx-cname" style="font-size:' .. px(10.5 * scale) .. '">' .. escapeHtml(card.name) .. '</div>'
        .. '<div class="cbx-desc" style="font-size:' .. px(10 * scale) .. '">' .. escapeHtml(CB.effectText(card)) .. '</div>'
        .. '</div><div class="cbx-gem" style="background:' .. rarity .. '"></div></div>'
end

--- n particles flying out from the middle of the box they are in, each
--- turned its own way (kind: cbx-spark, cbx-star or cbx-shard).
local function burst(n, kind, glyph, wait)
    local out = {}
    for i = 1, n do
        local turn = math.floor(360 / n * (i - 1) + (i % 2) * 17)
        out[i] = '<i class="cbx-burst" style="transform:rotate(' .. turn .. 'deg)"><i class="cbx-pt ' .. kind .. '"'
            .. at((wait or 0) + (i % 3) * 0.04) .. '>' .. (glyph or '') .. '</i></i>'
    end
    return table.concat(out)
end

--- Poison bubbles rising in the box they are in.
local function bubbles(wait)
    local out = {}
    for i, left in ipairs({ 18, 38, 58, 74, 30 }) do
        out[i] = '<i class="cbx-bub" style="left:' .. left .. '%;animation-delay:' .. fmt((wait or 0) + (i - 1) * 0.12) .. 's"></i>'
    end
    return table.concat(out)
end

--- Stars drifting down the window, for a win.
local function confetti()
    local out = {}
    for i, left in ipairs({ 8, 22, 37, 51, 66, 80, 93, 15, 44, 72, 58, 29 }) do
        out[i] = '<i class="cbx-drift" style="left:' .. left .. '%;animation-delay:' .. fmt((i - 1) * 0.13) .. 's;font-size:' .. (10 + (i * 7) % 9) .. 'px">'
            .. (i % 3 == 0 and '★' or '✦') .. '</i>'
    end
    return table.concat(out)
end

-- The window's outer tag takes turns between div and section with each
-- drawing (n, b.n): PocketRisu changes a message in place, and an element
-- left from the last drawing would not play its animation again. A new tag
-- is drawn fresh, as official Risu draws every message. overlay is what
-- lies over the whole panel (a flash, a banner, stars).
local function frame(inner, anim, extraClass, n, overlay)
    local tag = (n or 0) % 2 == 1 and 'section' or 'div'
    return '<' .. tag .. '><style>' .. CB.CSS .. (CB.VIEW ~= 'simple' and CB.ART_CSS or '') .. '</style>'
        .. '<div class="cbx-root" style="position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:10px;box-sizing:border-box;font-size:14px;line-height:1.35;background:rgba(6,4,10,.88)">'
        .. '<div class="cbx-panel' .. ((anim or {}).open and ' cbx-in' or '') .. (extraClass and (' ' .. extraClass) or '') .. '" style="width:100%;max-width:' .. (CB.VIEW == 'simple' and '420' or '560') .. 'px;max-height:100%;overflow-y:auto;overflow-x:hidden;padding:12px;box-sizing:border-box;text-align:left;color:#f1e6cf">'
        .. (overlay or '') .. inner .. '</div></div></' .. tag .. '>'
end

local function header(left, right)
    return '<div class="cbx-head"><span>' .. left .. '</span><span style="display:flex;gap:6px">' .. (right or '')
        .. '<span risu-btn="cb|close" class="cbx-ic">✕</span></span></div>'
end

--- A hit point bar with its block. fx (optional): from = the hit points
--- before this scene (the part lost flashes, then drains), wait = when it
--- lands, block = 'pop' (block gained) or 'break' (block broken).
local function hpBar(hp, max, colour, block, fx)
    fx = fx or {}
    local pct = max > 0 and math.floor(hp / max * 100) or 0
    local badge = ''
    if (block or 0) > 0 then
        badge = '<div class="cbx-block' .. (fx.block == 'pop' and ' cbx-pop' or '') .. '"' .. at(fx.block == 'pop' and fx.wait) .. '>' .. CB.icon('block', '🛡️') .. block .. '</div>'
    elseif fx.block == 'break' then
        badge = '<div class="cbx-block cbx-break"' .. at(fx.wait) .. '>' .. CB.icon('block', '🛡️') .. burst(5, 'cbx-shard', '', fx.wait) .. '</div>'
    end
    local trail = ''
    if fx.from and fx.from > hp and max > 0 then
        local was = math.min(100, math.floor(fx.from / max * 100))
        if was > pct then
            trail = '<div class="cbx-trail" style="left:' .. pct .. '%;width:' .. (was - pct) .. '%;animation-delay:' .. fmt(fx.wait or 0) .. 's"></div>'
        end
    end
    return '<div class="cbx-barrow">' .. badge
        .. '<div class="cbx-bar"><div class="cbx-fill ' .. colour .. '" style="width:' .. pct .. '%"></div>' .. trail .. '<div class="cbx-bartext">' .. hp .. ' / ' .. max .. '</div></div></div>'
end

local function chips(who)
    local parts = {}
    if (who.str or 0) > 0 then parts[#parts + 1] = '<span class="cbx-chip">💪 힘 ' .. who.str .. '</span>' end
    if (who.weak or 0) > 0 then parts[#parts + 1] = '<span class="cbx-chip">🌀 약화 ' .. who.weak .. '</span>' end
    if (who.vuln or 0) > 0 then parts[#parts + 1] = '<span class="cbx-chip">💔 취약 ' .. who.vuln .. '</span>' end
    if (who.poison or 0) > 0 then parts[#parts + 1] = '<span class="cbx-chip">🧪 독 ' .. who.poison .. '</span>' end
    if (who.thorns or 0) > 0 then parts[#parts + 1] = '<span class="cbx-chip">🌵 가시 ' .. who.thorns .. '</span>' end
    if (who.armor or 0) > 0 then parts[#parts + 1] = '<span class="cbx-chip">🔰 매 턴 방어 ' .. who.armor .. '</span>' end
    if (who.dex or 0) > 0 then parts[#parts + 1] = '<span class="cbx-chip">🤸 민첩 ' .. who.dex .. '</span>' end
    if (who.nextEnergy or 0) > 0 then parts[#parts + 1] = '<span class="cbx-chip">⚡ 다음 턴 +' .. who.nextEnergy .. '</span>' end
    if (who.nextDraw or 0) > 0 then parts[#parts + 1] = '<span class="cbx-chip">📜 다음 턴 +' .. who.nextDraw .. '장</span>' end
    return '<div class="cbx-chips">' .. CB.iconText(table.concat(parts)) .. '</div>'
end

--- The number a hit or a gain shows. kind: nil (damage), 'good' (block) or
--- 'heal'; big makes it a critical one.
local function float(text, kind, wait, big)
    if not text then return '' end
    return '<div class="cbx-float' .. (kind and (' cbx-' .. kind) or '') .. (big and ' cbx-crit' or '') .. '"' .. at(wait) .. '>' .. CB.iconText(escapeHtml(text)) .. '</div>'
end

--- Where hand card k of n sits in the fan: at most 216px between the outer
--- cards' centres, tilted 4deg a card, so it fits a 375px phone (58px and
--- 6deg cut the outer cards off). A lifted card stands up.
local function fanStyle(k, n, selected)
    local step = n > 1 and math.min(54, math.floor(216 / (n - 1))) or 0
    local off = k - (n + 1) / 2
    local transform = selected and 'translateY(-30px) scale(1.15)'
        or ('rotate(' .. string.format('%.1f', off * 4) .. 'deg) translateY(' .. math.floor(math.abs(off) * 4) .. 'px)')
    return 'position:absolute;bottom:0;left:calc(50% - 42px + ' .. math.floor(off * step) .. 'px);transform:' .. transform
        .. ';transform-origin:50% 120%;z-index:' .. (selected and 50 or k)
end

-- Where each lane's slot lies on the floor of each art view, in % of the
-- floor: w and h its size, the left and top of each side's three, and
-- where each side's hero stands (what a creature lunges at). stage: a
-- strip of six on the ground in front, ours on the left; mixed: three
-- lanes across the floor, ours on the left half; board: theirs on top.
CB.FIELD = {
    stage = { w = 14, h = 82, mine = { { 2, 9 }, { 17.5, 9 }, { 33, 9 } }, foe = { { 52, 9 }, { 67.5, 9 }, { 83, 9 } },
        heroes = { mine = { 8, -150 }, foe = { 80, -165 } } },
    mixed = { w = 44, h = 29, mine = { { 4, 3 }, { 4, 36 }, { 4, 69 } }, foe = { { 52, 3 }, { 52, 36 }, { 52, 69 } },
        heroes = { mine = { -62, 36 }, foe = { 118, 36 } } },
    board = { w = 23, h = 27.5, mine = { { 10, 57 }, { 39, 57 }, { 68, 57 } }, foe = { { 10, 12 }, { 39, 12 }, { 68, 12 } },
        heroes = { mine = { -34, 108 }, foe = { 39, -46 } } },
}

--- How far a creature lunges at its target, in its own width and height
--- (four fifths of the way, so it stops short).
local function reach(view, side, lane, target)
    local f = CB.FIELD[view] or CB.FIELD.mixed
    local other = side == 'mine' and 'foe' or 'mine'
    local from = f[side][lane]
    local to = target == 'H' and f.heroes[other] or f[other][target]
    return math.floor((to[1] - from[1]) / f.w * 80), math.floor((to[2] - from[2]) / f.h * 80)
end

--- What this drawing does to each slot (side, lane): a creature come
--- (new), one lunging (go, at goAt), hit (hurtAt, its number, the slashes
--- of a card), fallen (dies at diesAt, drawn one last time from ghost).
function CB.fieldMarks(anim)
    local marks = { mine = {}, foe = {} }
    local function mark(side, lane)
        marks[side][lane] = marks[side][lane] or {}
        return marks[side][lane]
    end
    if anim.summon then mark('mine', anim.summon).new = true end
    if anim.foeSummon then mark('foe', anim.foeSummon).new = true end
    for _, hit in ipairs(anim.strikes or {}) do
        local wait = hit.wait or 0
        if hit.side ~= 'card' then
            local m = mark(hit.side, hit.lane)
            m.go, m.goAt = hit.at, wait
            if hit.died then m.dies, m.ghost, m.diesAt = true, hit.self, wait + 0.45 end
        end
        if hit.at ~= 'H' then
            local t = mark(hit.side == 'foe' and 'mine' or 'foe', hit.at)
            t.hurtAt = hit.side == 'card' and wait or (wait + 0.3)
            t.text, t.slashes = '-' .. hit.dmg, hit.side == 'card' and (hit.hits or 1) or nil
            if hit.killed then t.dies, t.ghost, t.diesAt = true, hit.victim, t.hurtAt + 0.25 end
        end
    end
    return marks
end

--- A creature in its slot: its card lying face up, the creature standing
--- on it (the stand turns it back up from the tilted floor), and what the
--- scene does to it. ready: 'ready' (may attack) or 'aiming' (picked).
local function unitHtml(b, view, side, lane, c, m, ready)
    m = m or {}
    local card = (side == 'mine' and c.card) and b.cards[c.card] or nil
    local class = 'cbx-unit'
    if m.new then class = class .. ' cbx-new' end
    if m.dies then class = class .. ' cbx-die' end
    if ready then class = class .. ' cbx-' .. ready end
    -- The creature lunges (its mover, the size of the slot), not its card.
    local mover = '<div class="cbx-mover">'
    if m.go then
        local tx, ty = reach(view, side, lane, m.go)
        mover = '<div class="cbx-mover cbx-go" style="--tx:' .. tx .. '%;--ty:' .. ty .. '%;animation-delay:' .. fmt(m.goAt) .. 's">'
    end
    local marks = {}
    if m.new then marks[#marks + 1] = '<i class="cbx-summonring"></i>' end
    if m.hurtAt then
        for i = 1, (m.slashes or 0) do
            marks[#marks + 1] = '<i class="cbx-slashw" style="transform:rotate(' .. (i % 2 == 1 and -32 or 28) .. 'deg)"><i class="cbx-slash"' .. at(m.hurtAt + (i - 1) * 0.12) .. '></i></i>'
        end
        marks[#marks + 1] = '<i class="cbx-impact"' .. at(m.hurtAt) .. '></i>' .. float(m.text, nil, m.hurtAt)
    end
    local delay = m.dies and m.diesAt or (m.hurtAt or nil)
    return '<div class="' .. class .. '">' .. CB.fieldCard(c, card, m.dies and m.diesAt)
        .. mover .. '<div class="cbx-spot"><div class="cbx-stand"><div class="cbx-crt' .. (m.hurtAt and ' cbx-hit' or '') .. '"' .. at(delay) .. '>'
        .. CB.creatureFigure(c, card) .. statBoxes(c.atk or 0, math.max(0, c.hp), c.maxHp) .. table.concat(marks) .. '</div></div></div></div></div>'
end

--- The field in the art views: each side's three slots on the floor, a
--- creature standing on its card where one is. taps (CB.taps) makes a slot
--- a button.
function CB.lanes(b, anim, view, taps)
    local marks = CB.fieldMarks(anim)
    local f = CB.FIELD[view] or CB.FIELD.mixed
    local out = {}
    if view == 'mixed' then
        for i = 1, CB.LANES do out[#out + 1] = '<div class="cbx-lane" style="top:' .. f.mine[i][2] .. '%"></div>' end
    end
    for _, side in ipairs({ 'foe', 'mine' }) do
        local lanes = CB.lanesOf(side == 'mine' and b or b.enemy)
        for i = 1, CB.LANES do
            local m = marks[side][i]
            local c = lanes[i] or (m and m.ghost)
            local tap = taps[side][i]
            out[#out + 1] = '<div class="cbx-slot cbx-' .. (side == 'mine' and 'ours' or 'theirs') .. (tap and tap[2] or '') .. '"'
                .. (tap and (' risu-btn="' .. tap[1] .. '"') or '') .. ' style="left:' .. f[side][i][1] .. '%;top:' .. f[side][i][2] .. '%">'
                .. (c and unitHtml(b, view, side, i, c, m, side == 'mine' and taps.ready[i] or nil) or ('<span class="cbx-laneno">' .. i .. '</span>'))
                .. '</div>'
        end
    end
    return '<div class="cbx-floor"><div class="cbx-plane">' .. table.concat(out) .. '</div></div>'
end

--- 간단: the field as two rows of text, theirs over ours.
function CB.fieldRows(b, anim, taps)
    local marks = CB.fieldMarks(anim)
    local rows = {}
    for _, side in ipairs({ 'foe', 'mine' }) do
        local lanes = CB.lanesOf(side == 'mine' and b or b.enemy)
        local cells = {}
        for i = 1, CB.LANES do
            local c, m, tap = lanes[i], marks[side][i] or {}, taps[side][i]
            local text = i .. ' · 빈 칸'
            if c then
                text = i .. ' · ' .. escapeHtml(CB.clip(c.name, 6)) .. ' ⚔' .. (c.atk or 0) .. ' ❤' .. c.hp
            elseif m.ghost then
                text = i .. ' · ' .. escapeHtml(CB.clip(m.ghost.name, 6)) .. ' 쓰러짐'
            end
            local ready = side == 'mine' and taps.ready[i]
            cells[#cells + 1] = '<span class="cbx-cell' .. (c and '' or ' cbx-empty') .. (tap and tap[2] or '') .. (ready and (' cbx-' .. ready) or '')
                .. (m.new and ' cbx-pop' or '') .. (m.hurtAt and ' cbx-shake' or '') .. '"' .. (tap and (' risu-btn="' .. tap[1] .. '"') or '') .. '>'
                .. text .. (m.hurtAt and float(m.text, nil, m.hurtAt) or '') .. '</span>'
        end
        rows[#rows + 1] = '<div class="cbx-frow"><span class="cbx-flab">' .. (side == 'mine' and '나' or '적') .. '</span>' .. table.concat(cells) .. '</div>'
    end
    return '<div class="cbx-tfield">' .. table.concat(rows) .. '</div>'
end

--- What each slot does when tapped now (nothing while the enemy moves):
--- with a creature card lifted, our empty lanes take it; with an attack
--- card, the enemy's creatures (and the enemy, once it has creatures) are
--- its targets. 직접 고르기: our creatures that may attack are picked
--- (cb|aim), then the enemy's creatures and the enemy are hit (cb|hit).
--- Each tap carries the drawing (b.n), as play and 턴 종료 do.
function CB.taps(b, idle)
    local taps = { mine = {}, foe = {}, ready = {} }
    if idle then return taps end
    local n = b.n or 0
    local mine, theirs = CB.lanesOf(b), CB.lanesOf(b.enemy)
    local card = b.selected and b.cards[b.hand[b.selected] or 0]
    if card and CB.isCreature(card) then
        for i, c in ipairs(mine) do
            if not c then taps.mine[i] = { 'cb|play|' .. b.selected .. '|' .. n .. '|L' .. i, ' cbx-target' } end
        end
    elseif card and (card.fx or {}).dmg and CB.anyCreature(b.enemy) then
        for j, c in ipairs(theirs) do
            if c then taps.foe[j] = { 'cb|play|' .. b.selected .. '|' .. n .. '|E' .. j, ' cbx-aimable' } end
        end
        taps.hero = 'cb|play|' .. b.selected .. '|' .. n .. '|H'
    end
    if b.chosen then
        for i, c in ipairs(mine) do
            if c and not c.fresh and not c.acted and (c.atk or 0) > 0 then
                taps.ready[i] = b.aiming == i and 'aiming' or 'ready'
                taps.mine[i] = taps.mine[i] or { 'cb|aim|' .. i .. '|' .. n, '' }
            end
        end
        if b.aiming and taps.ready[b.aiming] and not card then
            for j, c in ipairs(theirs) do
                if c then taps.foe[j] = { 'cb|hit|' .. b.aiming .. '|' .. n .. '|E' .. j, ' cbx-aimable' } end
            end
            taps.hero = 'cb|hit|' .. b.aiming .. '|' .. n .. '|H'
        end
    end
    return taps
end

--- The targets of what is lifted as plain buttons under its text, for
--- every view (and for anyone who would rather not tap the floor): the
--- empty lanes a creature card may go to, or the enemy and its creatures.
function CB.targetRow(b, taps, kind)
    local buttons = {}
    if kind == 'lane' then
        for i = 1, CB.LANES do
            local tap = taps.mine[i]
            if tap and tap[1]:find('|L%d$') then buttons[#buttons + 1] = '<span risu-btn="' .. tap[1] .. '" class="cbx-tbtn">' .. i .. '번 레인</span>' end
        end
    else
        if taps.hero then buttons[#buttons + 1] = '<span risu-btn="' .. taps.hero .. '" class="cbx-tbtn">' .. escapeHtml(CB.clip(b.name, 8)) .. '</span>' end
        for j, c in ipairs(CB.lanesOf(b.enemy)) do
            local tap = taps.foe[j]
            if tap and c then
                buttons[#buttons + 1] = '<span risu-btn="' .. tap[1] .. '" class="cbx-tbtn cbx-tfoe">' .. j .. ' ' .. escapeHtml(CB.clip(c.name, 6)) .. ' ' .. (c.atk or 0) .. '/' .. c.hp .. '</span>'
            end
        end
    end
    if #buttons == 0 then return '' end
    return '<div class="cbx-targets">' .. (kind == 'lane' and '놓을 레인' or '대상') .. table.concat(buttons) .. '</div>'
end

--- Whether this fight can have anything on its field: a creature card in
--- the deck, or an enemy that calls creatures.
function CB.fieldUsed(b)
    for _, card in ipairs(b.cards or {}) do
        if CB.isCreature(card) then return true end
    end
    for _, move in ipairs((b.enemy or {}).moves or {}) do
        if move.summon then return true end
    end
    return false
end

function CB.stage(b, user, anim, enemy, me, meStyle, meWait, ghost, taps)
    local view = CB.VIEW or 'stage'
    local hurt = anim.player == 'hurt'
    local player = '<div class="cbx-player' .. (hurt and ' cbx-shake' or '') .. '"' .. meStyle .. '><div class="cbx-figure">' .. CB.hero('user')
        .. table.concat(me) .. float(anim.playerText, (not hurt) and (anim.heal and 'heal' or 'good') or nil, meWait, anim.big and anim.lunge) .. '</div>'
        .. hpBar(b.hp, b.maxHp, 'cbx-green', b.block, { from = anim.playerFrom, wait = meWait, block = anim.playerBreak and 'break' or anim.playerBlock })
        .. '<div class="cbx-tag">' .. escapeHtml(CB.clip(user, 12)) .. '</div>' .. chips(b) .. '</div>'
    return '<div class="cbx-stage cbx-view-' .. view .. '"><div class="cbx-bg" style="background-image:url(\'{{raw::cb-art-bg-stage}}\')"></div>'
        .. '<div class="cbx-vignette"></div>' .. CB.lanes(b, anim, view, taps)
        .. '<div class="cbx-companion"><div class="cbx-figure">' .. CB.hero('char') .. '</div><div class="cbx-tag">동료 · ' .. escapeHtml(CB.BOT or '동료') .. '</div></div>'
        .. player .. enemy .. ghost .. '</div>'
end

-- What a drawing keeps of a scene with 전투 연출 off: 0.5's numbers.
CB.PLAIN_ANIM = { open = true, deal = true, enemy = true, enemyText = true, player = true, playerText = true, heal = true }

--- The fight. fx false draws numbers only, as 0.5 did (전투 연출: 끄기).
function CB.fightView(b, user, fx)
    if fx == nil then fx = true end
    local e, anim = b.enemy, {}
    local simple = CB.VIEW == 'simple'
    for key, value in pairs(b.anim or {}) do
        if fx or CB.PLAIN_ANIM[key] then anim[key] = value end
    end
    local foeTurn = anim.foeTurn
    -- Nothing is tapped on the enemy's turn, while the player's creatures
    -- attack at the turn's end, nor in the blow that ends it.
    local idle = foeTurn or anim.busy or b.phase ~= 'fight'
    -- When things land: after the card's flight, a creature's lunge, the
    -- enemy's lunge or the turn's banner.
    local foeWait = anim.foeAt or (anim.castAt == 'foe' and 0.3) or (anim.lunge and 0.2) or (anim.banner == 'foe' and 0.35) or 0
    local meWait = anim.meAt or (anim.lunge and 0.2) or (anim.castAt == 'me' and 0.2) or (anim.banner == 'mine' and 0.3) or 0
    local lunge = anim.lunge
    local taps = CB.taps(b, idle)
    local out = { header('<span class="cbx-turn">' .. CB.icon('attack', '⚔️') .. ' ' .. b.turn .. '턴</span> · Lv.' .. (b.level or 1),
        '<span risu-btn="cb|deck" class="cbx-ic">🂠 ' .. #b.cards .. '</span><span risu-btn="cb|flee" class="cbx-ic">💨 도망</span>') }

    -- The enemy: slashes and a flash where the card lands, bubbles, sparks,
    -- a ring for a curse, a glow when it grows stronger.
    local medal = { simple and CB.foeGlyph(b.name, b.tier) or CB.picture(CB.foeSource(b.name, b.art), CB.foeGlyph(b.name, b.tier)) }
    if anim.hits then
        for i = 1, anim.hits do
            medal[#medal + 1] = '<i class="cbx-slashw" style="transform:rotate(' .. (i % 2 == 1 and -32 or 28) .. 'deg)"><i class="cbx-slash"' .. at(foeWait + (i - 1) * 0.12) .. '></i></i>'
        end
        medal[#medal + 1] = '<i class="cbx-impact"' .. at(foeWait) .. '></i>'
    end
    if anim.enemyPoison then medal[#medal + 1] = bubbles(foeWait) end
    if anim.enemySpark then medal[#medal + 1] = burst(6, 'cbx-spark', '✦', foeWait) end
    if anim.enemyCurse then medal[#medal + 1] = '<i class="cbx-ring"' .. at(foeWait) .. '></i>' end
    if anim.enemyGlow then medal[#medal + 1] = '<i class="cbx-aura"' .. at(foeWait) .. '></i>' end
    medal[#medal + 1] = float(anim.enemyText, nil, foeWait, anim.big and anim.castAt == 'foe')
    local ghost = (anim.castAt == 'foe' and b.cards[anim.cast]) and ('<div class="cbx-ghost">' .. CB.cardFace(b.cards[anim.cast], 0.8) .. '</div>') or ''
    local intentText = CB.iconText(CB.intentText(b))
    local move = e.moves[e.step] or {}
    if move.summon and not simple then
        -- The creature it will call, in place of the paw.
        local m = CB.minion(b, move.summon)
        local src = CB.foeSource(nil, m.art)
        if src then intentText = intentText:gsub('🐾', '<img class="cbx-icon cbx-minicon" src="' .. src .. '" alt="🐾">') end
    end
    local intent = '<div class="cbx-intent' .. (foeTurn and ' cbx-act' or '') .. '">' .. intentText .. '</div>'
    local enemy = '<div class="cbx-foe' .. (taps.hero and ' cbx-aimable' or '') .. '"' .. (taps.hero and (' risu-btn="' .. taps.hero .. '"') or '') .. '>'
        .. (not simple and intent or '') .. '<div class="cbx-medalw' .. (lunge and ' cbx-lunge' or '') .. '"'
        .. ((lunge or 1) > 1 and (' style="animation-duration:.36s;animation-iteration-count:' .. lunge .. '"') or '') .. '>'
        .. '<div class="cbx-medal' .. (anim.enemy and ' cbx-shake' or '') .. '"' .. (anim.enemy and at(foeWait) or '') .. '>' .. table.concat(medal) .. '</div></div>'
        .. '<div class="cbx-name">' .. escapeHtml(b.name) .. '<span class="cbx-tier">' .. CB.TIER_LABEL[b.tier] .. '</span></div>'
        .. hpBar(e.hp, e.maxHp, 'cbx-red', e.block, { from = anim.enemyFrom, wait = foeWait, block = anim.enemyBreak and 'break' or anim.enemyBlock })
        .. chips(e) .. '</div>'
    if simple then
        out[#out + 1] = '<div class="cbx-arena cbx-' .. b.tier .. '"><div class="cbx-intentrow">' .. intent .. '</div>' .. ghost .. enemy .. '</div>'
        -- The field as text, once there is anything to put on it.
        if CB.anyCreature(b) or CB.anyCreature(e) or CB.fieldUsed(b) then out[#out + 1] = CB.fieldRows(b, anim, taps) end
        out[#out + 1] = '<div class="cbx-note">' .. escapeHtml(b.note or '') .. '</div>'
    end

    -- The player.
    local me = {}
    if anim.castAt == 'me' and b.cards[anim.cast] then me[#me + 1] = '<div class="cbx-ghostme">' .. CB.cardFace(b.cards[anim.cast], 0.8) .. '</div>' end
    if anim.playerPoison then me[#me + 1] = bubbles(meWait) end
    if anim.playerSpark or anim.thornsUp then me[#me + 1] = burst(6, 'cbx-spark', '✦', meWait) end
    if anim.playerCurse then me[#me + 1] = '<i class="cbx-ring"' .. at(meWait) .. '></i>' end
    if anim.playerGlow then me[#me + 1] = '<i class="cbx-aura"' .. at(meWait) .. '></i>' end
    if anim.heal and fx then me[#me + 1] = '<i class="cbx-aura cbx-healaura"' .. at(meWait) .. '></i>' end
    local hurt = anim.player == 'hurt'
    local meStyle = ''
    if hurt and fx then
        meStyle = ' style="animation-delay:' .. fmt(meWait) .. 's' .. ((lunge or 1) > 1 and (';animation-duration:.36s;animation-iteration-count:' .. lunge) or '') .. '"'
    end
    local orb = '<div class="cbx-orb' .. (b.energy == 0 and ' cbx-spent' or '') .. (anim.refill and ' cbx-pop' or '') .. '"' .. (anim.refill and at(0.3) or '') .. '>' .. b.energy .. '/' .. b.maxEnergy .. '</div>'
    if simple then
        out[#out + 1] = '<div class="cbx-me' .. (hurt and ' cbx-shake' or '') .. '"' .. meStyle .. '>' .. orb
        .. '<div style="flex:1;min-width:0"><div class="cbx-who"><b>' .. escapeHtml(user) .. '</b>' .. chips(b) .. '</div>'
        .. '<div style="margin-top:5px">' .. hpBar(b.hp, b.maxHp, 'cbx-green', b.block, { from = anim.playerFrom, wait = meWait, block = anim.playerBreak and 'break' or anim.playerBlock }) .. '</div></div>'
        .. float(anim.playerText, (not hurt) and (anim.heal and 'heal' or 'good') or nil, meWait, anim.big and lunge) .. table.concat(me) .. '</div>'
    else
        out[#out + 1] = CB.stage(b, user, anim, enemy, me, meStyle, meWait, ghost, taps)
            .. '<div class="cbx-note">' .. escapeHtml(b.note or '') .. '</div><div class="cbx-tray">' .. orb
    end

    -- The hand, fanned: one tap lifts a card, a second plays it. Play and
    -- 턴 종료 carry the drawing they were in (b.n), so a tap left over from
    -- an older one is dropped. On the enemy's turn nothing is tapped, and
    -- the cards just played fall away.
    local n = #b.hand
    local cards = {}
    local dealWait = anim.banner == 'mine' and 0.3 or 0
    for k, id in ipairs(b.hand) do
        local card = b.cards[id]
        local selected = b.selected == k and not idle
        local face = CB.cardFace(card, 1, card.cost > b.energy)
        if anim.deal then face = '<div class="cbx-deal" style="animation-delay:' .. fmt(dealWait + (k - 1) * 0.06) .. 's">' .. face .. '</div>' end
        if idle then
            cards[#cards + 1] = '<div style="' .. fanStyle(k, n) .. '">' .. face .. '</div>'
        else
            cards[#cards + 1] = '<div risu-btn="cb|' .. (selected and ('play|' .. k .. '|' .. (b.n or 0)) or ('sel|' .. k)) .. '"'
                .. (selected and ' class="cbx-picked"' or '') .. ' style="' .. fanStyle(k, n, selected) .. ';cursor:pointer">' .. face .. '</div>'
        end
    end
    for k, id in ipairs(anim.toss or {}) do
        local card = b.cards[id]
        if card then
            cards[#cards + 1] = '<div style="' .. fanStyle(k, #anim.toss) .. '"><div class="cbx-toss"' .. at((k - 1) * 0.04) .. '>' .. CB.cardFace(card, 1) .. '</div></div>'
        end
    end
    out[#out + 1] = '<div class="cbx-hand" style="position:relative;height:160px;margin-top:14px">' .. table.concat(cards) .. '</div>'
    local picked = (not idle) and b.selected and b.cards[b.hand[b.selected]]
    local piles = function(middle)
        return '<div style="display:flex;align-items:center;gap:10px;margin-top:10px">'
            .. '<div class="cbx-pile"><div class="cbx-pilen">' .. #b.draw .. '</div>뽑을 더미</div>' .. middle
            .. '<div class="cbx-pile"><div class="cbx-pilen">' .. #b.discard .. '</div>버린 더미</div></div>'
    end
    local aiming = (not idle) and b.aiming and taps.ready[b.aiming] and CB.lanesOf(b)[b.aiming]
    if picked then
        local help = CB.keywordHelp(picked)
        out[#out + 1] = '<div class="cbx-detail"><b>' .. escapeHtml(picked.name) .. '</b> — ' .. escapeHtml(CB.effectText(picked))
            .. ((picked.desc or '') ~= '' and ('<br><span class="cbx-flavour">' .. escapeHtml(picked.desc) .. '</span>') or '')
            .. (#help > 0 and ('<br><span style="font-size:11px;opacity:.75">' .. escapeHtml(table.concat(help, ' ')) .. '</span>') or '')
            .. CB.targetRow(b, taps, CB.isCreature(picked) and 'lane' or 'aim') .. '</div>'
        local full = CB.isCreature(picked) and not CB.freeLane(b)
        out[#out + 1] = '<div style="display:flex;gap:8px;margin-top:8px">'
            .. (full and '<span class="cbx-btn cbx-dark cbx-poor" style="flex:2">레인이 가득 참</span>'
                or ('<span risu-btn="cb|play|' .. b.selected .. '|' .. (b.n or 0) .. '" class="cbx-btn cbx-gold" style="flex:2">▶ 사용</span>'))
            .. '<span risu-btn="cb|unsel" class="cbx-btn cbx-dark" style="flex:1">취소</span></div>'
    elseif aiming then
        out[#out + 1] = '<div class="cbx-detail"><b>' .. escapeHtml(aiming.name) .. '</b> — 공격 ' .. (aiming.atk or 0) .. ' · 체력 ' .. aiming.hp .. '/' .. aiming.maxHp
            .. CB.targetRow(b, taps, 'aim') .. '</div>'
        out[#out + 1] = '<div style="display:flex;gap:8px;margin-top:8px"><span risu-btn="cb|unsel" class="cbx-btn cbx-dark" style="flex:1">취소</span></div>'
    elseif idle then
        out[#out + 1] = piles('<div class="cbx-btn cbx-dark cbx-pulse" style="flex:1">' .. (foeTurn and '적의 차례…' or '…') .. '</div>')
    else
        out[#out + 1] = piles('<span risu-btn="cb|end||' .. (b.n or 0) .. '" class="cbx-btn cbx-gold" style="flex:1">턴 종료</span>')
    end

    if not simple then out[#out + 1] = '</div>' end
    local overlay = {}
    if anim.flash then overlay[#overlay + 1] = '<div class="cbx-flash"' .. at(0.2) .. '></div>' end
    if anim.banner then
        overlay[#overlay + 1] = '<div class="cbx-banner' .. (anim.banner == 'mine' and ' cbx-mine' or '') .. '">'
            .. (anim.banner == 'mine' and (b.turn .. '턴 · 내 차례') or '적의 차례') .. '</div>'
    end
    local inner = table.concat(out)
    if not simple then inner = '<div class="cbx-visual' .. (not fx and ' cbx-still' or '') .. '">' .. inner .. '</div>' end
    return frame(inner, anim, anim.big and 'cbx-quake' or nil, b.n, table.concat(overlay))
end

function CB.deckView(b)
    local faces = {}
    for _, card in ipairs(b.cards) do faces[#faces + 1] = '<div style="margin:12px 5px 0 9px">' .. CB.cardFace(card) .. '</div>' end
    return frame(header('<span class="cbx-turn">🂠 덱 ' .. #b.cards .. '장</span>')
        .. '<div style="display:flex;flex-wrap:wrap;justify-content:center;margin-top:4px">' .. table.concat(faces) .. '</div>'
        .. '<div style="display:flex;margin-top:14px"><span risu-btn="cb|back" class="cbx-btn cbx-dark" style="flex:1">돌아가기</span></div>', nil, nil, b.n)
end

--- A card shown large with its flavour and keywords, turning in with stars.
local function showcase(card, fx)
    local help = CB.keywordHelp(card)
    return '<div style="display:flex;justify-content:center;margin-top:18px"><div class="cbx-showcase' .. (fx and ' cbx-reveal' or '') .. '">'
        .. CB.cardFace(card, 1.4) .. (fx and burst(8, 'cbx-star', '✦', 0.45) or '') .. '</div></div>'
        .. ((card.desc or '') ~= '' and ('<div class="cbx-sub cbx-flavour" style="margin-top:12px">' .. escapeHtml(card.desc) .. '</div>') or '')
        .. (#help > 0 and ('<div class="cbx-sub" style="margin-top:6px;opacity:.85">' .. escapeHtml(table.concat(help, ' ')) .. '</div>') or '')
end

--- Whether a beaten enemy's card waits to be taken or let go.
function CB.capturePending(b)
    return type(b.capture) == 'table' and type(b.capture.card) == 'table' and not b.capture.done and not b.capture.making
end

function CB.endView(b, fx)
    local title = ({ won = '🏆 승리', lost = '💀 패배', fled = '💨 도망' })[b.phase]
    local cheer = fx and b.phase == 'won'
    local out = { header(escapeHtml(b.name) .. ' · ' .. CB.TIER_LABEL[b.tier]) }
    if CB.VIEW ~= 'simple' then
        out[#out + 1] = '<div class="cbx-epilogue cbx-view-' .. (CB.VIEW or 'stage') .. '" style="background-image:url(\'{{raw::cb-art-bg-'
            .. (CB.VIEW == 'board' and 'board' or 'stage') .. '}}\')"><div class="cbx-figure">' .. CB.hero('user') .. '</div><div class="cbx-figure">'
            .. CB.hero('char') .. '</div><div class="cbx-figure' .. (b.phase == 'won' and ' cbx-fallen' or '') .. '">'
            .. CB.picture(CB.foeSource(b.name, b.art), CB.foeGlyph(b.name, b.tier)) .. '</div></div>'
    end
    out[#out + 1] = '<div class="cbx-title">' .. title .. (cheer and burst(10, 'cbx-star', '✦', 0.2) or '') .. '</div>'
    out[#out + 1] = '<div class="cbx-sub">' .. b.turn .. '턴 · 체력 ' .. b.hp .. ' / ' .. b.maxHp
        .. (b.levelUp and ('<span class="cbx-lvl">LEVEL UP · Lv.' .. (b.level or 1) .. '</span>') or '') .. '</div>'
    local reward, capture = b.reward, b.capture
    if (type(reward) == 'table' and reward.making) or (type(capture) == 'table' and capture.making) then
        out[#out + 1] = '<div class="cbx-note cbx-pulse" style="margin-top:18px">보조 모델이 새 카드를 쓰는 중…</div>'
    elseif CB.capturePending(b) then
        -- The beaten enemy first, then the level up's cards.
        out[#out + 1] = '<div style="text-align:center;margin-top:16px;font-size:13px;font-weight:700;color:#f3d79b">🎴 쓰러뜨린 적이 카드가 되었습니다</div>'
            .. showcase(capture.card, fx)
            .. '<div style="display:flex;gap:8px;margin-top:14px"><span risu-btn="cb|take" class="cbx-btn cbx-gold" style="flex:2">🎴 덱에 넣기</span>'
            .. '<span risu-btn="cb|free" class="cbx-btn cbx-dark" style="flex:1">보내 주기</span></div>'
    else
        if type(capture) == 'table' and capture.done == 'take' then
            out[#out + 1] = '<div class="cbx-sub" style="margin-top:10px">🎴 ' .. escapeHtml(capture.card.name) .. ' 카드를 덱에 넣었습니다</div>'
        end
        if type(reward) == 'table' and reward.choices then
            local faces = {}
            for k, card in ipairs(reward.choices) do
                -- The flavour line grows, so the three 고르기 buttons line up.
                faces[#faces + 1] = '<div style="display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:14px">' .. CB.cardFace(card, 1.2)
                    .. '<div class="cbx-flavour" style="flex:1;width:96px;font-size:11px;line-height:1.3;text-align:center">' .. escapeHtml(card.desc) .. '</div>'
                    .. '<span risu-btn="cb|pick|' .. k .. '" class="cbx-btn cbx-gold" style="padding:6px 14px">고르기</span></div>'
            end
            out[#out + 1] = '<div style="text-align:center;margin-top:16px;font-size:13px;font-weight:700;color:#f3d79b">새 카드 하나를 고르세요</div>'
                .. (reward.note and ('<div class="cbx-sub">' .. escapeHtml(reward.note) .. '</div>') or '')
            out[#out + 1] = '<div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap">' .. table.concat(faces) .. '</div>'
            -- The words the three cards use, once each.
            local seen, help = {}, {}
            for _, card in ipairs(reward.choices) do
                for _, line in ipairs(CB.keywordHelp(card)) do
                    if not seen[line] then seen[line] = true help[#help + 1] = escapeHtml(line) end
                end
            end
            if #help > 0 then
                out[#out + 1] = '<div style="margin-top:12px;font-size:11px;line-height:1.5;opacity:.75">' .. table.concat(help, '<br>') .. '</div>'
            end
            out[#out + 1] = '<div style="display:flex;margin-top:14px"><span risu-btn="cb|skip" class="cbx-btn cbx-dark" style="flex:1">건너뛰기</span></div>'
        elseif type(reward) == 'table' and reward.waiting then
            out[#out + 1] = '<div class="cbx-note" style="margin-top:16px">다음 답에서 메인 모델이 새 카드 3장을 씁니다.<br>창을 닫고 보내기를 누르세요.</div>'
            out[#out + 1] = '<div style="display:flex"><span risu-btn="cb|close" class="cbx-btn cbx-gold" style="flex:1">닫기</span></div>'
        else
            out[#out + 1] = '<div class="cbx-note" style="margin-top:16px">전투 기록을 이 전투의 메시지에 붙였습니다.<br>창을 닫고 보내기를 누르면 이야기가 이어집니다.</div>'
            out[#out + 1] = '<div style="display:flex"><span risu-btn="cb|done" class="cbx-btn cbx-gold" style="flex:1">닫기</span></div>'
        end
    end
    return frame(table.concat(out), { open = true }, 'cbx-' .. b.phase, b.n, cheer and confetti() or nil)
end

--- The form that makes the signature card by hand (risu-form, read by
--- onFormSubmit). Its fields are not called name or title: the sanitizer
--- drops a name a form already has as a property.
function CB.sigForm(draft)
    local raw = draft.raw or { name = '', cost = 1, effects = { summon = 4, power = 2 }, desc = '' }
    local effects = raw.effects or {}
    local picks = {}
    for _, effect in ipairs(CB.EFFECTS) do
        local value = effects[effect.key]
        if not effect.flag and not effect.creature and type(value) == 'number' and #picks < 3 then picks[#picks + 1] = { effect.key, value } end
    end
    local function menu(name, chosen)
        local options = { '<option value=""' .. (chosen and '' or ' selected') .. '>없음</option>' }
        for _, effect in ipairs(CB.EFFECTS) do
            if not effect.flag and not effect.creature then
                options[#options + 1] = '<option value="' .. effect.key .. '"' .. (chosen == effect.key and ' selected' or '') .. '>' .. CB.EFFECT_LABEL[effect.key] .. '</option>'
            end
        end
        return '<select name="' .. name .. '" class="cbx-field">' .. table.concat(options) .. '</select>'
    end
    local costs, budget = {}, {}
    for c = 0, 3 do
        costs[#costs + 1] = '<option value="' .. c .. '"' .. (c == (raw.cost or 1) and ' selected' or '') .. '>' .. c .. '</option>'
        budget[#budget + 1] = c .. ': ' .. math.floor(CB.budget(c, 'rare') / CB.SLACK) .. '점'
    end
    local rows = {
        '<div class="cbx-row"><span class="cbx-lab">이름</span><input name="cname" maxlength="14" class="cbx-field" value="' .. escapeHtml(raw.name or '') .. '" placeholder="카드 이름"></div>',
        '<div class="cbx-row"><span class="cbx-lab">비용</span><select name="cost" class="cbx-field">' .. table.concat(costs) .. '</select></div>',
    }
    for i = 1, 3 do
        local pick = picks[i] or {}
        rows[#rows + 1] = '<div class="cbx-row"><span class="cbx-lab">효과 ' .. i .. '</span>' .. menu('k' .. i, pick[1])
            .. '<input name="v' .. i .. '" type="number" min="1" max="40" inputmode="numeric" class="cbx-field cbx-num" value="' .. (pick[2] or '') .. '"></div>'
    end
    local flags = {}
    for _, key in ipairs(CB.FLAG_ORDER) do
        flags[#flags + 1] = '<label class="cbx-check"><input type="checkbox" name="' .. key .. '" value="1"' .. (effects[key] and ' checked' or '') .. '>' .. CB.FLAG_LABEL[key] .. '</label>'
    end
    rows[#rows + 1] = '<div>' .. table.concat(flags) .. '</div>'
    -- The signature card stands on the field as the player's own figure.
    local number = function(name, value)
        return '<input name="' .. name .. '" type="number" min="1" max="30" inputmode="numeric" class="cbx-field cbx-num" value="' .. (value or '') .. '">'
    end
    rows[#rows + 1] = '<div class="cbx-row"><span class="cbx-lab">생물</span><span class="cbx-hint">공격</span>' .. number('ca', effects.power)
        .. '<span class="cbx-hint">체력</span>' .. number('ch', effects.summon) .. '</div>'
    rows[#rows + 1] = '<div class="cbx-row"><span class="cbx-lab">설명</span><input name="cdesc" maxlength="60" class="cbx-field" value="' .. escapeHtml(raw.desc or '') .. '" placeholder="한 줄 설명 (안 써도 됨)"></div>'
    rows[#rows + 1] = '<div class="cbx-hint">비용마다 담을 수 있는 점수 — ' .. table.concat(budget, ' · ') .. '. 피해·방어 1이 1점, 독 2점, 약화·취약·가시 3점, 카드 뽑기 4점, 에너지 5점, 힘·민첩 6점이고, 체력 소모는 점수를 덜어 줍니다. 대표 카드는 필드에 서는 생물이라 생물 공격력 1이 3.5점, 체력 1이 1점이고, 비워 두면 비용에 맞게 정해집니다. 넘치면 비용이 먼저 오르고, 그래도 넘치면 숫자가 줄어듭니다.</div>'
    if draft.note then rows[#rows + 1] = '<div class="cbx-note">' .. escapeHtml(draft.note) .. '</div>' end
    rows[#rows + 1] = '<div style="display:flex;gap:8px"><button type="submit" class="cbx-btn cbx-gold" style="flex:2;font:inherit;font-weight:800">만들기</button>'
        .. (draft.card and '<span risu-btn="cb|sigback" class="cbx-btn cbx-dark" style="flex:1">취소</span>' or '') .. '</div>'
    return '<form risu-form="cb|sig" class="cbx-form">' .. table.concat(rows) .. '</form>'
end

--- The step before the first fight: the model writing the signature card,
--- the card to start with (or to write again, or make by hand), or the form.
function CB.sigView(b, fx)
    local draft = b.sigDraft or {}
    local out = { header('<span class="cbx-turn">★ 대표 카드</span> · ' .. escapeHtml(b.name ~= '' and b.name or '적')) }
    out[#out + 1] = '<div class="cbx-sub" style="margin-top:10px;line-height:1.5">전투에 앞서 이 이야기의 대표 카드 한 장을 덱에 넣습니다.<br>한 번 정하면 이 채팅에서 계속 씁니다.</div>'
    if draft.making then
        out[#out + 1] = '<div class="cbx-note cbx-pulse" style="margin-top:18px">보조 모델이 대표 카드를 쓰는 중…</div>'
    elseif draft.form or not draft.card then
        out[#out + 1] = CB.sigForm(draft)
    else
        out[#out + 1] = showcase(draft.card, fx)
            .. (draft.note and ('<div class="cbx-note">' .. escapeHtml(draft.note) .. '</div>') or '')
        out[#out + 1] = '<div style="display:flex;margin-top:12px"><span risu-btn="cb|sigok" class="cbx-btn cbx-gold" style="flex:1">⚔️ 이 카드로 전투 시작</span></div>'
        local more = draft.hand and '<span risu-btn="cb|sigform" class="cbx-btn cbx-dark" style="flex:1">✏️ 고치기</span>'
            or ('<span risu-btn="cb|sigredo" class="cbx-btn cbx-dark" style="flex:1">🔄 다시 쓰기</span>'
                .. '<span risu-btn="cb|sigform" class="cbx-btn cbx-dark" style="flex:1">✏️ 직접 만들기</span>')
        out[#out + 1] = '<div style="display:flex;gap:8px;margin-top:8px">' .. more .. '</div>'
    end
    return frame(table.concat(out), b.anim, nil, b.n)
end

-- In the chat itself (no <style> there): inline styles only.
local CHAT_GOLD = 'display:inline-block;cursor:pointer;user-select:none;padding:7px 16px;border-radius:10px;font-weight:800;color:#3a2205;'
    .. 'background:linear-gradient(180deg,#ffe49c,#d9a441 55%,#a8731f);border:1px solid #fff0bf;box-shadow:0 2px 0 #6b4510'
local CHAT_DARK = 'display:inline-block;cursor:pointer;user-select:none;padding:7px 14px;border-radius:10px;font-weight:700;color:#eadfca;'
    .. 'background:linear-gradient(180deg,#3d3345,#251e2a);border:1px solid rgba(227,189,114,.35)'

local function pill(action, text)
    return '<div style="margin:8px 0"><span risu-btn="cb|' .. action .. '" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;'
        .. 'padding:6px 14px;border-radius:999px;font-size:.9em;font-weight:700;color:#f1e6cf;background:linear-gradient(180deg,#3a2a35,#1f1720);'
        .. 'border:1px solid #8a6a35;box-shadow:0 2px 8px rgba(0,0,0,.35)">' .. text .. '</span></div>'
end

local function startCard(spec, action)
    local tier = CB.TIER_LABEL[spec.tier] and spec.tier or 'normal'
    local name = spec.name ~= '' and spec.name or '적'
    return '<div style="margin:8px 0;padding:12px 14px;border-radius:14px;color:#f1e6cf;border:2px solid #8a6a35;'
        .. 'background:radial-gradient(ellipse at 20% 0%,rgba(170,50,40,.35),rgba(0,0,0,0) 60%),linear-gradient(180deg,#2c2333,#16111b);box-shadow:0 6px 18px rgba(0,0,0,.35)">'
        .. '<div style="display:flex;align-items:center;gap:12px"><div style="flex:none;width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;'
        .. 'background:radial-gradient(circle at 35% 30%,#8f3d37,#2a1012 70%);border:2px solid #c0453c">' .. CB.foeGlyph(name, tier) .. '</div>'
        .. '<div style="min-width:0"><div style="font-size:11px;color:#e3bd72;font-weight:800;letter-spacing:.05em">⚔️ 전투 · ' .. CB.TIER_LABEL[tier] .. '</div>'
        .. '<div style="font-size:16px;font-weight:800">' .. escapeHtml(name) .. '</div></div></div>'
        .. '<div style="display:flex;gap:8px;margin-top:10px"><span risu-btn="cb|' .. action .. '" style="' .. CHAT_GOLD .. '">전투 시작</span>'
        .. '<span risu-btn="cb|later" style="' .. CHAT_DARK .. '">무시</span></div></div>'
end

--- A <battle-log> block shown folded.
function CB.logCard(body)
    local lines = {}
    for line in tostring(body or ''):gmatch('[^\n]+') do
        line = CB.trim(line)
        if line ~= '' then lines[#lines + 1] = escapeHtml(line) end
    end
    local title = table.remove(lines, 1) or '⚔️ 전투'
    return '<details style="margin:8px 0;padding:7px 12px;border-radius:10px;font-size:.9em;border:1px solid rgba(227,189,114,.45);background:rgba(227,189,114,.07)">'
        .. '<summary style="cursor:pointer;font-weight:700">' .. title .. ' · 전투 기록</summary>'
        .. '<div style="margin-top:6px;opacity:.85;line-height:1.5">' .. table.concat(lines, '<br>') .. '</div></details>'
end

--- A <battle-turn> block shown folded: the turns the next reply tells.
function CB.turnCard(body)
    local lines = {}
    for line in tostring(body or ''):gmatch('[^\n]+') do
        line = CB.trim(line)
        if line ~= '' then lines[#lines + 1] = escapeHtml(line) end
    end
    local title = table.remove(lines, 1) or '⚔️ 전투'
    local turns = {}
    for _, line in ipairs(lines) do
        local n = line:match('^(%d+)턴:')
        if n then turns[#turns + 1] = n end
    end
    local label = #turns == 0 and '' or (' · ' .. turns[1] .. (#turns > 1 and ('~' .. turns[#turns]) or '') .. '턴')
    return '<details style="margin:8px 0;padding:7px 12px;border-radius:10px;font-size:.9em;border:1px solid rgba(111,168,220,.5);background:rgba(111,168,220,.08)">'
        .. '<summary style="cursor:pointer;font-weight:700">' .. title .. label .. '</summary>'
        .. '<div style="margin-top:6px;opacity:.85;line-height:1.5">' .. table.concat(lines, '<br>') .. '</div></details>'
end

--- Turn by turn, after a turn: send to have it told, or play on without.
local function waitCard(b)
    local told = math.max(1, (b.turn or 2) - 1)
    return '<div style="margin:8px 0;padding:10px 14px;border-radius:14px;color:#f1e6cf;border:1px solid #8a6a35;'
        .. 'background:linear-gradient(180deg,#2c2333,#16111b);box-shadow:0 4px 14px rgba(0,0,0,.3)">'
        .. '<div style="font-size:12px;color:#e3bd72;font-weight:800">⚔️ ' .. escapeHtml(b.name) .. ' · ' .. told .. '턴 끝</div>'
        .. '<div style="font-size:13px;margin-top:4px;line-height:1.5">보내기를 누르면 이 턴이 이야기로 이어지고, 답이 오면 다음 턴 창이 열립니다.</div>'
        .. '<div style="margin-top:8px"><span risu-btn="cb|open" style="' .. CHAT_DARK .. '">이야기 없이 다음 턴</span></div></div>'
end

--- What is still to see of the fight on the chat's last message.
function CB.lastExtras(tid, text, b)
    CB.visuals(tid)
    if b and b.phase == 'pending' then return startCard(b, 'start') end
    -- A tag nobody turned into a fight (written by hand, or the module was
    -- off when the reply came): start it from here. Not in the middle of one.
    if type(text) == 'string' and text:find(CB.TAG_PATTERN) and not (b and (b.phase == 'fight' or b.phase == 'sig')) then
        local _, spec = CB.takeBattleTag(text)
        if spec then return startCard(spec, 'tag') end
    end
    if not b then return '' end
    local user = getPersonaName(tid) or ''
    local settings = CB.settings(tid)
    local fx = settings.pace > 0
    if b.enemy then b.chosen = settings.attack == 'chosen' or nil end
    if b.open then
        if b.phase == 'sig' then return CB.sigView(b, fx) end
        if b.phase == 'fight' then
            if b.view == 'deck' then return CB.deckView(b) end
            return CB.fightView(b, user, fx)
        end
        -- The blow that ended it, on screen before CB.finish clears the
        -- fight away for its end screen.
        if b.cards and b.enemy then return CB.fightView(b, user, fx) end
        return CB.endView(b, fx)
    end
    if b.phase == 'fight' and b.awaitStory then return waitCard(b) end
    if b.phase == 'fight' or b.phase == 'sig' then return pill('open', '⚔️ 전투로 돌아가기 · ' .. escapeHtml(b.name ~= '' and b.name or '적')) end
    if CB.capturePending(b) then return pill('open', '🎴 ' .. escapeHtml(b.capture.card.name) .. ' 카드 받기') end
    if type(b.reward) == 'table' and b.reward.choices then return pill('open', '🎁 새 카드 고르기') end
    return ''
end

listenEdit('editDisplay', function(tid, text, meta)
    if type(text) ~= 'string' then return text end
    local clean = CB.stripMarks(text):gsub('\n?' .. CB.CARDS_PATTERN, '')
    -- A log image or text log (PocketRisu says so in meta.logCapture): the
    -- text as written, the fight as its log.
    if type(meta) == 'table' and meta.logCapture then
        return (clean:gsub('<battle%-log>\n?', ''):gsub('\n?</battle%-log>', '')
            :gsub('<battle%-turn>\n?', ''):gsub('\n?</battle%-turn>', ''):gsub('\n?' .. CB.TAG_PATTERN, ''))
    end
    local index = type(meta) == 'table' and tonumber(meta.index) or nil
    clean = clean:gsub(CB.LOG_PATTERN, function(body) return CB.logCard(body) end)
    clean = clean:gsub(CB.TURN_PATTERN, function(body) return CB.turnCard(body) end)
    if not index then return clean end
    local isLast = index == getChatLength(tid) - 1
    if not isLast then
        clean = clean:gsub('\n?' .. CB.TAG_PATTERN, '')
        -- Turn by turn, older messages hold the fight as it stood then: only
        -- the message it is on now says so.
        local b = CB.readMark(text, 'b')
        local seen = (b and b.phase == 'fight') and tableState(tid, 'cb_live') or nil
        if seen and seen.id == b.id and tonumber(seen.at) == index then
            clean = clean .. '\n\n' .. pill('open', '⚔️ ' .. escapeHtml(b.name) .. ' · 전투 중')
        end
        return clean
    end
    local extra = CB.lastExtras(tid, text, CB.findFight(tid, false, text))
    clean = clean:gsub('\n?' .. CB.TAG_PATTERN, '')
    if extra ~= '' then clean = clean .. '\n\n' .. extra end
    return clean
end)

------------------------------------------------------------------------------
-- Starting, ending
------------------------------------------------------------------------------

-- Tests set this to 0, so scenes do not wait.
CB.PACE_SCALE = 1

--- Wait ms before the next scene (Risu's sleep; no wait where it is missing).
function CB.pause(tid, ms)
    ms = math.floor((ms or 0) * CB.PACE_SCALE)
    if ms <= 0 then return end
    pcall(function() return sleep(tid, ms):await() end)
end

--- The signature card the auxiliary model writes for this story, on the
--- fight waiting for it: a card from the module's pool when the module
--- writes no cards or the model could not. The caller saves the fight.
function CB.writeSig(tid, at, b, settings)
    local run = CB.loadRun(tid)
    -- Not the run's own generator: writing it again picks another.
    run.seed = math.random(1, 2147483646)
    local slots = { { rarity = 'rare', cost = CB.rand(run, 2), sig = true } }
    if settings.cards == 'pool' then
        b.sigDraft = { card = CB.parseCards(run, nil, slots)[1], note = '레벨업 카드가 \'기본 카드만\'이라 모듈의 카드에서 골랐습니다.' }
        return
    end
    b.sigDraft = { making = true }
    CB.saveFight(tid, at, b)
    reloadDisplay(tid)
    local cards, written = CB.parseCards(run, ask(tid, CB.cardPrompt(tid, run, slots)), slots)
    b.sigDraft = { card = cards[1], note = written == 0 and '보조 모델이 쓰지 못해 모듈의 카드에서 골랐습니다. 다시 쓰거나 직접 만들 수 있어요.' or nil }
end

--- Start the fight spec on message at, from the run as the chat holds it.
--- While the run has no signature card (and 대표 카드 is not off), the
--- fight waits at the signature card's step first (phase 'sig').
function CB.begin(tid, at, spec, settings)
    local run = CB.loadRun(tid)
    if settings.sig ~= 'none' and not CB.sigCard(run) then
        local b = { id = spec.id, name = spec.name, tier = spec.tier, art = spec.art, phase = 'sig', open = true, n = 0,
            anim = { open = true }, sigDraft = { hand = settings.sig == 'hand' or nil } }
        if settings.sig == 'ai' then CB.writeSig(tid, at, b, settings) end
        CB.saveFight(tid, at, b)
        return b
    end
    local b = CB.newBattle(run, spec, settings)
    CB.saveFight(tid, at, b)
    return b
end

--- Turn by turn, the message a turn goes on: the last one when it is the
--- module's own turn message (turns played with no reply in between), else
--- a new user message, so pressing send with nothing typed gets the reply
--- that tells it.
function CB.turnMessage(tid)
    local len = getChatLength(tid)
    local last = len > 0 and getChat(tid, len - 1) or nil
    if type(last) == 'table' and last.role == 'user' and type(last.data) == 'string' and last.data:find('<battle%-turn>') then
        return len - 1
    end
    addChat(tid, 'user', '')
    return getChatLength(tid) - 1
end

--- Turn by turn, after a turn: its block and the fight go on the turn
--- message, and the window waits for the reply that tells it. The fight's
--- older marks stay as it stood then, so taking this message back (delete,
--- or a reroll before it) takes the turn back too.
function CB.tellTurn(tid, b)
    local first = (b.told or 0) + 1
    local lines = {}
    for i = first, #b.log do lines[#lines + 1] = b.log[i] end
    b.told = #b.log
    local user = getPersonaName(tid) or ''
    lines[#lines + 1] = '지금: ' .. user .. ' 체력 ' .. b.hp .. '/' .. b.maxHp .. ', ' .. b.name .. ' 체력 ' .. b.enemy.hp .. '/' .. b.enemy.maxHp .. CB.fieldText(b)
    local block = '<battle-turn>\n⚔️ ' .. b.name .. ' (' .. CB.TIER_LABEL[b.tier] .. ')\n' .. table.concat(lines, '\n') .. '\n</battle-turn>'
    local at = CB.turnMessage(tid)
    local text = CB.writeMark(messageText(tid, at) or '', 'b', nil)
    text = text ~= '' and (text .. '\n\n' .. block) or block
    b.open, b.view, b.selected, b.awaitStory = false, nil, nil, true
    setChat(tid, at, CB.writeMark(text, 'b', b))
    setState(tid, 'cb_live', { id = b.id, at = at })
end

--- After the last move: settle the run and put it, the log and the fight's
--- end screen on the fight's message (turn by turn, on the turn message).
--- The signature card joins the run with the first fight it was in. A win
--- turns the beaten enemy into a card to take or let go; a level up offers
--- three new cards (or waits for the main model's). What the auxiliary
--- model writes, it writes in one request.
function CB.finish(tid, at, b, settings)
    if b.perTurn then at = CB.turnMessage(tid) end
    local text = messageText(tid, at)
    if not text then return end
    local run = CB.loadRun(tid)
    if b.sigCard and not CB.sigCard(run) then run.deck[#run.deck + 1] = CB.copy(b.sigCard) end
    local foe = nil
    if b.phase == 'won' and settings.capture and b.enemy then
        local card = CB.foeCard(b.name, b.tier, b.enemy.moves, b.art, b.level)
        if card then foe = { name = card.name, glyph = card.glyph, moves = CB.movesText(b.enemy.moves), card = card } end
    end
    CB.settle(run, b)
    local log = CB.logBlock(run, b, getPersonaName(tid) or '', settings.fullLog)
    -- What the end screen does not need. The field's cards were never out
    -- of the run's deck: they are back in it for the next fight.
    b.cards, b.draw, b.hand, b.discard, b.enemy, b.log, b.played, b.view = nil, nil, nil, nil, nil, nil, nil, nil
    b.awaitStory, b.sigCard, b.anim, b.field, b.aiming, b.chosen = nil, nil, nil, nil, nil, nil
    local writeFoe = foe and settings.cards == 'aux'
    if foe then b.capture = { card = foe.card, making = writeFoe or nil } end
    if b.levelUp then
        local slots = CB.rollSlots(run)
        if settings.cards == 'main' then
            b.reward = { slots = slots, waiting = true, level = run.level, deck = CB.deckNames(run) }
        elseif settings.cards == 'pool' then
            b.reward = { slots = slots, choices = CB.parseCards(run, nil, slots) }
        else
            b.reward = { slots = slots, making = true }
        end
    end
    text = CB.writeMark(text, 'b', nil)
    text = CB.writeMark((text ~= '' and (text .. '\n\n') or '') .. log, 'r', run)
    setChat(tid, at, CB.writeMark(text, 'b', b))
    setState(tid, 'cb_live', { id = b.id, at = at })
    local making = b.reward and b.reward.making
    if not (making or writeFoe) then return end
    reloadDisplay(tid)
    local slots = {}
    if making then
        for _, slot in ipairs(b.reward.slots) do slots[#slots + 1] = slot end
    end
    if writeFoe then slots[#slots + 1] = { rarity = foe.card.rarity, cost = foe.card.cost, foe = foe } end
    local cards, _, wrote = CB.parseCards(run, ask(tid, CB.cardPrompt(tid, run, slots)), slots)
    if writeFoe then
        b.capture = { card = table.remove(cards) }
        table.remove(wrote)
    end
    if making then
        local written = 0
        for _, ok in ipairs(wrote) do
            if ok then written = written + 1 end
        end
        b.reward = { slots = b.reward.slots, choices = cards }
        if written < #b.reward.slots then
            b.reward.note = written == 0 and '보조 모델이 카드를 쓰지 못해 기본 카드에서 골랐습니다 (모듈의 저수준 접근과 보조 모델 설정을 확인해 주세요)'
                or '보조 모델이 쓰지 못한 자리는 기본 카드로 채웠습니다'
        end
    end
    CB.saveFight(tid, at, b)
end

--- The text with one more line at the end of its last battle log.
function CB.logLine(text, line)
    local head, tail = tostring(text or ''):match('^(.*)\n(</battle%-log>.*)$')
    if not head then return text end
    return head .. '\n' .. line .. '\n' .. tail
end

onOutput = async(function(tid)
    local len = getChatLength(tid)
    if len == 0 then return end
    local last = getChat(tid, len - 1)
    if type(last) ~= 'table' or last.role == 'user' then return end
    local settings = CB.settings(tid)
    local b, at = CB.findFight(tid, true)
    local text, cardsBody = CB.takeCards(last.data or '')
    local spec
    text, spec = CB.takeBattleTag(text)
    -- One fight at a time: a tag in the middle of one is dropped.
    if b and (b.phase == 'fight' or b.phase == 'sig') then spec = nil end

    local changed = false
    -- The main model's cards, asked for in this reply.
    if b and type(b.reward) == 'table' and b.reward.waiting then
        local cards, written = CB.parseCards(b, cardsBody, b.reward.slots)
        b.reward = { slots = b.reward.slots, choices = cards }
        if written < #cards then
            b.reward.note = written == 0 and '메인 모델이 카드를 쓰지 않아 기본 카드에서 골랐습니다' or '메인 모델이 쓰지 못한 자리는 기본 카드로 채웠습니다'
        end
        b.open = true
        changed = true
    end
    -- Turn by turn: this reply told the last turn, so the next one opens.
    if b and b.phase == 'fight' and b.awaitStory then
        b.awaitStory, b.open, b.anim = nil, true, { open = true, deal = true, banner = 'mine' }
        changed = true
    end
    if changed then
        b.n = (b.n or 0) + 1
        if at == len - 1 then text = CB.writeMark(text, 'b', b) else CB.saveFight(tid, at, b) end
    end

    if spec then
        -- A new fight takes the place of one still waiting (or of an end
        -- screen still open).
        if b and at ~= len - 1 then CB.saveFight(tid, at, CB.closedMark(b)) end
        setChat(tid, len - 1, CB.writeMark(text, 'b', spec))
        setState(tid, 'cb_live', { id = spec.id, at = len - 1 })
        local start = not settings.popup
        if settings.popup then
            local ok, picked = pcall(function()
                return alertSelect(tid, { '⚔️ 전투 시작 · ' .. (spec.name ~= '' and spec.name or '적'), '나중에' }):await()
            end)
            start = ok and tonumber(picked) == 0
        end
        if start then CB.begin(tid, len - 1, spec, settings) end
    elseif text ~= last.data then
        setChat(tid, len - 1, text)
    end
    reloadDisplay(tid)
end)

------------------------------------------------------------------------------
-- Buttons
------------------------------------------------------------------------------

onButtonClick = async(function(tid, data)
    local action, rest = tostring(data or ''):match('^cb|(%a+)|?(.*)$')
    if not action then return end
    -- cb|action|k|drawing|target: target is a lane (L1), an enemy creature
    -- (E2) or the enemy (H).
    local first, drawnIn, target = rest:match('^([^|]*)|?([^|]*)|?(.*)$')
    local k, drawing = tonumber(first), tonumber(drawnIn)
    local settings = CB.settings(tid)
    local len = getChatLength(tid)
    local b, at = CB.findFight(tid, true)
    -- Play, 턴 종료 and a creature's attack carry the drawing they were
    -- tapped in: one left over from an older drawing (a double tap, taps
    -- while the enemy moved) would play another card or end the next turn.
    local guarded = action == 'play' or action == 'end' or action == 'aim' or action == 'hit'
    if b and drawing and guarded and drawing ~= (b.n or 0) then return end
    if b then b.anim, b.n = nil, (b.n or 0) + 1 end
    -- How creatures attack (생물 공격) is read at every tap, as the view is;
    -- a fight from before 1.0 gets its empty lanes.
    if b and b.enemy then
        b.chosen = settings.attack == 'chosen' or nil
        CB.lanesOf(b)
        CB.lanesOf(b.enemy)
    end
    local whole, saved, shown = false, false, false
    -- The window is drawn on the last message.
    local function redraw() reloadChat(tid, getChatLength(tid) - 1) end
    -- A scene on screen for hold ms (at the 전투 연출 pace); what comes
    -- next is a new drawing.
    local function show(hold)
        CB.saveFight(tid, at, b)
        redraw()
        CB.pause(tid, (hold or 0) * settings.pace)
        b.n = b.n + 1
    end

    if action == 'tag' then
        local text, spec = CB.takeBattleTag(messageText(tid, len - 1))
        if not spec or (b and (b.phase == 'fight' or b.phase == 'sig')) then return end
        if b and at ~= len - 1 then CB.saveFight(tid, at, CB.closedMark(b)) end
        setChat(tid, len - 1, text)
        b, at = CB.begin(tid, len - 1, spec, settings), len - 1
        whole, saved = true, true
    elseif not b then
        return
    elseif action == 'start' or action == 'later' then
        if b.phase ~= 'pending' then return end
        if action == 'later' then
            CB.saveFight(tid, at, nil)
        else
            -- Started from a later message: it is fought (and logged) there.
            if at ~= len - 1 then
                CB.saveFight(tid, at, nil)
                at = len - 1
            end
            b = CB.begin(tid, at, b, settings)
            whole = true
        end
        saved = true
    elseif action == 'open' then
        b.open = true
        b.anim = { open = true }
        whole = true
    elseif action == 'close' then
        b.open = false
        b.view = nil
        whole = true
    elseif action == 'deck' then
        b.view = 'deck'
    elseif action == 'back' then
        b.view = nil
    elseif b.phase == 'sig' then
        local draft = b.sigDraft or {}
        if action == 'sigok' and draft.card then
            -- The fight starts with the card in its deck; the run takes it
            -- when the fight ends (CB.finish).
            local run = CB.loadRun(tid)
            local card = CB.copy(draft.card)
            card.sig = true
            run.deck[#run.deck + 1] = card
            local n = b.n
            b = CB.newBattle(run, { id = b.id, name = b.name, tier = b.tier, art = b.art }, settings)
            b.sigCard, b.n, b.anim = card, n, { open = true, deal = true, banner = 'mine' }
            whole = true
        elseif action == 'sigredo' and draft.card and not draft.hand then
            CB.writeSig(tid, at, b, settings)
        elseif action == 'sigform' then
            b.sigDraft = { hand = draft.hand, raw = draft.raw or (draft.card and CB.rawCard(draft.card)) or nil, card = draft.card, form = true }
        elseif action == 'sigback' and draft.card then
            draft.form, draft.note = nil, nil
        end
    elseif b.phase == 'fight' then
        if action == 'sel' and k then
            b.selected, b.aiming = k, nil
            local card = b.cards[b.hand[k] or 0]
            b.note = (card and card.cost > b.energy) and '에너지가 모자랍니다'
                or ((CB.isCreature(card) and not CB.freeLane(b)) and '레인이 가득 찼습니다: 내 생물이 쓰러져야 낼 수 있습니다' or '')
        elseif action == 'unsel' then
            b.selected, b.aiming = nil, nil
        elseif action == 'play' and k then
            CB.play(b, k, target)
            -- The last blow lands on screen before the end screen comes.
            if b.phase ~= 'fight' and settings.pace > 0 then show(CB.HOLD.over) end
        elseif action == 'aim' and k and b.chosen then
            -- 직접 고르기: pick a creature of ours, then what it attacks.
            local c = CB.lanesOf(b)[k]
            if c and not c.fresh and not c.acted and (c.atk or 0) > 0 then
                b.aiming, b.selected = k, nil
                b.note = c.name .. ': 공격할 대상을 누르세요'
            elseif c then
                b.note = c.fresh and (c.name .. '은(는) 이번 턴에 나와서 다음 턴부터 공격합니다') or (c.name .. '은(는) 이번 턴에 공격했습니다')
            end
        elseif action == 'hit' and k and b.chosen then
            local to = target == 'H' and 'H' or tonumber(tostring(target or ''):match('^E(%d)$'))
            if to and CB.attack(b, k, to) and b.phase ~= 'fight' and settings.pace > 0 then show(CB.HOLD.over) end
        elseif action == 'end' then
            if settings.pace > 0 then
                CB.endTurn(b, function(scene, hold)
                    -- Turn by turn the new hand waits for the story.
                    if scene == 3 and b.perTurn and b.phase == 'fight' then return end
                    show(hold)
                end)
                -- The last scene is on screen already.
                shown = b.phase == 'fight' and not b.perTurn
                saved = shown
            else
                CB.endTurn(b)
            end
            -- Turn by turn: the turn goes to the story, and the window waits.
            if b.perTurn and b.phase == 'fight' then
                CB.tellTurn(tid, b)
                whole, saved = true, true
            end
        elseif action == 'flee' then
            local ok, sure = pcall(function() return alertConfirm(tid, '도망칠까요? 경험치 없이 전투가 끝납니다.'):await() end)
            if ok and sure then b.phase = 'fled' end
        end
        if b.phase ~= 'fight' then
            CB.finish(tid, at, b, settings)
            whole, saved, shown = true, true, false
        end
    elseif (action == 'take' or action == 'free') and CB.capturePending(b) then
        -- The beaten enemy's card goes into the run this fight left, and
        -- the log says so for the story.
        if action == 'take' then
            local run = CB.loadRun(tid)
            run.deck[#run.deck + 1] = CB.copy(b.capture.card)
            setChat(tid, at, CB.logLine(CB.writeMark(messageText(tid, at), 'r', run), '카드로 얻음: ' .. b.capture.card.name))
        end
        b.capture.done = action
        whole = true
    elseif action == 'pick' and k and not CB.capturePending(b) and type(b.reward) == 'table' and b.reward.choices and b.reward.choices[k] then
        -- The new card goes into the run this fight left, on its message.
        local run = CB.loadRun(tid)
        run.deck[#run.deck + 1] = CB.copy(b.reward.choices[k])
        setChat(tid, at, CB.writeMark(CB.writeMark(messageText(tid, at), 'r', run), 'b', CB.closedMark(b)))
        setState(tid, 'cb_live', false)
        whole, saved = true, true
    elseif (action == 'skip' or action == 'done') and not CB.capturePending(b) then
        CB.saveFight(tid, at, CB.closedMark(b))
        whole, saved = true, true
    end

    if not saved then CB.saveFight(tid, at, b) end
    if shown then return end
    if whole then reloadDisplay(tid) else redraw() end
end)

--- The signature card form (CB.sigForm), sent.
onFormSubmit = async(function(tid, event, meta)
    if event ~= 'cb|sig' then return end
    local ok, decoded = pcall(json.decode, tostring(meta or ''))
    local data = (ok and type(decoded) == 'table' and type(decoded.data) == 'table') and decoded.data or {}
    local function field(key)
        local value = data[key]
        if type(value) == 'table' then value = value[1] end
        return type(value) == 'string' and value or ''
    end
    local b, at = CB.findFight(tid, true)
    if not b or b.phase ~= 'sig' then return end
    local draft = b.sigDraft or {}
    local raw = CB.formCard(field)
    local card, note = CB.handCard(raw)
    b.anim, b.n = nil, (b.n or 0) + 1
    b.sigDraft = { hand = true, raw = raw, card = card or draft.card, note = note, form = (card == nil) or nil }
    CB.saveFight(tid, at, b)
    reloadChat(tid, getChatLength(tid) - 1)
end)
