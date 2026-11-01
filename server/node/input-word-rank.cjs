'use strict';

// Input word rank popup (src/lib/Others/InputWordRankDialog.svelte): ranks the
// words, phrases and sentences the user writes most, counted here over the
// active bots' chat bodies and, when asked, the deactivated bots' archive rows,
// which a plugin cannot see.
//
// The rules are those of plugins/input-word-rank, the portable plugin for
// official RisuAI and PocketRisu: the part between the two SHARED lines is a
// copy of that plugin's counting section, and input-word-rank.test.ts fails
// when the two differ. Change them together.

// ---------- SHARED with plugins/input-word-rank (keep identical) ----------
const MAX_ENTRIES = 400000 // per table; singletons are dropped past it, and the counts say "대략"
const PHRASE_POOL = 1500

// ---------- counting ----------
const MACRO = /\{\{[\s\S]*?\}\}/g
const TAG = /<[^>]*>/g
const URL_RE = /\bhttps?:\/\/\S+/g
const PARENS = /\([^()]*\)|（[^（）]*）|\[[^[\]]*\]/g
const MARKER = /\[[!-Z\\^-~]*\]/g // ASCII with no space or bracket inside
const JSON_OBJECT = /\{[^{}]*"\s*:[^{}]*\}/g
// Math letters (𝑎, 𝐛, 𝟏) and full-width ones (Ａ, １) are read as the plain letter.
const STYLED = /[\u{1D400}-\u{1D7FF}ℂℊℋℌℍℎℐℑℒℓℕℙℚℛℜℝℤℨℬℭℯℰℱℳℴ０-９Ａ-Ｚａ-ｚ]/gu
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
    let t = String(text ?? '').replace(STYLED, (c) => c.normalize('NFKC')).replace(MACRO, ' ').replace(TAG, ' ').replace(URL_RE, ' ')
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
    const totals = { bots: 0, chats: 0, inputs: 0, copies: 0, botInputs: 0, words: 0, failed: 0, approximate: false }
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
        // The input box stamps a send time; a message a bot's Lua or
        // trigger adds (a clicked choice) has none. Such a message is
        // placed by the last send time before it, which a copy keeps too.
        let anchor = 0
        let gap = 0
        for (const message of Array.isArray(chat?.message) ? chat.message : []) {
            if (message?.time) { anchor = message.time; gap = 0 } else gap++
            if (message?.role !== 'user' || typeof message.data !== 'string' || !message.data.trim()) continue
            const stamp = message.time ? `t${message.time}` : anchor ? `a${anchor}+${gap}` : message.chatId ? `i${message.chatId}` : ''
            if (stamp) {
                const key = `${stamp}|${hash(message.data)}`
                const first = seen.get(key)
                if (first !== undefined && first !== self) { totals.copies++; continue }
                seen.set(key, self)
            }
            if (options.botInputs && !message.time && anchor) { totals.botInputs++; continue }
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
// ---------- end of SHARED ----------

const SCOPES = new Set(['chat', 'char', 'all']);
const MAX_LIMIT = 500;
const MAX_EXCLUDE = 10000;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/** The options a request may set, with the plugin's defaults. */
function readRequest(body) {
    const request = body && typeof body === 'object' ? body : {};
    const limit = Number.isInteger(request.limit) ? Math.min(Math.max(request.limit, 1), MAX_LIMIT) : 100;
    return {
        scope: SCOPES.has(request.scope) ? request.scope : 'char',
        chaId: typeof request.chaId === 'string' ? request.chaId : '',
        chatId: typeof request.chatId === 'string' ? request.chatId : '',
        deactivated: request.deactivated === true,
        limit,
        options: {
            particles: request.particles !== false,
            parens: request.parens === true,
            english: request.english === true,
            botInputs: request.botInputs !== false,
            exclude: typeof request.exclude === 'string' ? request.exclude.slice(0, MAX_EXCLUDE) : '',
        },
    };
}

/**
 * Counts one request.
 * - characters: the active bots in list order, [{ chaId, chats: [{ id }] }];
 * - readChat(chaId, chatId): that chat with its messages, or null;
 * - archived: the deactivated bots to count with "deactivated", [{ chaId, archivedAt }];
 * - readArchivedChats(stub): a promise of that bot's chats, or null;
 * - shouldStop(): true once the caller has gone; the count ends at the next bot.
 * A bot counts when one of its chats was read. Resolves to
 * { words, phrases, sentences, totals }, or null when the chat or bot the
 * scope names is not active.
 */
async function rankInputWords({ characters, readChat, archived = [], readArchivedChats, body, shouldStop = () => false }) {
    const request = readRequest(body);
    const counter = createCounter(request.options);
    const totals = Object.assign(counter.totals, { deactivatedBots: 0, stopped: false });
    const countChats = (chats, read) => {
        let found = 0;
        for (const chat of chats) {
            const full = read(chat);
            if (full) { counter.addChat(full); found++; } else totals.failed++;
        }
        return found;
    };

    if (request.scope === 'chat') {
        const character = characters.find((c) => c.chaId === request.chaId);
        const chat = character?.chats.find((c) => c.id === request.chatId);
        if (!chat) return null;
        if (countChats([chat], (c) => readChat(character.chaId, c.id))) totals.bots = 1;
        return { ...counter.results(request.limit), totals };
    }

    const list = request.scope === 'char' ? characters.filter((c) => c.chaId === request.chaId) : characters;
    if (request.scope === 'char' && list.length === 0) return null;
    for (const character of list) {
        if (shouldStop()) { totals.stopped = true; break; }
        if (countChats(character.chats, (c) => readChat(character.chaId, c.id))) totals.bots++;
        await yieldToLoop();
    }
    if (request.scope === 'all' && request.deactivated) {
        for (const stub of archived) {
            if (totals.stopped || shouldStop()) { totals.stopped = true; break; }
            let chats = null;
            try { chats = await readArchivedChats(stub); } catch { chats = null; }
            if (!Array.isArray(chats)) { totals.failed++; continue; }
            if (countChats(chats, (c) => c)) { totals.bots++; totals.deactivatedBots++; }
            await yieldToLoop();
        }
    }
    return { ...counter.results(request.limit), totals };
}

module.exports = { createCounter, rankInputWords, readRequest };
