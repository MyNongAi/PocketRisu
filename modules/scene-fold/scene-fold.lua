-- 📁 장면 접기 (Scene Fold)
-- Folds a finished scene (a battle, an NSFW scene, or a kind the user writes)
-- out of what the model is sent and puts a short summary in its place. The
-- chat keeps every message: a scene is marked by hidden markers in the
-- messages themselves, so rerolls and deletes keep the marks in step, and
-- folding only changes the request and how the scene is shown.
--
-- A run of a time-loop story (🔁 회차: one life, until the hero dies and
-- time goes back) folds the same way, as an outer layer: battles inside it
-- fold on their own, and the run folds over them once it is over.
--
-- The module's request-editing regex (build.mjs) takes a folded scene out of
-- each message before long-term memory reads the chat, in every Risu, so
-- memory sees the summary and not the full text. It goes by the marks a fold
-- adds to every message wholly inside the scene.

local SF = {}

------------------------------------------------------------------------------
-- Markers
------------------------------------------------------------------------------

-- Hidden marks in a message: where a scene starts, where it ends, and the
-- messages inside a folded scene. HTML comments, so they stay invisible
-- even where this module's display does not run.
SF.START_PATTERN = '<!%-%-sf:s:(%w+):(%w+)%-%->'
SF.END_PATTERN = '<!%-%-sf:e:(%w+)%-%->'
SF.MEMBER_PATTERN = '<!%-%-sf:m:(%w+)%-%->'
-- The one message a cut scene leaves in the chat ("원문 잘라내기").
SF.CUT_PATTERN = '<!%-%-sf:c:(%w+):(%w+)%-%->'
-- The first message of a folded scene: the request regex puts the summary
-- there, and drops the messages with member marks.
SF.FOLD_PATTERN = '<!%-%-sf:f:(%w+):(%w+)%-%->'
SF.ANY_PATTERN = '\n?<!%-%-sf:[semcf]:[%w:]+%-%->'

function SF.startMark(kind, id) return '<!--sf:s:' .. kind .. ':' .. id .. '-->' end
function SF.endMark(id) return '<!--sf:e:' .. id .. '-->' end
function SF.memberMark(id) return '<!--sf:m:' .. id .. '-->' end
function SF.cutMark(kind, id) return '<!--sf:c:' .. kind .. ':' .. id .. '-->' end
function SF.foldMark(kind, id) return '<!--sf:f:' .. kind .. ':' .. id .. '-->' end

-- The tokens the main model writes in its anchor mode.
local function caseless(word)
    return (word:gsub('%a', function(c) return '[' .. c:upper() .. c:lower() .. ']' end))
end
SF.TOKEN_START_PATTERN = '%[%[%s*' .. caseless('scene') .. '%s+' .. caseless('start') .. '%s*:?%s*([%a_]*)%s*%]%]'
SF.TOKEN_END_PATTERN = '%[%[%s*' .. caseless('scene') .. '%s+' .. caseless('end') .. '%s*%]%]'
SF.TOKEN_ANY_PATTERN = '%[%[%s*' .. caseless('scene') .. '%s+%a+[^%]]*%]%]'
-- The hero died and time went back (the 🔁 회차 kind).
SF.TOKEN_LOOP_PATTERN = '%[%[%s*' .. caseless('loop') .. '%s+' .. caseless('end') .. '%s*%]%]'

function SF.trim(s)
    return (tostring(s or ''):gsub('^%s+', ''):gsub('%s+$', ''))
end

--- The message text without any of this module's marks or tokens.
function SF.strip(text)
    if type(text) ~= 'string' then return text end
    local out = text:gsub(SF.ANY_PATTERN, ''):gsub('\n?' .. SF.TOKEN_ANY_PATTERN, ''):gsub('\n?' .. SF.TOKEN_LOOP_PATTERN, '')
    return out
end

--- Every scene id a message is marked with (start, end, member or fold).
function SF.markedIds(text)
    local ids = {}
    if type(text) ~= 'string' then return ids end
    for _, id in text:gmatch(SF.START_PATTERN) do ids[id] = true end
    for id in text:gmatch(SF.END_PATTERN) do ids[id] = true end
    for id in text:gmatch(SF.MEMBER_PATTERN) do ids[id] = true end
    for _, id in text:gmatch(SF.FOLD_PATTERN) do ids[id] = true end
    return ids
end

--- The scenes in a chat, in order: { id, kind, s, e } with 1-based message
--- positions; e is nil while the scene is still open. A mark whose partner
--- is gone (its message rerolled away) leaves the scene open or unused.
function SF.scenes(messages)
    local list, byId, open = {}, {}, {}
    for i, message in ipairs(messages or {}) do
        local text = type(message) == 'table' and message.data or ''
        if type(text) == 'string' then
            for kind, id in text:gmatch(SF.START_PATTERN) do
                if not byId[id] then
                    local scene = { id = id, kind = kind, s = i }
                    byId[id] = scene
                    open[id] = scene
                    list[#list + 1] = scene
                end
            end
            for id in text:gmatch(SF.END_PATTERN) do
                local scene = open[id]
                if scene then
                    scene.e = i
                    open[id] = nil
                end
            end
        end
    end
    return list, byId
end

--- The open scene (the latest one when several are), or nil. A run is not
--- one: it is marked only once it is over.
function SF.openScene(scenes)
    for i = #scenes, 1, -1 do
        if not scenes[i].e and scenes[i].kind ~= 'loop' then return scenes[i] end
    end
    return nil
end

--- Replies by the character after position `index`.
function SF.repliesAfter(messages, index)
    local count = 0
    for i = index + 1, #messages do
        if messages[i] and messages[i].role ~= 'user' then count = count + 1 end
    end
    return count
end

--- Whether a closed scene has waited its grace replies.
function SF.graceDone(messages, scene, grace)
    return scene.e ~= nil and SF.repliesAfter(messages, scene.e) >= grace
end

--- The runs that are over, in order: { id, s, e }. A run cut from the chat
--- (원문 잘라내기) is its one summary message.
function SF.runs(messages, scenes)
    local list = {}
    for _, scene in ipairs(scenes) do
        if scene.kind == 'loop' and scene.e then list[#list + 1] = { id = scene.id, s = scene.s, e = scene.e } end
    end
    for i, message in ipairs(messages or {}) do
        local text = type(message) == 'table' and message.data or ''
        local kind, id = (type(text) == 'string' and text or ''):match(SF.CUT_PATTERN)
        if kind == 'loop' then list[#list + 1] = { id = id, s = i, e = i } end
    end
    table.sort(list, function(a, b) return a.s < b.s end)
    return list
end

--- Where the current run began: the message after the last run's end, or the first one.
function SF.runStart(messages, scenes)
    local from = 1
    for _, run in ipairs(SF.runs(messages, scenes)) do
        if run.e + 1 > from then from = run.e + 1 end
    end
    return from
end

--- Each run's number (1 for the first), by scene id.
function SF.runNumbers(messages, scenes)
    local numbers = {}
    for k, run in ipairs(SF.runs(messages, scenes)) do numbers[run.id] = k end
    return numbers
end

--- Inner scenes first, then the runs over them.
function SF.foldOrder(scenes)
    local order = {}
    for _, scene in ipairs(scenes) do if scene.kind ~= 'loop' then order[#order + 1] = scene end end
    for _, scene in ipairs(scenes) do if scene.kind == 'loop' then order[#order + 1] = scene end end
    return order
end

------------------------------------------------------------------------------
-- Settings (the module's toggle menu)
------------------------------------------------------------------------------

-- A select stores its option index; an unset one reads as its first option,
-- so each select lists its default first.
local function option(tid, key)
    local value = getGlobalVar(tid, 'toggle_scenefold.' .. key)
    if value == nil or value == 'null' then return '' end
    return tostring(value)
end

local function choice(tid, key)
    return tonumber(option(tid, key)) or 0
end

SF.GRACE_BY_CHOICE = { [0] = 2, [1] = 0, [2] = 1, [3] = 3, [4] = 4, [5] = 6 }

SF.KIND_LABEL = { battle = '⚔️ 배틀', nsfw = '🔞 NSFW', custom = '✏️ 사용자 정의', loop = '🔁 회차', scene = '📄 장면' }

function SF.settings(tid)
    local customName = SF.trim(option(tid, 'customName'))
    -- 요청에서 빼기, 원문 잘라내기 (비권장), 요청에서만 접기
    local handling = choice(tid, 'cut')
    return {
        battle = choice(tid, 'battle') == 0,   -- 켬, 끔
        nsfw = choice(tid, 'nsfw') == 1,       -- 끔, 켬
        custom = choice(tid, 'custom') == 1,   -- 끔, 켬
        customName = customName ~= '' and customName or '사용자 정의',
        customRule = SF.trim(option(tid, 'customRule')),
        loop = choice(tid, 'loop') == 1,       -- 끔, 켬
        hero = SF.trim(option(tid, 'loopHero')),
        mainAnchors = choice(tid, 'mode') == 1,       -- 보조 모델이 판단, 메인 모델이 표시
        grace = SF.GRACE_BY_CHOICE[choice(tid, 'grace')] or 2,
        mainSummary = choice(tid, 'summary') == 1,    -- 보조 모델, 메인 모델
        buttons = choice(tid, 'buttons') == 0,        -- 보이기, 숨기기
        cut = handling == 1,
        -- The request regex takes folded scenes out before long-term memory
        -- reads the chat (build.mjs reads the same toggle).
        early = handling ~= 2,
    }
end

function SF.enabledKinds(settings)
    local kinds = {}
    if settings.battle then kinds[#kinds + 1] = 'battle' end
    if settings.nsfw then kinds[#kinds + 1] = 'nsfw' end
    if settings.custom and settings.customRule ~= '' then kinds[#kinds + 1] = 'custom' end
    return kinds
end

function SF.kindLabel(kind, settings, number)
    if kind == 'custom' and settings then return '✏️ ' .. settings.customName end
    if kind == 'loop' and number then return '🔁 ' .. number .. '회차' end
    return SF.KIND_LABEL[kind] or SF.KIND_LABEL.scene
end

--- Who loops, in the prompts.
function SF.hero(settings)
    if settings and settings.hero and settings.hero ~= '' then return settings.hero end
    return 'the protagonist'
end

------------------------------------------------------------------------------
-- What counts as each kind, and what its summary keeps
------------------------------------------------------------------------------

SF.KIND_RULE = {
    battle = 'any contest with a start and an outcome: fights and duels of any kind (Pokémon battles included), dungeon, gate, raid or exploration runs, training bouts and sparring, minigames, board or card games, poker and gambling',
    nsfw = 'a sexual (NSFW) scene',
}

SF.KIND_KEEP = {
    battle = 'who took part and why; how it went in a line or two; the result (winner and loser, cleared or failed, how it ended); injuries, faints, knockouts or deaths; items, money, loot, rewards or captures gained or lost; level, skill or stat changes; promises, debts or lines that later scenes should remember (quote briefly)',
    nsfw = 'who was involved; how their relationship and feelings changed; promises, consequences and anything later scenes should remember; no explicit detail',
    scene = 'what happened in a few lines, its outcome, and anything later scenes should remember',
}

function SF.kindRule(kind, settings)
    if kind == 'custom' then return settings.customRule end
    return SF.KIND_RULE[kind]
end

function SF.kindKeep(kind, settings)
    if kind == 'custom' then return settings.customRule end
    return SF.KIND_KEEP[kind] or SF.KIND_KEEP.scene
end

function SF.loopRule(settings)
    return SF.hero(settings) .. ' dies (or is otherwise sent back) and time goes back to an earlier point, so the story starts over from there'
end

function SF.loopKeep(settings)
    local hero = SF.hero(settings)
    return 'the key events of this run in order, briefly; what ' .. hero .. ' learned that matters next time (clues, who is hostile or can be trusted, conditions and timings); what ' .. hero .. ' tried against the crisis and whether it worked: compared with the earlier runs, what is now solved and how, and what is still unsolved; how, where and by whom ' .. hero .. ' died'
end

------------------------------------------------------------------------------
-- Asking the auxiliary model whether a scene starts or ends
------------------------------------------------------------------------------

local MAX_LINE = 2500

local function clip(text, limit)
    text = SF.strip(text or '')
    if #text <= limit then return text end
    return text:sub(1, limit) .. ' …'
end

--- The judge's question about the latest reply. `withLoop` adds whether the
--- hero died and time went back (the 🔁 회차 kind).
function SF.judgePrompt(messages, open, settings, kinds, withLoop)
    local lines = {}
    if #kinds > 0 then
        lines[#lines + 1] = 'Scene kinds to watch:'
        for _, kind in ipairs(kinds) do
            local name = kind == 'custom' and ('custom (' .. settings.customName .. ')') or kind
            lines[#lines + 1] = '- ' .. name .. ': ' .. SF.kindRule(kind, settings)
        end
        if open then
            lines[#lines + 1] = 'Open scene: ' .. open.kind .. ' (since ' .. SF.repliesAfter(messages, open.s - 1) .. ' replies)'
        else
            lines[#lines + 1] = 'Open scene: none'
        end
    end
    if withLoop then
        lines[#lines + 1] = 'Time loop: ' .. SF.loopRule(settings) .. '.'
    end
    lines[#lines + 1] = ''
    lines[#lines + 1] = 'Recent log (oldest first):'
    local from = math.max(1, #messages - 2)
    for i = from, #messages do
        local message = messages[i]
        local who = message.role == 'user' and 'user' or 'character'
        local tag = i == #messages and ' (LATEST)' or ''
        lines[#lines + 1] = '[' .. who .. tag .. '] ' .. clip(message.data, MAX_LINE)
    end
    lines[#lines + 1] = ''
    local fields = {}
    if #kinds > 0 then
        lines[#lines + 1] = 'For the LATEST character reply only: does a watched scene start in it, end in it (its outcome is decided or it clearly stops), or both (it starts and is already over within it)? With an open scene, answer "end" or "none".'
        fields[#fields + 1] = '"event":"none|start|end|both","kind":"' .. table.concat(kinds, '|') .. '"'
    end
    if withLoop then
        lines[#lines + 1] = 'Does ' .. SF.hero(settings) .. ' die and time go back in the LATEST reply? "loop" is true only then.'
        fields[#fields + 1] = '"loop":false'
    end
    lines[#lines + 1] = 'Answer with one line of JSON and nothing else: {' .. table.concat(fields, ',') .. '}'
    return {
        { role = 'system', content = 'You label scenes in a role-play log. You only answer with the requested JSON.' },
        { role = 'user', content = table.concat(lines, '\n') },
    }
end

--- The event, kind and loop flag in a judge answer; event 'none' when it cannot be read.
function SF.parseJudge(answer)
    if type(answer) ~= 'string' then return 'none', nil, false end
    local event = answer:match('"event"%s*:%s*"(%a+)"')
    local kind = answer:match('"kind"%s*:%s*"([%a_]+)"')
    local loop = answer:match('"loop"%s*:%s*true') ~= nil
    event = event and event:lower() or 'none'
    if event ~= 'start' and event ~= 'end' and event ~= 'both' then event = 'none' end
    return event, kind and kind:lower() or nil, loop
end

local function contains(list, value)
    for _, item in ipairs(list) do if item == value then return true end end
    return false
end

local function newId()
    return string.format('%04x%04x', math.random(0, 0xffff), math.random(0, 0xffff))
end

--- The marks to add to the latest reply for a judge event.
function SF.marksForEvent(event, kind, open, kinds)
    if open then
        if event == 'end' or event == 'both' then return SF.endMark(open.id) end
        return ''
    end
    if not kind or not contains(kinds, kind) then return '' end
    local id = newId()
    if event == 'start' then return SF.startMark(kind, id) end
    if event == 'both' then return SF.startMark(kind, id) .. SF.endMark(id) end
    return ''
end

--- The reply with the main model's visible tokens turned into hidden marks,
--- and whether it wrote that the hero died and time went back.
function SF.convertTokens(text, open, kinds)
    local marks = ''
    local current = open
    local died = text:find(SF.TOKEN_LOOP_PATTERN) ~= nil
    local cleaned = text:gsub('\n?' .. SF.TOKEN_LOOP_PATTERN, ''):gsub('\n?' .. SF.TOKEN_ANY_PATTERN, function(token)
        local kind = token:match(SF.TOKEN_START_PATTERN)
        if kind ~= nil then
            kind = kind:lower()
            if not current and contains(kinds, kind) then
                local id = newId()
                current = { id = id, kind = kind }
                marks = marks .. SF.startMark(kind, id)
            end
        elseif token:match(SF.TOKEN_END_PATTERN) and current then
            marks = marks .. SF.endMark(current.id)
            current = nil
        end
        return ''
    end)
    return cleaned, marks, died
end

------------------------------------------------------------------------------
-- Summaries
------------------------------------------------------------------------------

local MAX_SCENE = 24000

function SF.sceneLog(messages, scene)
    local parts = {}
    for i = scene.s, scene.e do
        local message = messages[i]
        if message then
            local who = message.role == 'user' and 'user' or 'character'
            parts[#parts + 1] = '[' .. who .. '] ' .. SF.strip(message.data or '')
        end
    end
    local log = table.concat(parts, '\n\n')
    if #log > MAX_SCENE then
        local half = math.floor(MAX_SCENE / 2)
        log = log:sub(1, half) .. '\n\n[…]\n\n' .. log:sub(#log - half)
    end
    return log
end

function SF.summaryPrompt(messages, scene, settings)
    local keep = SF.kindKeep(scene.kind, settings)
    return {
        { role = 'system', content = 'You compress a finished role-play scene into a short record that stands in for the scene from now on. Write in the same language as the log. Plain lines, no headings, no commentary.' },
        { role = 'user', content = 'Scene kind: ' .. scene.kind .. '\nKeep: ' .. keep .. '\nWrite 3 to 8 short lines.\n\nScene log:\n' .. SF.sceneLog(messages, scene) },
    }
end

--- What the request carries in place of a folded scene.
function SF.summaryBlock(kind, text, settings, number)
    if kind == 'loop' then
        local hero = SF.hero(settings)
        return '[Undone run' .. (number and (' ' .. number) or '') .. ' · only ' .. hero .. ' remembers] ' .. hero .. ' died and time went back: for everyone else none of this happened. What ' .. hero .. ' lived through and remembers:\n' .. text
    end
    return '[Folded scene · ' .. (kind == 'custom' and settings and settings.customName or kind) .. '] The full text of this finished scene was left out; this is what happened:\n' .. text
end

-- A run longer than this is noted part by part, then recorded from the notes.
SF.RUN_PART = 40000

function SF.runPrompt(log, number, earlier, settings, fromNotes)
    local hero = SF.hero(settings)
    local user = 'This is run ' .. number .. ' of a time-loop story: one life of ' .. hero .. ', from where it began until ' .. hero .. ' died and time went back. Only ' .. hero .. ' remembers it.\n'
    if earlier ~= '' then user = user .. '\nEarlier runs, already recorded:\n' .. earlier .. '\n' end
    user = user .. '\nWrite 6 to 14 short lines. Keep: ' .. SF.loopKeep(settings) .. '\n\n' .. (fromNotes and 'Notes on this run, part by part:\n' or 'Run log:\n') .. log
    return {
        { role = 'system', content = 'You keep the record of a time-loop role-play. Write in the same language as the log. Plain lines, no headings, no commentary.' },
        { role = 'user', content = user },
    }
end

function SF.partPrompt(part, k, count, settings)
    return {
        { role = 'system', content = 'You take notes on a long role-play log. Write in the same language as the log. Plain lines, no headings, no commentary.' },
        { role = 'user', content = 'Part ' .. k .. ' of ' .. count .. ' of one run of a time-loop story. In 5 to 12 short lines, note what happens in this part and anything that matters later: clues, who is hostile or can be trusted, what ' .. SF.hero(settings) .. ' tries and how it goes.\n\nLog:\n' .. part },
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

function SF.summaryOf(tid, id)
    local value = stateGet(tid, 'sf_sum_' .. id)
    if type(value) == 'string' and value ~= '' then return value end
    return nil
end

local function bumpVersion(tid)
    local version = tonumber(stateGet(tid, 'sf_ver')) or 0
    setState(tid, 'sf_ver', version + 1)
end

-- An LLM answer's text, or nil (no low-level access, a failed request).
local function ask(tid, prompt, useMain)
    local ok, response = pcall(function()
        if useMain then return LLM(tid, prompt) end
        return axLLM(tid, prompt)
    end)
    if not ok or type(response) ~= 'table' or not response.success then return nil end
    local text = SF.trim(response.result)
    if text == '' then return nil end
    return text
end

local function setMessage(tid, index, text)
    setChat(tid, index - 1, text)
end

local function appendMarks(tid, messages, index, marks)
    if marks == '' then return end
    local text = messages[index].data or ''
    text = text .. '\n' .. marks
    messages[index].data = text
    setMessage(tid, index, text)
end

--- The hero died in reply `index`: the run from its start to there closes,
--- and so does a scene still open. False when that message already belongs
--- to an earlier run.
local function endRun(tid, messages, index)
    local scenes = SF.scenes(messages)
    local from = SF.runStart(messages, scenes)
    if from > index then return false end
    local open = SF.openScene(scenes)
    local marks = ''
    if open and open.s <= index then marks = SF.endMark(open.id) end
    local id = newId()
    if from == index then
        marks = marks .. SF.startMark('loop', id) .. SF.endMark(id)
    else
        appendMarks(tid, messages, from, SF.startMark('loop', id))
        marks = marks .. SF.endMark(id)
    end
    appendMarks(tid, messages, index, marks)
    return true
end

--- A run whose end is gone (its death reply rerolled away) is no run: its
--- start mark goes. A run is only ever marked whole, so an open one is that.
local function dropDanglingRuns(tid, messages, scenes)
    local changed = false
    for _, scene in ipairs(scenes) do
        local message = messages[scene.s]
        if scene.kind == 'loop' and not scene.e and message then
            local text = message.data or ''
            local cleaned = text:gsub('\n?<!%-%-sf:s:loop:' .. scene.id .. '%-%->', '')
            if cleaned ~= text then
                message.data = cleaned
                setMessage(tid, scene.s, cleaned)
                changed = true
            end
        end
    end
    return changed
end

------------------------------------------------------------------------------
-- Runs (🔁 회차)
------------------------------------------------------------------------------

--- A run's log, entry by entry: a folded scene inside it as its summary, the rest as written.
function SF.runEntries(tid, messages, run, scenes)
    local inner = {}
    for _, scene in ipairs(scenes) do
        if scene.kind ~= 'loop' and scene.e and scene.s >= run.s and scene.e <= run.e then
            local summary = SF.summaryOf(tid, scene.id)
            if summary then
                for i = scene.s, scene.e do inner[i] = inner[i] or { scene = scene, summary = summary } end
            end
        end
    end
    local entries, placed = {}, {}
    for i = run.s, run.e do
        local message = messages[i]
        local hit = inner[i]
        if hit then
            if not placed[hit.scene.id] then
                placed[hit.scene.id] = true
                entries[#entries + 1] = '[folded ' .. hit.scene.kind .. '] ' .. hit.summary
            end
        elseif message then
            local who = message.role == 'user' and 'user' or 'character'
            entries[#entries + 1] = '[' .. who .. '] ' .. SF.strip(message.data or '')
        end
    end
    return entries
end

--- The records of the runs before `run`, the latest ones kept when they are long.
function SF.earlierRuns(tid, messages, scenes, run)
    local parts = {}
    for number, earlier in ipairs(SF.runs(messages, scenes)) do
        if earlier.e < run.s then
            local summary = SF.summaryOf(tid, earlier.id)
            if summary then parts[#parts + 1] = 'Run ' .. number .. ':\n' .. summary end
        end
    end
    local text = table.concat(parts, '\n\n')
    if #text > 8000 then text = '[…]\n' .. text:sub(#text - 8000) end
    return text
end

function SF.runSummary(tid, messages, run, scenes, settings)
    local entries = SF.runEntries(tid, messages, run, scenes)
    local earlier = SF.earlierRuns(tid, messages, scenes, run)
    local number = SF.runNumbers(messages, scenes)[run.id] or 1
    local log = table.concat(entries, '\n\n')
    if #log <= SF.RUN_PART then
        return ask(tid, SF.runPrompt(log, number, earlier, settings, false), settings.mainSummary)
    end
    local parts, current, size = {}, {}, 0
    for _, entry in ipairs(entries) do
        if #entry > SF.RUN_PART then entry = entry:sub(1, SF.RUN_PART) end
        if size > 0 and size + #entry > SF.RUN_PART then
            parts[#parts + 1] = table.concat(current, '\n\n')
            current, size = {}, 0
        end
        current[#current + 1] = entry
        size = size + #entry + 2
    end
    if #current > 0 then parts[#parts + 1] = table.concat(current, '\n\n') end
    local notes = {}
    for k, part in ipairs(parts) do
        local note = ask(tid, SF.partPrompt(part, k, #parts, settings), settings.mainSummary)
        if not note then return nil end
        notes[#notes + 1] = '(' .. k .. ') ' .. note
    end
    return ask(tid, SF.runPrompt(table.concat(notes, '\n\n'), number, earlier, settings, true), settings.mainSummary)
end

function SF.makeSummary(tid, messages, scene, scenes, settings)
    if scene.kind == 'loop' then return SF.runSummary(tid, messages, scene, scenes, settings) end
    return ask(tid, SF.summaryPrompt(messages, scene, settings), settings.mainSummary)
end

------------------------------------------------------------------------------
-- Folding
------------------------------------------------------------------------------

-- 원문 잘라내기 keeps the cut originals in chat state for 되돌리기; past
-- this size it leaves the scene folded but uncut.
SF.MAX_CUT_CHARS = 300000

--- Replace a folded scene's messages with one summary message, keeping the
--- originals in chat state. False (and nothing cut) when they are too big.
function SF.cutScene(tid, messages, scene, summary)
    local originals, size = {}, 0
    for i = scene.s, scene.e do
        local message = messages[i]
        originals[#originals + 1] = { role = message.role == 'user' and 'user' or 'char', data = message.data or '' }
        size = size + #(message.data or '')
    end
    if size > SF.MAX_CUT_CHARS then
        setState(tid, 'sf_cutskip_' .. scene.id, true)
        return false
    end
    setState(tid, 'sf_cut_' .. scene.id, originals)
    setState(tid, 'sf_cutn_' .. scene.id, #originals)
    for i = scene.e, scene.s, -1 do removeChat(tid, i - 1) end
    insertChat(tid, scene.s - 1, 'char', summary .. '\n' .. SF.cutMark(scene.kind, scene.id))
    return true
end

--- The text the request regex puts in place of a folded scene: a chat
--- variable, so the regex can read it by the scene id. True when it changed.
function SF.setFoldText(tid, scene, summary, settings, number)
    local text = SF.summaryBlock(scene.kind, summary, settings, number)
    local key = 'sf_text_' .. scene.id
    if getChatVar(tid, key) == text then return false end
    setChatVar(tid, key, text)
    return true
end

--- Marks every message wholly inside a folded scene for the request regex:
--- the first gets the fold mark (the summary goes there), the others member
--- marks. A message also in a scene not folded (one ends and the next starts
--- in it) keeps its text. Idempotent; true when something changed.
function SF.markFolded(tid, messages, scene, folded, settings, number)
    local changed = SF.setFoldText(tid, scene, folded[scene.id], settings, number)
    for i = scene.s, scene.e do
        local message = messages[i]
        if message then
            local text = message.data or ''
            local whole = true
            for id in pairs(SF.markedIds(text)) do
                if id ~= scene.id and not folded[id] then whole = false break end
            end
            if whole then
                local mark = i == scene.s and SF.foldMark(scene.kind, scene.id) or SF.memberMark(scene.id)
                if not text:find(mark, 1, true) then
                    appendMarks(tid, messages, i, mark)
                    changed = true
                end
            end
        end
    end
    return changed
end

--- Summarize closed scenes past their grace (one summary per call, inner
--- scenes before the run over them), mark every folded scene for the request
--- regex, and cut one when 원문 잘라내기 is chosen. True when anything changed.
function SF.foldReady(tid, messages, settings)
    local scenes = SF.scenes(messages)
    local order = SF.foldOrder(scenes)
    local folded, asked, changed = {}, false, false
    for _, scene in ipairs(order) do
        if scene.e and SF.graceDone(messages, scene, settings.grace) then
            local summary = SF.summaryOf(tid, scene.id)
            if not summary and not asked then
                asked = true
                summary = SF.makeSummary(tid, messages, scene, scenes, settings)
                setState(tid, 'sf_fail_' .. scene.id, summary == nil)
                if summary then
                    setState(tid, 'sf_sum_' .. scene.id, summary)
                    changed = true
                end
            end
            if summary then folded[scene.id] = summary end
        end
    end
    local numbers = SF.runNumbers(messages, scenes)
    for _, scene in ipairs(order) do
        if folded[scene.id] and SF.markFolded(tid, messages, scene, folded, settings, numbers[scene.id]) then changed = true end
    end
    if settings.cut then
        for _, scene in ipairs(order) do
            if folded[scene.id] and stateGet(tid, 'sf_nocut_' .. scene.id) ~= true and stateGet(tid, 'sf_cutskip_' .. scene.id) ~= true then
                -- One cut per call: the positions after it move.
                if SF.cutScene(tid, messages, scene, folded[scene.id]) then return true end
            end
        end
    end
    return changed
end

------------------------------------------------------------------------------
-- After each reply
------------------------------------------------------------------------------

SF.LONG_OPEN = 12

onOutput = async(function(tid)
    local settings = SF.settings(tid)
    local kinds = SF.enabledKinds(settings)
    local messages = getFullChat(tid)
    if type(messages) ~= 'table' or #messages == 0 then return end
    local last = messages[#messages]
    if last.role == 'user' then return end
    local scenes = SF.scenes(messages)
    local changed = dropDanglingRuns(tid, messages, scenes)
    if changed then scenes = SF.scenes(messages) end
    local open = SF.openScene(scenes)
    local died = false

    if settings.mainAnchors then
        local cleaned, marks, wrote = SF.convertTokens(last.data or '', open, kinds)
        if cleaned ~= last.data or marks ~= '' then
            last.data = marks ~= '' and (cleaned .. '\n' .. marks) or cleaned
            setMessage(tid, #messages, last.data)
            changed = true
        end
        died = wrote and settings.loop
        -- A scene left open too long: ask the auxiliary model once whether it ended.
        scenes = SF.scenes(messages)
        open = SF.openScene(scenes)
        if open and SF.repliesAfter(messages, open.s - 1) > SF.LONG_OPEN and not stateGet(tid, 'sf_asked_' .. open.id) then
            setState(tid, 'sf_asked_' .. open.id, true)
            local event = SF.parseJudge(ask(tid, SF.judgePrompt(messages, open, settings, { open.kind }, false), false))
            if event == 'end' or event == 'both' then
                appendMarks(tid, messages, #messages, SF.endMark(open.id))
                changed = true
            end
        end
    elseif #kinds > 0 or settings.loop then
        local event, kind, loop = SF.parseJudge(ask(tid, SF.judgePrompt(messages, open, settings, kinds, settings.loop), false))
        local marks = SF.marksForEvent(event, kind, open, kinds)
        if marks ~= '' then
            appendMarks(tid, messages, #messages, marks)
            changed = true
        end
        died = loop and settings.loop
    end

    if died and endRun(tid, messages, #messages) then changed = true end
    if SF.foldReady(tid, messages, settings) then changed = true end
    if changed then
        bumpVersion(tid)
        reloadDisplay(tid)
    end
end)

------------------------------------------------------------------------------
-- The request: folded scenes become their summaries
------------------------------------------------------------------------------

function SF.mainInstruction(kinds, open, settings)
    local lines = {}
    if #kinds > 0 then
        lines[#lines + 1] = '[Scene markers] Mark these scenes in your replies:'
        for _, kind in ipairs(kinds) do
            local name = kind == 'custom' and ('custom (' .. settings.customName .. ')') or kind
            lines[#lines + 1] = '- ' .. name .. ': ' .. SF.kindRule(kind, settings)
        end
        lines[#lines + 1] = 'When one begins in your reply, write [[SCENE START: kind]] on its own line right before it; when its outcome is decided or it stops, write [[SCENE END]] on its own line right after. Write nothing else about the markers.'
        if open then
            lines[#lines + 1] = 'A ' .. open.kind .. ' scene is open now: do not start another; write [[SCENE END]] when it ends.'
        end
    end
    if settings.loop then
        lines[#lines + 1] = '[Time loop] When ' .. SF.hero(settings) .. ' dies and time goes back, write [[LOOP END]] on its own line right after the death.'
    end
    return table.concat(lines, '\n')
end

--- The request with folded scenes replaced by their summaries and every mark removed.
function SF.rewriteRequest(messages, folded, settings, instruction)
    local out, placed = {}, {}
    for _, message in ipairs(messages) do
        local cutKind = type(message) == 'table' and type(message.content) == 'string' and message.content:match(SF.CUT_PATTERN) or nil
        if cutKind then
            -- A scene cut from the chat: its summary message, sent as the summary.
            out[#out + 1] = { role = 'system', content = SF.summaryBlock(cutKind, SF.trim(SF.strip(message.content)), settings) }
        elseif type(message) == 'table' and type(message.content) == 'string' then
            -- A message that also belongs to a scene still in play (one ends
            -- and the next starts in the same reply) stays.
            local hit, keep = nil, false
            for id in pairs(SF.markedIds(message.content)) do
                if folded[id] then hit = hit or id else keep = true end
            end
            if hit and not keep then
                -- The outer run when a battle inside it is folded too.
                for id in pairs(SF.markedIds(message.content)) do
                    if folded[id].kind == 'loop' then hit = id end
                end
                if not placed[hit] then
                    placed[hit] = true
                    out[#out + 1] = { role = 'system', content = SF.summaryBlock(folded[hit].kind, folded[hit].text, settings, folded[hit].number) }
                end
            else
                message.content = SF.strip(message.content)
                out[#out + 1] = message
            end
        else
            out[#out + 1] = message
        end
    end
    if instruction and instruction ~= '' then
        local at = #out + 1
        for i = #out, 1, -1 do
            if type(out[i]) == 'table' and out[i].role == 'user' then at = i break end
        end
        table.insert(out, at, { role = 'system', content = instruction })
    end
    return out
end

function SF.foldedScenes(tid, messages, settings)
    local folded = {}
    local scenes = SF.scenes(messages)
    local numbers = SF.runNumbers(messages, scenes)
    for _, scene in ipairs(scenes) do
        if SF.graceDone(messages, scene, settings.grace) then
            local summary = SF.summaryOf(tid, scene.id)
            if summary then folded[scene.id] = { kind = scene.kind, text = summary, number = numbers[scene.id] } end
        end
    end
    return folded
end

--- The request without the messages the request regex emptied (a folded
--- scene's other messages): some providers refuse an empty message.
function SF.withoutEmpty(messages)
    local out = {}
    for _, message in ipairs(messages) do
        local empty = type(message) == 'table' and message.content == ''
            and not (type(message.multimodals) == 'table' and #message.multimodals > 0)
        if not empty then out[#out + 1] = message end
    end
    return out
end

listenEdit('editRequest', function(tid, request, meta)
    if type(request) ~= 'table' then return request end
    local settings = SF.settings(tid)
    local messages = getFullChat(tid) or {}
    local instruction = nil
    if settings.mainAnchors then
        local kinds = SF.enabledKinds(settings)
        if #kinds > 0 or settings.loop then instruction = SF.mainInstruction(kinds, SF.openScene(SF.scenes(messages)), settings) end
    end
    local out = SF.rewriteRequest(request, SF.foldedScenes(tid, messages, settings), settings, instruction)
    if settings.early then out = SF.withoutEmpty(out) end
    return out
end)

------------------------------------------------------------------------------
-- Display
------------------------------------------------------------------------------

local function escapeHtml(text)
    return (tostring(text or ''):gsub('&', '&amp;'):gsub('<', '&lt;'):gsub('>', '&gt;'):gsub('"', '&quot;'))
end

local LINK = 'cursor:pointer;text-decoration:underline;opacity:.85'

function SF.card(scene, summary, count, expanded, settings, number)
    local body = escapeHtml(summary):gsub('\r?\n', '<br>')
    local title = scene.kind == 'loop' and ('🔁 지나간 회차 · ' .. escapeHtml(SF.kindLabel(scene.kind, settings, number)))
        or ('📁 접힌 장면 · ' .. escapeHtml(SF.kindLabel(scene.kind, settings)))
    return '<div style="border:1px solid rgba(127,127,127,.45);border-radius:8px;padding:8px 10px;margin:4px 0;font-size:.92em">'
        .. '<div style="opacity:.75;font-size:.85em">' .. title .. ' · 메시지 ' .. count .. '개</div>'
        .. '<div style="margin-top:4px">' .. body .. '</div>'
        .. '<div style="margin-top:6px;display:flex;gap:12px;flex-wrap:wrap;font-size:.82em">'
        .. '<span risu-btn="sf|x|' .. scene.id .. '" style="' .. LINK .. '">' .. (expanded and '접기' or '펼치기') .. '</span>'
        .. '<span risu-btn="sf|r|' .. scene.id .. '" style="' .. LINK .. '">다시 요약</span>'
        .. '<span risu-btn="sf|u|' .. scene.id .. '" style="' .. LINK .. '">접기 해제</span>'
        .. '</div></div>'
end

function SF.note(text)
    return '<div style="opacity:.6;font-size:.8em;margin:2px 0">' .. text .. '</div>'
end

function SF.buttonBar(index, settings)
    local bar = '<div style="opacity:.45;font-size:.75em;margin-top:2px;display:flex;gap:12px;flex-wrap:wrap">'
        .. '<span risu-btn="sf|s|' .. index .. '" style="cursor:pointer">▶ 여기부터 장면</span>'
        .. '<span risu-btn="sf|e|' .. index .. '" style="cursor:pointer">■ 여기까지 장면</span>'
    if settings and settings.loop then
        bar = bar .. '<span risu-btn="sf|d|' .. index .. '" style="cursor:pointer">🔁 여기서 회차 끝</span>'
    end
    return bar .. '</div>'
end

-- Scene lookups for display, kept until the chat or the module's marks change.
local displayCache = { key = nil }

local function displayKey(tid, settings)
    local length = getChatLength(tid)
    local first = length > 0 and getChat(tid, 0) or nil
    local last = length > 0 and getChat(tid, length - 1) or nil
    return table.concat({
        length, tostring(stateGet(tid, 'sf_ver') or 0), settings.grace,
        first and tostring(first.time or 0) or 0,
        last and tostring(last.time or 0) or 0, last and #(last.data or '') or 0,
    }, ':')
end

--- Which scene each message shows as. A folded run covers everything in it;
--- a run not folded yet shows its inner scenes and its own end.
function SF.displayInfo(tid, settings)
    local key = displayKey(tid, settings)
    if displayCache.key == key and displayCache.info then return displayCache.info end
    local messages = getFullChat(tid) or {}
    local info = { at = {}, messages = #messages }
    local scenes = SF.scenes(messages)
    local numbers = SF.runNumbers(messages, scenes)
    for _, scene in ipairs(SF.foldOrder(scenes)) do
        local summary = scene.e and SF.graceDone(messages, scene, settings.grace) and SF.summaryOf(tid, scene.id) or nil
        local entry = {
            scene = scene,
            summary = summary,
            number = numbers[scene.id],
            waiting = scene.e and not summary and SF.repliesAfter(messages, scene.e) or nil,
            failed = scene.e and not summary and stateGet(tid, 'sf_fail_' .. scene.id) == true or false,
        }
        for i = scene.s, scene.e or scene.s do
            if scene.kind ~= 'loop' or summary or not info.at[i] or i == scene.e then info.at[i] = entry end
        end
    end
    displayCache.key = key
    displayCache.info = info
    return info
end

function SF.cutCard(kind, id, summary, count, settings)
    local body = escapeHtml(summary):gsub('\r?\n', '<br>')
    return '<div style="border:1px dashed rgba(127,127,127,.55);border-radius:8px;padding:8px 10px;margin:4px 0;font-size:.92em">'
        .. '<div style="opacity:.75;font-size:.85em">✂️ 잘라낸 장면 · ' .. escapeHtml(SF.kindLabel(kind, settings)) .. (count and (' · 원문 ' .. count .. '개 보관 중') or '') .. '</div>'
        .. '<div style="margin-top:4px">' .. body .. '</div>'
        .. '<div style="margin-top:6px;font-size:.82em"><span risu-btn="sf|v|' .. id .. '" style="' .. LINK .. '">되돌리기</span></div>'
        .. '</div>'
end

listenEdit('editDisplay', function(tid, text, meta)
    local clean = SF.strip(text)
    local settings = SF.settings(tid)
    local cutKind, cutId = (type(text) == 'string' and text or ''):match(SF.CUT_PATTERN)
    if cutId then
        local count = tonumber(stateGet(tid, 'sf_cutn_' .. cutId))
        return SF.cutCard(cutKind, cutId, SF.trim(clean), count, settings)
    end
    local index = type(meta) == 'table' and tonumber(meta.index) or nil
    if not index or index < 0 then return clean end
    local position = index + 1
    local info = SF.displayInfo(tid, settings)
    local entry = info.at[position]
    if entry then
        local scene = entry.scene
        local label = escapeHtml(SF.kindLabel(scene.kind, settings, entry.number))
        if entry.summary then
            local expanded = stateGet(tid, 'sf_exp_' .. scene.id) == true
            if position == scene.s then
                local card = SF.card(scene, entry.summary, scene.e - scene.s + 1, expanded, settings, entry.number)
                return expanded and (card .. '\n\n' .. clean) or card
            end
            if expanded then return clean end
            if scene.kind == 'loop' then return SF.note('🔁 지나간 회차의 일부 · 위 카드에서 펼치기') end
            return SF.note('📁 접힌 장면의 일부 · 위 카드에서 펼치기')
        end
        if not scene.e and position == scene.s then
            return clean .. '\n\n' .. SF.note('📁 ' .. label .. ' 진행 중 · 끝나면 접힙니다')
        end
        if scene.e and position == scene.e then
            local left = math.max(0, settings.grace - (entry.waiting or 0))
            local status = left > 0 and ('답 ' .. left .. '개 뒤 접힘') or '요약을 만드는 중'
            if left == 0 and entry.failed then
                status = '요약을 못 만들었습니다 · <span risu-btn="sf|r|' .. scene.id .. '" style="' .. LINK .. '">다시 요약</span>'
            end
            local icon = scene.kind == 'loop' and '' or '📁 '
            return clean .. '\n\n' .. SF.note(icon .. label .. ' 끝 · ' .. status)
        end
    end
    if settings.buttons then
        return clean .. '\n\n' .. SF.buttonBar(index, settings)
    end
    return clean
end)

------------------------------------------------------------------------------
-- Buttons
------------------------------------------------------------------------------

local function removeMarks(tid, messages, id)
    local pattern = '\n?<!%-%-sf:[semf]:[%w:]*' .. id .. '%-%->'
    for i, message in ipairs(messages) do
        local text = message.data or ''
        local cleaned = text:gsub(pattern, '')
        if cleaned ~= text then
            message.data = cleaned
            setMessage(tid, i, cleaned)
        end
    end
    setState(tid, 'sf_sum_' .. id, '')
    setState(tid, 'sf_exp_' .. id, false)
    setChatVar(tid, 'sf_text_' .. id, '')
end

local function pickKind(tid, settings)
    local kinds = { 'battle', 'nsfw' }
    if settings.custom and settings.customRule ~= '' then kinds[#kinds + 1] = 'custom' end
    kinds[#kinds + 1] = 'scene'
    local labels = {}
    for i, kind in ipairs(kinds) do labels[i] = SF.kindLabel(kind, settings) end
    local ok, picked = pcall(function() return alertSelect(tid, labels):await() end)
    if not ok then
        -- No selection dialog here: the first kind that is on.
        local on = SF.enabledKinds(settings)
        return on[1] or 'scene'
    end
    local number = tonumber(picked)
    if not number then return nil end
    return kinds[number + 1]
end

onButtonClick = async(function(tid, data)
    local action, argument = tostring(data or ''):match('^sf|(%a)|(.+)$')
    if not action then return end
    local settings = SF.settings(tid)
    local messages = getFullChat(tid) or {}
    local scenes, byId = SF.scenes(messages)
    local open = SF.openScene(scenes)

    if action == 's' then
        local position = (tonumber(argument) or -1) + 1
        if not messages[position] then return end
        if open then
            alertNormal(tid, '이미 진행 중인 장면이 있습니다. 먼저 "여기까지 장면"으로 끝을 정해 주세요.')
            return
        end
        local kind = pickKind(tid, settings)
        if not kind then return end
        appendMarks(tid, messages, position, SF.startMark(kind, newId()))
    elseif action == 'e' then
        local position = (tonumber(argument) or -1) + 1
        if not messages[position] then return end
        if not open or open.s > position then
            alertNormal(tid, '여기보다 앞에서 시작한 장면이 없습니다. 먼저 "여기부터 장면"을 눌러 주세요.')
            return
        end
        appendMarks(tid, messages, position, SF.endMark(open.id))
    elseif action == 'd' then
        -- 여기서 회차 끝: the hero died here.
        local position = (tonumber(argument) or -1) + 1
        if not messages[position] then return end
        if not endRun(tid, messages, position) then
            alertNormal(tid, '이 메시지는 이미 지난 회차에 들어 있습니다.')
            return
        end
    elseif action == 'x' then
        setState(tid, 'sf_exp_' .. argument, not (stateGet(tid, 'sf_exp_' .. argument) == true))
    elseif action == 'r' then
        local scene = byId[argument]
        if not scene or not scene.e then return end
        local summary = SF.makeSummary(tid, messages, scene, scenes, settings)
        if not summary then
            alertNormal(tid, '요약을 만들지 못했습니다. 모듈의 저수준 접근이 켜져 있는지, 보조 모델 설정을 확인해 주세요.')
            return
        end
        setState(tid, 'sf_sum_' .. argument, summary)
    elseif action == 'u' then
        removeMarks(tid, messages, argument)
    elseif action == 'v' then
        -- 되돌리기: the cut originals back in place of the summary message;
        -- the scene stays folded in requests and is not cut again.
        local originals = stateGet(tid, 'sf_cut_' .. argument)
        local at = nil
        for i, message in ipairs(messages) do
            local _, id = (message.data or ''):match(SF.CUT_PATTERN)
            if id == argument then at = i break end
        end
        if not at or type(originals) ~= 'table' or #originals == 0 then
            alertNormal(tid, '되돌릴 원문을 찾지 못했습니다.')
            return
        end
        removeChat(tid, at - 1)
        for k = #originals, 1, -1 do
            insertChat(tid, at - 1, originals[k].role == 'user' and 'user' or 'char', originals[k].data or '')
        end
        setState(tid, 'sf_nocut_' .. argument, true)
        setState(tid, 'sf_cut_' .. argument, '')
        setState(tid, 'sf_cutn_' .. argument, 0)
    else
        return
    end

    messages = getFullChat(tid) or messages
    SF.foldReady(tid, messages, settings)
    bumpVersion(tid)
    reloadDisplay(tid)
end)
