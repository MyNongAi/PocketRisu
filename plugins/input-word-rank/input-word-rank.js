//@name input_word_rank
//@display-name 입력 단어 순위
//@api 3.0
//@version 1.1.0

// Ranks what the user writes most: words, phrases (2 to 4 words in a row)
// and whole sentences, counted over the user's messages in the open chat,
// every chat of the open bot, or every bot.
//
// Opened from the settings menu ("입력 단어 순위"). It reads chats only, with
// getChatFromIndex, and writes nothing to them. A PocketRisu chat that was
// not opened yet is fetched from the server for the count and not loaded
// into the app. Deactivated bots (PocketRisu) are not in the bot list a
// plugin sees, so they are not counted.
//
// The particle option ("조사 떼기") folds "사람이/사람을/사람에게" into
// "사람" by the ending and the syllable before it, with no dictionary: it
// leaves a word alone when the part left would be one syllable (작은, 마을,
// 앞으로), except for pronouns (나는 → 나, 내가 → 내), and when the ending
// does not fit that syllable (누군가). Phrases and sentences keep the words
// as written.
//
// A message met again in a copied or branched chat (the same send time, or
// id, and text) is counted once.
//
// Markers a bot or a module puts in the user's message are not counted: a
// bracket of ASCII with no space ([SCENE_START], [ACT:card_1], [1-2]) and a
// JSON object. "영어 빼기" leaves out the words with Latin letters
// (a phrase does not run across one) and the sentences with more Latin
// letters than Hangul.
//
// The options are kept on this device (getLocalPluginStorage).

(async () => {
    const OPTIONS_KEY = 'input_word_rank_options'
    const DEFAULTS = { scope: 'char', particles: true, parens: false, english: false, exclude: '', limit: 100 }
    const MAX_ENTRIES = 400000 // per table; singletons are dropped past it, and the counts say "대략"
    const PHRASE_POOL = 1500

    // ---------- counting ----------
    const MACRO = /\{\{[\s\S]*?\}\}/g
    const TAG = /<[^>]*>/g
    const URL_RE = /\bhttps?:\/\/\S+/g
    const PARENS = /\([^()]*\)|（[^（）]*）|\[[^[\]]*\]/g
    const MARKER = /\[[!-Z\\^-~]*\]/g // ASCII with no space or bracket inside
    const JSON_OBJECT = /\{[^{}]*"\s*:[^{}]*\}/g
    const LATIN = /[a-z]/i
    const mostlyLatin = (sentence) => (sentence.match(/[a-z]/gi)?.length ?? 0) > (sentence.match(/[가-힣]/g)?.length ?? 0)
    const SENTENCE_BREAK = /\n+|(?<=[.!?…。！？])\s+/
    const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu
    const LAUGH = /([ㅋㅎㅠㅜㄷ])\1{2,}/g
    const HANGUL = /^[가-힣]+$/
    const PRONOUNS = new Set(['나', '너', '저', '내', '네', '제', '걔', '쟤', '얘', '그'])
    const PRONOUN_SUFFIXES = ['에게', '한테', '랑', '는', '은', '를', '을', '가', '이', '도', '만', '의', '와', '과']
    // [ending, what the syllable before it must be], longest first. 이/은/을/과
    // follow a closed syllable (사람이), 가/는/를/와/랑 an open one (친구가),
    // 로 an open one or ㄹ (서울로): so 누군가 and 마을 stay whole.
    const ENDINGS = [
        ['에게서', 'any'], ['한테서', 'any'], ['에서는', 'any'], ['에게는', 'any'], ['한테는', 'any'], ['으로는', 'closed'],
        ['에서도', 'any'], ['까지는', 'any'], ['부터는', 'any'], ['이라고', 'closed'], ['이라는', 'closed'],
        ['이랑', 'closed'], ['처럼', 'any'], ['까지', 'any'], ['부터', 'any'], ['에서', 'any'], ['에게', 'any'], ['한테', 'any'], ['으로', 'closed'],
        ['은', 'closed'], ['이', 'closed'], ['을', 'closed'], ['과', 'closed'],
        ['는', 'open'], ['가', 'open'], ['를', 'open'], ['와', 'open'], ['랑', 'open'], ['로', 'openOrL'],
        ['에', 'any'], ['의', 'any'], ['도', 'any'], ['만', 'any'],
    ]
    // Whole words that only look like a noun and a particle.
    const KEEP = new Set(['고양이', '원숭이', '어린이', '똑같이', '깨끗이', '하지만', '그렇지만', '그래도', '아무래도', '적어도',
        '그대로', '제대로', '마음대로', '멋대로', '스스로', '함부로', '저절로', '억지로', '첫사랑', '짝사랑'])
    function syllableFits(syllable, need) {
        if (need === 'any') return true
        const code = syllable.charCodeAt(0) - 0xAC00
        const final = code % 28
        if (need === 'closed') return final !== 0
        if (need === 'open') return final === 0
        return final === 0 || final === 8 // openOrL: no final consonant, or ㄹ
    }

    function cleanText(text, dropParens) {
        let t = String(text ?? '').replace(MACRO, ' ').replace(TAG, ' ').replace(URL_RE, ' ')
        let before
        // Inside out: [ACT:{"id":1}] loses its object, then the marker left.
        do { before = t; t = t.replace(JSON_OBJECT, '').replace(MARKER, ' ') } while (t !== before)
        if (dropParens) {
            do { before = t; t = t.replace(PARENS, ' ') } while (t !== before)
        }
        return t.replace(/[*_~`#>|]+/g, ' ')
    }

    function stripParticle(word) {
        if (!HANGUL.test(word) || KEEP.has(word)) return word
        if (word.length >= 2 && PRONOUNS.has(word[0]) && PRONOUN_SUFFIXES.includes(word.slice(1))) return word[0]
        for (const [ending, need] of ENDINGS) {
            if (!word.endsWith(ending)) continue
            // The first ending that matches decides: 앞으로 is not 앞으 + 로.
            const stem = word.slice(0, -ending.length)
            if (stem.length < 2 || !syllableFits(stem.at(-1), need)) return word
            if ((ending === '만' && stem.endsWith('지')) || (ending === '로' && stem.endsWith('대'))) return word // 좋지만, 그대로
            return stem
        }
        return word
    }

    function tokensOf(sentence) {
        const out = []
        for (const raw of sentence.split(/\s+/)) {
            const word = raw.replace(EDGE, '').replace(LAUGH, '$1$1$1').toLowerCase()
            if (/\p{L}/u.test(word)) out.push(word) // not 12, 1-2 or 3:00
        }
        return out
    }

    // cyrb53, a 53-bit string hash: two messages sent at the same moment are told apart by it.
    function hash(text) {
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i)
            h1 = Math.imul(h1 ^ c, 2654435761)
            h2 = Math.imul(h2 ^ c, 1597334677)
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
        return 4294967296 * (2097151 & h2) + (h1 >>> 0)
    }

    const sentenceKey = (sentence) => sentence.toLowerCase().replace(LAUGH, '$1$1$1').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()

    function createCounter(options) {
        const exclude = new Set(String(options.exclude ?? '').split(/[\s,]+/).map((w) => w.trim().toLowerCase()).filter(Boolean))
        const words = new Map()
        const phrases = new Map()
        const sentences = new Map()
        const totals = { bots: 0, chats: 0, inputs: 0, copies: 0, words: 0, failed: 0, approximate: false }
        // A copied or branched chat keeps its messages' send times (official
        // RisuAI also their ids): the same message met again in another chat
        // is counted once. In its own chat a message is always counted.
        const seen = new Map()

        function prune(map, single) {
            if (map.size <= MAX_ENTRIES) return
            for (const [key, value] of map) if ((single ? value : value.n) === 1) map.delete(key)
            totals.approximate = true
        }
        const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

        function addMessage(text) {
            totals.inputs++
            for (const part of cleanText(text, options.parens).split(SENTENCE_BREAK)) {
                const sentence = part.replace(/\s+/g, ' ').trim()
                if (!sentence || (options.english && mostlyLatin(sentence))) continue
                // Runs of words a phrase may span; with 영어 빼기 an English word ends one.
                const runs = [[]]
                for (const token of tokensOf(sentence)) {
                    if (options.english && LATIN.test(token)) runs.push([])
                    else runs.at(-1).push(token)
                }
                const tokens = runs.flat()
                if (tokens.length === 0) continue
                totals.words += tokens.length
                for (const token of tokens) {
                    const word = options.particles ? stripParticle(token) : token
                    if (!exclude.has(word) && !exclude.has(token)) bump(words, word)
                }
                for (const run of runs) {
                    for (let n = 2; n <= 4; n++) {
                        for (let i = 0; i + n <= run.length; i++) bump(phrases, run.slice(i, i + n).join(' '))
                    }
                }
                const key = sentenceKey(sentence)
                if (key.length >= 2 && /\p{L}/u.test(key)) {
                    const entry = sentences.get(key)
                    if (entry) entry.n++
                    else sentences.set(key, { n: 1, text: sentence })
                }
            }
            prune(words, true)
            prune(phrases, true)
            prune(sentences, false)
        }

        function addChat(chat) {
            const self = ++totals.chats
            for (const message of Array.isArray(chat?.message) ? chat.message : []) {
                if (message?.role !== 'user' || typeof message.data !== 'string' || !message.data.trim()) continue
                const stamp = message.time ? `t${message.time}` : message.chatId ? `i${message.chatId}` : ''
                if (stamp) {
                    const key = `${stamp}|${hash(message.data)}`
                    const first = seen.get(key)
                    if (first !== undefined && first !== self) { totals.copies++; continue }
                    seen.set(key, self)
                }
                addMessage(message.data)
            }
        }

        function results(limit) {
            const byCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
            const wordList = [...words].sort(byCount).slice(0, limit)
            // A phrase inside a longer one that is written as often says nothing new.
            const pool = [...phrases].filter(([, n]) => n >= 2).sort(byCount).slice(0, PHRASE_POOL)
            const phraseList = []
            for (const [phrase, n] of pool) {
                const inner = ` ${phrase} `
                if (pool.some(([other, m]) => m >= n && other.length > phrase.length && ` ${other} `.includes(inner))) continue
                phraseList.push([phrase, n])
                if (phraseList.length >= limit) break
            }
            const sentenceList = [...sentences.values()].filter((e) => e.n >= 2)
                .sort((a, b) => b.n - a.n || a.text.localeCompare(b.text)).slice(0, limit).map((e) => [e.text, e.n])
            return { words: wordList, phrases: phraseList, sentences: sentenceList }
        }

        return { addChat, results, totals }
    }

    // ---------- reading chats ----------
    // { chat } for a chat, null past the last one; a chat that fails to load is skipped.
    async function chatAt(charIndex, chatIndex, totals) {
        try {
            const chat = await risuai.getChatFromIndex(charIndex, chatIndex)
            return chat ? { chat } : null
        } catch (error) {
            console.log(`[input_word_rank] chat ${charIndex}/${chatIndex}: ${error?.message ?? error}`)
            totals.failed++
            return { chat: null }
        }
    }

    async function countBot(charIndex, counter, shouldStop, progress) {
        const first = await chatAt(charIndex, 0, counter.totals)
        if (!first) return (await risuai.getCharacterFromIndex(charIndex)) ? 'empty' : 'end'
        counter.totals.bots++
        for (let chatIndex = 0, slot = first; slot; slot = await chatAt(charIndex, ++chatIndex, counter.totals)) {
            if (slot.chat) counter.addChat(slot.chat)
            progress()
            if (shouldStop()) return 'stopped'
        }
        return 'done'
    }

    async function count(options, shouldStop, onProgress) {
        const counter = createCounter(options)
        const progress = () => onProgress(counter.totals)
        const current = await risuai.getCurrentCharacterIndex()
        if (options.scope !== 'all' && !(current >= 0)) throw new Error('봇의 채팅을 먼저 열어 주세요.')
        if (options.scope === 'chat') {
            const slot = await chatAt(current, await risuai.getCurrentChatIndex(), counter.totals)
            if (slot?.chat) { counter.totals.bots = 1; counter.addChat(slot.chat) }
        } else if (options.scope === 'char') {
            await countBot(current, counter, shouldStop, progress)
        } else {
            for (let charIndex = 0; ; charIndex++) {
                const state = await countBot(charIndex, counter, shouldStop, progress)
                if (state === 'end' || state === 'stopped') break
            }
        }
        return counter
    }

    // ---------- the window ----------
    let localStore = null
    const store = async () => (localStore ??= await risuai.getLocalPluginStorage())
    async function loadOptions() {
        try { return { ...DEFAULTS, ...((await (await store()).getItem(OPTIONS_KEY)) ?? {}) } } catch { return { ...DEFAULTS } }
    }
    async function saveOptions(options) {
        try { await (await store()).setItem(OPTIONS_KEY, options) } catch {}
    }

    const STYLE = `
<style>
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,sans-serif; background:#1e1f24; color:#e8e8ea; }
  .wrap { max-width:640px; margin:0 auto; padding:16px; }
  .head { display:flex; align-items:center; gap:8px; }
  h2 { font-size:18px; margin:4px 0; flex:1; }
  p { font-size:13px; line-height:1.5; color:#b9bac2; margin:6px 0; }
  .row { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0; align-items:center; }
  label.pick { display:flex; align-items:center; gap:4px; font-size:13px; background:#2a2b31; border:1px solid #44464f; border-radius:6px; padding:6px 10px; }
  label.pick:has(input:checked) { border-color:#7aa2f7; background:#2c3447; }
  input[type=text] { width:100%; background:#2a2b31; color:#e8e8ea; border:1px solid #44464f; border-radius:6px; padding:8px; font-size:13px; }
  button { background:#3b3d46; color:#e8e8ea; border:1px solid #55575f; border-radius:6px; padding:8px 12px; font-size:13px; }
  button.main { background:#3d5a99; border-color:#5d7cc4; }
  button:disabled { opacity:.5; }
  .tabs { display:flex; gap:4px; margin:14px 0 6px; }
  .tabs button { flex:1; }
  .tabs button[aria-pressed=true] { background:#2c3447; border-color:#7aa2f7; }
  ol { list-style:none; padding:0; margin:0; }
  li { display:grid; grid-template-columns:2.2em 1fr auto; gap:8px; align-items:center; padding:6px 4px; border-bottom:1px solid #2e3038; font-size:14px; }
  li .rank { color:#8b8d97; font-size:12px; text-align:right; }
  li .text { overflow-wrap:anywhere; }
  li .bar { grid-column:2 / 4; height:3px; border-radius:2px; background:#5d7cc4; }
  li .n { color:#b9bac2; font-variant-numeric:tabular-nums; }
  textarea { width:100%; min-height:200px; background:#2a2b31; color:#e8e8ea; border:1px solid #44464f; border-radius:6px; padding:8px; font-size:12px; }
  .muted { color:#8b8d97; font-size:12px; }
</style>`

    async function open() {
        const options = await loadOptions()
        const pick = (name, value, label) => `<label class="pick"><input type="radio" name="${name}" value="${value}"${options[name] === value ? ' checked' : ''}>${label}</label>`
        const check = (name, label) => `<label class="pick"><input type="checkbox" name="${name}"${options[name] ? ' checked' : ''}>${label}</label>`
        document.body.innerHTML = `${STYLE}
<div class="wrap">
  <div class="head"><h2>입력 단어 순위</h2><button id="close">닫기</button></div>
  <p>내가 보낸 메시지에서 자주 쓴 단어, 표현(2~4단어), 문장을 셉니다. 채팅은 읽기만 합니다.</p>
  <div class="row">${pick('scope', 'chat', '지금 채팅')}${pick('scope', 'char', '지금 봇의 모든 채팅')}${pick('scope', 'all', '모든 봇')}</div>
  <div class="row">${check('particles', '조사 떼기 (대략)')}${check('parens', '괄호 속 빼기 (OOC)')}${check('english', '영어 빼기')}</div>
  <input type="text" id="exclude" placeholder="빼고 셀 단어 (쉼표나 띄어쓰기로 구분)">
  <div class="row"><button id="run" class="main">세기</button><button id="stop" disabled>멈추기</button><span id="status" class="muted"></span></div>
  <div id="out"></div>
</div>`
        const $ = (id) => document.getElementById(id)
        $('exclude').value = options.exclude ?? ''
        $('close').onclick = () => { stop = true; void risuai.hideContainer() }

        let stop = false
        let running = false
        const readOptions = () => ({
            ...options,
            scope: document.querySelector('input[name=scope]:checked')?.value ?? 'char',
            particles: document.querySelector('input[name=particles]').checked,
            parens: document.querySelector('input[name=parens]').checked,
            english: document.querySelector('input[name=english]').checked,
            exclude: $('exclude').value,
        })

        $('stop').onclick = () => { stop = true }
        $('run').onclick = async () => {
            if (running) return
            running = true
            stop = false
            $('run').disabled = true
            $('stop').disabled = false
            $('out').replaceChildren()
            const status = (text) => { $('status').textContent = text }
            status('세는 중…')
            const current = readOptions()
            void saveOptions(current)
            let counter = null
            const describe = (t) => `봇 ${t.bots.toLocaleString()} · 채팅 ${t.chats.toLocaleString()} · 입력 ${t.inputs.toLocaleString()}개`
            let shown = 0
            try {
                counter = await count(current, () => stop, (totals) => {
                    if (performance.now() - shown > 200) { shown = performance.now(); status(`세는 중… ${describe(totals)}`) }
                })
            } catch (error) {
                status(error?.message ?? String(error))
            }
            running = false
            $('run').disabled = false
            $('stop').disabled = true
            if (!counter) return
            const t = counter.totals
            status(`${stop ? '멈춤: ' : ''}${describe(t)} · 단어 ${t.words.toLocaleString()}개${t.copies ? ` · 복사한 채팅에서 겹친 입력 ${t.copies.toLocaleString()}개는 한 번만 셈` : ''}${t.failed ? ` · 못 읽은 채팅 ${t.failed}개` : ''}${t.approximate ? ' · 양이 많아 한 번만 나온 것은 덜 셌습니다(대략)' : ''}`)
            render(counter.results(current.limit))
        }

        function render(lists) {
            const tabs = [['words', '단어'], ['phrases', '표현'], ['sentences', '문장']]
            let tab = 'words'
            const out = $('out')
            const bar = document.createElement('div')
            bar.className = 'tabs'
            const list = document.createElement('ol')
            const asText = document.createElement('button')
            asText.textContent = '텍스트로 보기'
            const area = document.createElement('textarea')
            area.readOnly = true
            area.hidden = true
            const note = document.createElement('p')
            note.className = 'muted'

            function draw() {
                for (const button of bar.children) button.setAttribute('aria-pressed', String(button.dataset.tab === tab))
                const rows = lists[tab]
                note.textContent = rows.length === 0
                    ? (tab === 'words' ? '센 단어가 없습니다.' : '두 번 이상 쓴 것이 없습니다.')
                    : (tab === 'words' ? '' : '두 번 이상 쓴 것만 보입니다.')
                const top = rows[0]?.[1] ?? 1
                list.replaceChildren(...rows.map(([text, n], i) => {
                    const item = document.createElement('li')
                    const rank = document.createElement('span')
                    rank.className = 'rank'
                    rank.textContent = String(i + 1)
                    const label = document.createElement('span')
                    label.className = 'text'
                    label.textContent = text
                    const count = document.createElement('span')
                    count.className = 'n'
                    count.textContent = n.toLocaleString()
                    const meter = document.createElement('span')
                    meter.className = 'bar'
                    meter.style.width = `${Math.max(2, Math.round(n / top * 100))}%`
                    item.append(rank, label, count, meter)
                    return item
                }))
                area.value = rows.map(([text, n], i) => `${i + 1}. ${text} (${n})`).join('\n')
            }
            for (const [key, name] of tabs) {
                const button = document.createElement('button')
                button.dataset.tab = key
                button.textContent = `${name} ${lists[key].length}`
                button.onclick = () => { tab = key; draw() }
                bar.append(button)
            }
            asText.onclick = () => {
                area.hidden = !area.hidden
                if (!area.hidden) { area.focus(); area.select() }
            }
            out.replaceChildren(bar, note, list, asText, area)
            draw()
        }

        await risuai.showContainer('fullscreen')
    }

    await risuai.registerSetting('입력 단어 순위', open, '📊', 'html', 'input-word-rank')
})()
