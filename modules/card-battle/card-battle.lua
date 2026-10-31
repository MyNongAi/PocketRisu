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

local CB = {}
CB.VERSION = '0.6.0'

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

function CB.effectText(card)
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

-- What the card window explains when a card with these is lifted.
CB.KEYWORD_HELP = {
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
    for _, key in ipairs({ 'poison', 'thorns', 'armor', 'dex', 'pierce', 'drain', 'retain', 'exhaust' }) do
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
    if not CB.hasEffect(fx) or CB.points(fx) > CB.budget(cost, rarity, fx) then return nil end
    return { name = name, cost = cost, fx = fx, rarity = rarity, desc = CB.clip(CB.trim(raw.desc), 60) }
end

--- What a card keeps through cleanCard, which only knows effects: whether it
--- is the signature card, and the face of the enemy it was taken from.
function CB.keepTags(card, from)
    if not card or type(from) ~= 'table' then return card end
    card.sig = from.sig == true or nil
    card.foe = from.foe == true or nil
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
    },
    epic = {
        { name = '결전', cost = 2, fx = { dmg = 18, vuln = 2 }, desc = '모든 것을 건 일격.' },
        { name = '각성', cost = 1, fx = { energy = 1, draw = 2 }, desc = '시야가 맑아진다.' },
        { name = '불굴', cost = 2, fx = { block = 14, str = 1 }, desc = '쓰러지지 않는다.' },
        { name = '최후의 일격', cost = 1, fx = { dmg = 22, exhaust = 1 }, desc = '두 번은 없다.' },
        { name = '날렵한 몸놀림', cost = 1, fx = { dex = 2 }, desc = '흘려 넘기는 법을 안다.' },
        { name = '반격의 가시', cost = 2, fx = { thorns = 4, block = 10 }, desc = '막는 순간이 곧 반격이다.' },
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
        local what = ''
        if slot.sig then
            what = 'the signature card of this story, the one move that most belongs to it (the player\'s own skill, weapon or power, or what the story\'s main character does for them); '
        elseif slot.foe then
            what = string.format('the enemy just beaten, "%s", turned into a card the player can now use: its own signature move (in the fight it did: %s); ',
                slot.foe.name, slot.foe.moves or '')
        end
        lines[i] = string.format('card %d: %srarity %s, cost %d, about %d points', i, what, slot.rarity, slot.cost,
            math.floor(CB.budget(slot.cost, slot.rarity) / CB.SLACK))
    end
    return table.concat(lines, '\n')
end

CB.CARD_RULES = table.concat({
    'Each card is JSON: {"name": short name in the story\'s language (12 characters at most), "effects": {...}, "desc": one short line of flavour}.',
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
        if slot.foe then card.name, card.glyph, card.foe = CB.clip(slot.foe.name, 14), slot.foe.glyph, true end
        if slot.sig then card.sig = true end
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

--- An enemy's move as card effects: what it did to the player, the card
--- does to the enemy.
function CB.moveEffects(move)
    return { dmg = move.atk, hits = (move.n or 1) > 1 and move.n or nil, block = move.def, str = move.str,
        weak = move.weak, vuln = move.vuln, poison = move.poison, thorns = move.thorns }
end

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
        list[#list + 1] = table.concat(parts, ' + ')
    end
    return table.concat(list, '; ')
end

--- A beaten enemy as a card the module makes itself: its strongest move,
--- named after it, with its face.
function CB.foeCard(name, tier, moves)
    local best, worth = nil, -1
    for _, move in ipairs(moves or {}) do
        local fx = CB.moveEffects(move)
        local w = CB.points(fx)
        if w > worth then best, worth = fx, w end
    end
    local card = CB.cleanCard({ name = name, effects = best or { dmg = 6 }, desc = '쓰러뜨린 적이 이제 내 편에서 싸운다.' },
        { rarity = CB.FOE_RARITY[tier] or 'common', cost = 1 })
    if not card then return nil end
    card.foe, card.glyph = true, CB.foeGlyph(name, tier)
    return card
end

--- A card as the signature form holds it.
function CB.rawCard(card)
    return { name = card.name, cost = card.cost, effects = CB.copy(card.fx or {}), desc = card.desc }
end

-- What the signature form calls each effect, in its menus.
CB.EFFECT_LABEL = {
    dmg = '피해', hits = '타수 (피해 횟수)', block = '방어', weak = '약화', vuln = '취약', str = '힘', draw = '카드 뽑기',
    energy = '에너지', heal = '회복', poison = '독', thorns = '가시', armor = '매 턴 방어', dex = '민첩',
    charge = '다음 턴 에너지', prepare = '다음 턴 카드', hpCost = '체력 소모',
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
    return raw
end

--- The signature card made by hand (a rare card), and what the module had
--- to change so it fits; nil and why when nothing usable is left.
function CB.handCard(raw)
    local card = CB.cleanCard(raw, { rarity = 'rare', cost = raw.cost })
    if not card then return nil, '이름과 피해·방어 같은 효과가 하나는 있어야 합니다.' end
    card.sig = true
    local notes = {}
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

-- Each enemy repeats its moves in order, from a random first one. A move
-- may defend (def), attack (atk, n times), grow stronger (str) and weaken
-- (weak) or expose (vuln) the player. The numbers grow with the level.
CB.ENEMIES = {
    normal = {
        { name = '적', hp = 42, moves = { { atk = 7 }, { atk = 4, n = 2 }, { def = 6, atk = 5 } } },
        { name = '적', hp = 46, moves = { { def = 8 }, { atk = 9 }, { weak = 2, atk = 4 } } },
        { name = '적', hp = 38, moves = { { str = 2 }, { atk = 6 }, { atk = 6 } } },
        { name = '적', hp = 40, moves = { { poison = 3 }, { atk = 6 }, { atk = 5, poison = 1 } } },
    },
    elite = {
        { name = '강적', hp = 72, moves = { { atk = 12 }, { atk = 5, n = 3 }, { str = 3, def = 8 }, { vuln = 2, atk = 6 } } },
        { name = '강적', hp = 80, moves = { { def = 12, atk = 6 }, { atk = 15 }, { weak = 2, vuln = 1 } } },
        { name = '강적', hp = 76, moves = { { thorns = 3, def = 10 }, { atk = 11 }, { atk = 4, n = 3 } } },
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
-- How long the scenes stay (a share of CB.HOLD), and who makes the
-- signature card.
CB.PACES = { [0] = 1, [1] = 0.55, [2] = 0 }
CB.SIG_MAKERS = { [0] = 'ai', [1] = 'hand', [2] = 'none' }

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
        sig = CB.SIG_MAKERS[choice(tid, 'sig')] or 'ai',        -- AI가 만들기, 직접 만들기, 없음
        capture = choice(tid, 'capture') == 0,                  -- 받을지 고르기, 안 받기
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
        if checked then cards[#cards + 1] = checked end
    end
    local draw = {}
    for i = 1, #cards do draw[i] = i end
    CB.shuffle(rng, draw)
    local b = {
        id = spec.id, level = run.level, perTurn = settings.perTurn or nil, told = 0,
        name = (spec.name and spec.name ~= '') and spec.name or template.name,
        tier = tier, phase = 'fight', open = true, turn = 1,
        energy = 3, maxEnergy = 3,
        cards = cards, draw = draw, hand = {}, discard = {},
        hp = run.hp, maxHp = run.maxHp, block = 0, str = 0, weak = 0, vuln = 0,
        poison = 0, thorns = 0, armor = 0, dex = 0, nextEnergy = 0, nextDraw = 0, exhausted = {},
        enemy = {
            hp = hp, maxHp = hp, block = 0, str = 0, weak = 0, vuln = 0, poison = 0, thorns = 0,
            moves = CB.copy(template.moves), step = CB.rand(rng, #template.moves), bonus = run.level - 1,
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

--- Play hand card k. False (with a note) when it cannot be played.
function CB.play(b, k)
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
    -- The card flies to the enemy when it attacks, else rises from the player.
    local anim = { cast = id, castAt = fx.dmg and 'foe' or 'me', enemyFrom = e.hp, playerFrom = b.hp }
    local paid = 0
    if fx.hpCost then
        -- It never takes the last hit point.
        paid = math.max(0, math.min(fx.hpCost, b.hp - 1))
        b.hp = b.hp - paid
        parts[#parts + 1] = '체력 -' .. paid
    end
    local healed, pricked = 0, 0
    if fx.dmg then
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
    if fx.exhaust then
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

--- The enemy's move: defend, attack, then grow or weaken. Returns its log
--- text, when it attacked what got through and what was blocked, and what
--- the player's thorns gave back.
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
    e.step = e.step % #e.moves + 1
    return table.concat(parts, ', '), lostTotal, blockedTotal, prickedTotal
end

-- A turn of weak or vulnerable is spent at the end of the turn it counts in:
-- the player's weak and the enemy's vulnerable on the player's turn, the
-- enemy's weak and the player's vulnerable on the enemy's (vulnerable the
-- enemy put on the player this turn waits for its next one). Poison takes
-- its due at the start of its bearer's turn; armor is block for the enemy's.
--
-- How long each scene stays on screen (ms, before the pace setting): the
-- enemy's turn coming, its move, a scene that ends the fight.
CB.HOLD = { foe = 950, act = 900, over = 1000 }

--- The player's turn ends; the enemy's comes, then the player's next. It
--- goes in three scenes: the hand goes and the enemy's poison bites, the
--- enemy moves, the new hand comes. scene(n, anim, hold) is called at each
--- with what it animates and how long it wants on screen; a scene that ends
--- the fight is the last.
function CB.turnScenes(b, scene)
    local kept, tossed = {}, {}
    for _, id in ipairs(b.hand) do
        local card = b.cards[id]
        if card and (card.fx or {}).retain then
            kept[#kept + 1] = id
        else
            b.discard[#b.discard + 1] = id
            tossed[#tossed + 1] = id
        end
    end
    b.hand, b.selected = kept, nil
    local armored = (b.armor or 0) > 0
    if armored then b.block = b.block + b.armor end
    if b.weak > 0 then b.weak = b.weak - 1 end
    if b.enemy.vuln > 0 then b.enemy.vuln = b.enemy.vuln - 1 end
    local e = b.enemy
    e.block = 0
    local mine = #b.played > 0 and table.concat(b.played, ', ') or '카드 없음'
    b.played = {}

    local first = { banner = 'foe', foeTurn = true, toss = tossed, playerBlock = armored and 'pop' or nil }
    local before = e.hp
    local poisoned = CB.tickPoison(e)
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
    local acted, lost, blocked, pricked = CB.enemyAct(b)
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
    if e.weak > 0 then e.weak = e.weak - 1 end
    if b.vulnFresh then b.vulnFresh = nil elseif b.vuln > 0 then b.vuln = b.vuln - 1 end
    b.log[#b.log + 1] = b.turn .. '턴: ' .. mine .. ' / 적: ' .. acted
    b.note = '적: ' .. acted
    if b.hp <= 0 then
        b.phase = 'lost'
    elseif e.hp <= 0 then
        b.phase = 'won'
    end
    if b.phase ~= 'fight' then return scene(2, second, CB.HOLD.over) end
    scene(2, second, CB.HOLD.act + 280 * ((second.lunge or 1) - 1))

    b.turn = b.turn + 1
    b.block = 0
    local third = { banner = 'mine', deal = true, refill = true }
    local hpBefore = b.hp
    local hurt = CB.tickPoison(b)
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
            .. 'Answer with a JSON array of exactly ' .. #slots .. ' cards and nothing else.\n' .. CB.CARD_RULES },
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
        .. 'as a JSON array between <cards> and </cards>; it is hidden from the reader.\n' .. CB.CARD_RULES
        .. '\n' .. CB.slotText(reward.slots) .. '\nCards the player already has: ' .. tostring(reward.deck or '')
end

------------------------------------------------------------------------------
-- The request
------------------------------------------------------------------------------

function CB.instruction(b, settings, user)
    local lines = {
        '[Card Battle] Fights in this story are played as a card game outside the text. When ' .. user .. ' is about to fight (an enemy attacks, a duel is accepted, combat cannot be avoided), stop the reply at the moment the fight begins and end it with one tag on its own line:',
        '<battle tier="normal" name="enemy name">',
        'tier is normal for common foes, elite for strong ones, boss for a major one; name in the story\'s language. Do not narrate the fight itself.',
        'A <battle-turn> block is a turn of a fight the player just played: tell that turn as story, the moves and hits as the block has them, keep every number, and stop as the next turn begins. Never finish the fight yourself and never tell turns that have not been played.',
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
@media (prefers-reduced-motion:reduce){.cbx-in,.cbx-intent,.cbx-deal,.cbx-shake,.cbx-float,.cbx-title,.cbx-pulse,.cbx-lunge,.cbx-act,.cbx-quake,.cbx-pop,.cbx-reveal{animation:none}.cbx-ghost,.cbx-ghostme,.cbx-slashw,.cbx-impact,.cbx-flash,.cbx-banner,.cbx-burst,.cbx-bub,.cbx-ring,.cbx-aura,.cbx-trail,.cbx-break,.cbx-toss,.cbx-drift{display:none}}
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

function CB.cardType(card)
    local fx = card.fx or {}
    if fx.dmg then return 'atk' end
    if (fx.str or fx.dex or fx.thorns or fx.armor or fx.energy or fx.charge) and not fx.block and not fx.heal then return 'pow' end
    return 'skl'
end

function CB.cardIcon(card)
    local fx = card.fx or {}
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

--- One card face. scale: 1 in the hand, larger on the reward screen. The
--- signature card has a gold frame; a beaten enemy's card shows its face.
function CB.cardFace(card, scale, poor)
    scale = scale or 1
    local rarity = card.sig and '#ffd56b' or (CB.RARITY_COLOR[card.rarity] or CB.RARITY_COLOR.basic)
    return '<div class="cbx-card cbx-' .. CB.cardType(card) .. (card.sig and ' cbx-sigcard' or '') .. (poor and ' cbx-poor' or '') .. '" style="width:' .. px(84 * scale) .. ';height:' .. px(120 * scale) .. '">'
        .. '<div class="cbx-cost">' .. card.cost .. '</div>'
        .. (card.sig and '<div class="cbx-badge">대표</div>' or '')
        .. '<div class="cbx-inner" style="border-color:' .. rarity .. '">'
        .. '<div class="cbx-art" style="height:' .. px(42 * scale) .. ';font-size:' .. px(22 * scale) .. '">' .. escapeHtml(card.glyph or CB.cardIcon(card)) .. '</div>'
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
    return '<' .. tag .. '><style>' .. CB.CSS .. '</style>'
        .. '<div class="cbx-root" style="position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:10px;box-sizing:border-box;font-size:14px;line-height:1.35;background:rgba(6,4,10,.88)">'
        .. '<div class="cbx-panel' .. ((anim or {}).open and ' cbx-in' or '') .. (extraClass and (' ' .. extraClass) or '') .. '" style="width:100%;max-width:420px;max-height:100%;overflow-y:auto;overflow-x:hidden;padding:12px;box-sizing:border-box;text-align:left;color:#f1e6cf">'
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
        badge = '<div class="cbx-block' .. (fx.block == 'pop' and ' cbx-pop' or '') .. '"' .. at(fx.block == 'pop' and fx.wait) .. '>🛡️' .. block .. '</div>'
    elseif fx.block == 'break' then
        badge = '<div class="cbx-block cbx-break"' .. at(fx.wait) .. '>🛡️' .. burst(5, 'cbx-shard', '', fx.wait) .. '</div>'
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
    return '<div class="cbx-chips">' .. table.concat(parts) .. '</div>'
end

--- The number a hit or a gain shows. kind: nil (damage), 'good' (block) or
--- 'heal'; big makes it a critical one.
local function float(text, kind, wait, big)
    if not text then return '' end
    return '<div class="cbx-float' .. (kind and (' cbx-' .. kind) or '') .. (big and ' cbx-crit' or '') .. '"' .. at(wait) .. '>' .. escapeHtml(text) .. '</div>'
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

-- What a drawing keeps of a scene with 전투 연출 off: 0.5's numbers.
CB.PLAIN_ANIM = { open = true, deal = true, enemy = true, enemyText = true, player = true, playerText = true, heal = true }

--- The fight. fx false draws numbers only, as 0.5 did (전투 연출: 끄기).
function CB.fightView(b, user, fx)
    if fx == nil then fx = true end
    local e, anim = b.enemy, {}
    for key, value in pairs(b.anim or {}) do
        if fx or CB.PLAIN_ANIM[key] then anim[key] = value end
    end
    local foeTurn = anim.foeTurn
    -- Nothing is tapped on the enemy's turn, nor in the blow that ends it.
    local idle = foeTurn or b.phase ~= 'fight'
    -- When things land: after the card's flight, the enemy's lunge or the
    -- turn's banner.
    local foeWait = (anim.castAt == 'foe' and 0.3) or (anim.lunge and 0.2) or (anim.banner == 'foe' and 0.35) or 0
    local meWait = (anim.lunge and 0.2) or (anim.castAt == 'me' and 0.2) or (anim.banner == 'mine' and 0.3) or 0
    local lunge = anim.lunge
    local out = { header('<span class="cbx-turn">⚔️ ' .. b.turn .. '턴</span> · Lv.' .. (b.level or 1),
        '<span risu-btn="cb|deck" class="cbx-ic">🂠 ' .. #b.cards .. '</span><span risu-btn="cb|flee" class="cbx-ic">💨 도망</span>') }

    -- The enemy: slashes and a flash where the card lands, bubbles, sparks,
    -- a ring for a curse, a glow when it grows stronger.
    local medal = { CB.foeGlyph(b.name, b.tier) }
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
    out[#out + 1] = '<div class="cbx-arena cbx-' .. b.tier .. '">'
        .. '<div class="cbx-intentrow"><div class="cbx-intent' .. (foeTurn and ' cbx-act' or '') .. '">' .. CB.intentText(b) .. '</div></div>' .. ghost
        .. '<div class="cbx-foe"><div class="cbx-medalw' .. (lunge and ' cbx-lunge' or '') .. '"'
        .. ((lunge or 1) > 1 and (' style="animation-duration:.36s;animation-iteration-count:' .. lunge .. '"') or '') .. '>'
        .. '<div class="cbx-medal' .. (anim.enemy and ' cbx-shake' or '') .. '"' .. (anim.enemy and at(foeWait) or '') .. '>' .. table.concat(medal) .. '</div></div>'
        .. '<div class="cbx-name">' .. escapeHtml(b.name) .. '<span class="cbx-tier">' .. CB.TIER_LABEL[b.tier] .. '</span></div>'
        .. hpBar(e.hp, e.maxHp, 'cbx-red', e.block, { from = anim.enemyFrom, wait = foeWait, block = anim.enemyBreak and 'break' or anim.enemyBlock })
        .. chips(e) .. '</div></div>'
    out[#out + 1] = '<div class="cbx-note">' .. escapeHtml(b.note or '') .. '</div>'

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
    out[#out + 1] = '<div class="cbx-me' .. (hurt and ' cbx-shake' or '') .. '"' .. meStyle .. '>'
        .. '<div class="cbx-orb' .. (b.energy == 0 and ' cbx-spent' or '') .. (anim.refill and ' cbx-pop' or '') .. '"' .. (anim.refill and at(0.3) or '') .. '>' .. b.energy .. '/' .. b.maxEnergy .. '</div>'
        .. '<div style="flex:1;min-width:0"><div class="cbx-who"><b>' .. escapeHtml(user) .. '</b>' .. chips(b) .. '</div>'
        .. '<div style="margin-top:5px">' .. hpBar(b.hp, b.maxHp, 'cbx-green', b.block, { from = anim.playerFrom, wait = meWait, block = anim.playerBreak and 'break' or anim.playerBlock }) .. '</div></div>'
        .. float(anim.playerText, (not hurt) and (anim.heal and 'heal' or 'good') or nil, meWait, anim.big and lunge) .. table.concat(me) .. '</div>'

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
    out[#out + 1] = '<div style="position:relative;height:160px;margin-top:14px">' .. table.concat(cards) .. '</div>'
    local picked = (not idle) and b.selected and b.cards[b.hand[b.selected]]
    local piles = function(middle)
        return '<div style="display:flex;align-items:center;gap:10px;margin-top:10px">'
            .. '<div class="cbx-pile"><div class="cbx-pilen">' .. #b.draw .. '</div>뽑을 더미</div>' .. middle
            .. '<div class="cbx-pile"><div class="cbx-pilen">' .. #b.discard .. '</div>버린 더미</div></div>'
    end
    if picked then
        local help = CB.keywordHelp(picked)
        out[#out + 1] = '<div class="cbx-detail"><b>' .. escapeHtml(picked.name) .. '</b> — ' .. escapeHtml(CB.effectText(picked))
            .. ((picked.desc or '') ~= '' and ('<br><span class="cbx-flavour">' .. escapeHtml(picked.desc) .. '</span>') or '')
            .. (#help > 0 and ('<br><span style="font-size:11px;opacity:.75">' .. escapeHtml(table.concat(help, ' ')) .. '</span>') or '') .. '</div>'
        out[#out + 1] = '<div style="display:flex;gap:8px;margin-top:8px"><span risu-btn="cb|play|' .. b.selected .. '|' .. (b.n or 0) .. '" class="cbx-btn cbx-gold" style="flex:2">▶ 사용</span>'
            .. '<span risu-btn="cb|unsel" class="cbx-btn cbx-dark" style="flex:1">취소</span></div>'
    elseif idle then
        out[#out + 1] = piles('<div class="cbx-btn cbx-dark cbx-pulse" style="flex:1">' .. (foeTurn and '적의 차례…' or '…') .. '</div>')
    else
        out[#out + 1] = piles('<span risu-btn="cb|end||' .. (b.n or 0) .. '" class="cbx-btn cbx-gold" style="flex:1">턴 종료</span>')
    end

    local overlay = {}
    if anim.flash then overlay[#overlay + 1] = '<div class="cbx-flash"' .. at(0.2) .. '></div>' end
    if anim.banner then
        overlay[#overlay + 1] = '<div class="cbx-banner' .. (anim.banner == 'mine' and ' cbx-mine' or '') .. '">'
            .. (anim.banner == 'mine' and (b.turn .. '턴 · 내 차례') or '적의 차례') .. '</div>'
    end
    return frame(table.concat(out), anim, anim.big and 'cbx-quake' or nil, b.n, table.concat(overlay))
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
    local raw = draft.raw or { name = '', cost = 1, effects = { dmg = 8 }, desc = '' }
    local effects = raw.effects or {}
    local picks = {}
    for _, effect in ipairs(CB.EFFECTS) do
        local value = effects[effect.key]
        if not effect.flag and type(value) == 'number' and #picks < 3 then picks[#picks + 1] = { effect.key, value } end
    end
    local function menu(name, chosen)
        local options = { '<option value=""' .. (chosen and '' or ' selected') .. '>없음</option>' }
        for _, effect in ipairs(CB.EFFECTS) do
            if not effect.flag then
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
    rows[#rows + 1] = '<div class="cbx-row"><span class="cbx-lab">설명</span><input name="cdesc" maxlength="60" class="cbx-field" value="' .. escapeHtml(raw.desc or '') .. '" placeholder="한 줄 설명 (안 써도 됨)"></div>'
    rows[#rows + 1] = '<div class="cbx-hint">비용마다 담을 수 있는 점수 — ' .. table.concat(budget, ' · ') .. '. 피해·방어 1이 1점, 독 2점, 약화·취약·가시 3점, 카드 뽑기 4점, 에너지 5점, 힘·민첩 6점이고, 체력 소모는 점수를 덜어 줍니다. 넘치면 비용이 먼저 오르고, 그래도 넘치면 숫자가 줄어듭니다.</div>'
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
    if b and b.phase == 'pending' then return startCard(b, 'start') end
    -- A tag nobody turned into a fight (written by hand, or the module was
    -- off when the reply came): start it from here. Not in the middle of one.
    if type(text) == 'string' and text:find(CB.TAG_PATTERN) and not (b and (b.phase == 'fight' or b.phase == 'sig')) then
        local _, spec = CB.takeBattleTag(text)
        if spec then return startCard(spec, 'tag') end
    end
    if not b then return '' end
    local user = getPersonaName(tid) or ''
    local fx = CB.settings(tid).pace > 0
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
        local b = { id = spec.id, name = spec.name, tier = spec.tier, phase = 'sig', open = true, n = 0,
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
    lines[#lines + 1] = '지금: ' .. user .. ' 체력 ' .. b.hp .. '/' .. b.maxHp .. ', ' .. b.name .. ' 체력 ' .. b.enemy.hp .. '/' .. b.enemy.maxHp
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
        local card = CB.foeCard(b.name, b.tier, b.enemy.moves)
        if card then foe = { name = card.name, glyph = card.glyph, moves = CB.movesText(b.enemy.moves), card = card } end
    end
    CB.settle(run, b)
    local log = CB.logBlock(run, b, getPersonaName(tid) or '', settings.fullLog)
    -- What the end screen does not need.
    b.cards, b.draw, b.hand, b.discard, b.enemy, b.log, b.played, b.view = nil, nil, nil, nil, nil, nil, nil, nil
    b.awaitStory, b.sigCard, b.anim = nil, nil, nil
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
    local first, drawnIn = rest:match('^([^|]*)|?(.*)$')
    local k, drawing = tonumber(first), tonumber(drawnIn)
    local settings = CB.settings(tid)
    local len = getChatLength(tid)
    local b, at = CB.findFight(tid, true)
    -- Play and 턴 종료 carry the drawing they were tapped in: one left over
    -- from an older drawing (a double tap, taps while the enemy moved)
    -- would play another card or end the next turn.
    if b and drawing and (action == 'play' or action == 'end') and drawing ~= (b.n or 0) then return end
    if b then b.anim, b.n = nil, (b.n or 0) + 1 end
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
            b = CB.newBattle(run, { id = b.id, name = b.name, tier = b.tier }, settings)
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
            b.selected = k
            local card = b.cards[b.hand[k] or 0]
            b.note = (card and card.cost > b.energy) and '에너지가 모자랍니다' or ''
        elseif action == 'unsel' then
            b.selected = nil
        elseif action == 'play' and k then
            CB.play(b, k)
            -- The last blow lands on screen before the end screen comes.
            if b.phase ~= 'fight' and settings.pace > 0 then show(CB.HOLD.over) end
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
