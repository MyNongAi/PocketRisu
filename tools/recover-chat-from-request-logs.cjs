'use strict';

// Rebuild chat turns that were generated but never saved, from the provider
// request log (save/request-logs.db). How and why: docs/ko/chat-recovery.md.
//
// Read-only on the save folder. For every chat whose newest generation is
// missing from the saved chat, writes one import file ({type:'risuChat',
// ver:2}) that the user adds through "채팅 불러오기"; the saved chat itself is
// never touched.
//
//   node tools/recover-chat-from-request-logs.cjs [--save save] [--since 24h]
//        [--until <time>] [--out recovered-chats] [--chat <chatId>] [--dry-run 1]
//
// The method, verified byte-for-byte on saved turns (2026-09-24 incident):
// - The newest generation's prompt carries every earlier reply exactly as the
//   app saved it, minus its <Thoughts> block (and any trailing lines a bot
//   script appends to the newest reply only).
// - Each of those replies is matched to the generation that produced it, whose
//   logged response supplies the <Thoughts> block and the message id.
// - The newest generation's own reply comes from its logged response.
// - Its user input sits in the prompt tail at the same distance from the end
//   as the previous input sat in the previous generation's prompt, whatever
//   instructions the bot adds around it.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const root = path.resolve(__dirname, '..');
// utils.cjs loads logs.cjs, which opens save/logs.db for writing on load.
// This tool must not write to a live server's files, so stub it.
const logsPath = require.resolve(path.join(root, 'server/node/logs.cjs'));
const noop = () => {};
require.cache[logsPath] = {
    id: logsPath, filename: logsPath, loaded: true,
    exports: { logger: { info: noop, warn: noop, error: noop, debug: noop, log: noop }, maskSensitive: (value) => value },
};
const { decodeRisuSave } = require(path.join(root, 'server/node/utils.cjs'));
const Database = require('better-sqlite3');

const COLD_STORAGE_HEADER = 'COLDSTORAGE';

function parseArgs(argv) {
    const args = { save: 'save', since: '24h', out: 'recovered-chats' };
    for (let i = 2; i < argv.length; i += 2) {
        const key = argv[i];
        if (!key?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`Invalid argument: ${key}`);
        args[key.slice(2)] = argv[i + 1];
    }
    return args;
}

function parseTime(value, fallback) {
    if (value === undefined) return fallback;
    const hours = /^(\d+(?:\.\d+)?)h$/.exec(value);
    if (hours) return Date.now() - Number(hours[1]) * 3600e3;
    const at = Date.parse(value);
    if (Number.isNaN(at)) throw new Error(`Cannot read time: ${value}`);
    return at;
}

const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
const preview = (text, n = 24) => JSON.stringify(String(text).replace(/\s+/g, ' ').slice(0, n));

// ── Saved database (chunk-aware, read-only) ─────────────────────────────────

function readValue(db, key) {
    const rows = db.prepare(`
        SELECT c.data FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash
        WHERE m.manifest_key = ? ORDER BY m.seq`).all(key);
    if (rows.length > 0) return Buffer.concat(rows.map((row) => row.data));
    return db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
}

/** Active characters, plus deactivated ones from their archive rows. */
async function readSavedCharacters(saveDir) {
    const db = new Database(path.join(saveDir, 'risuai.db'), { readonly: true, fileMustExist: true });
    try {
        const raw = readValue(db, 'database/database.bin');
        if (!raw) throw new Error('database/database.bin not found');
        const database = await decodeRisuSave(raw);
        const characters = [...(database.characters ?? [])];
        for (const stub of database.nodeOnlyArchivedCharacters ?? []) {
            const row = readValue(db, `archive/${stub.chaId}/${stub.archivedAt}`);
            if (!row) continue;
            const character = (await decodeRisuSave(row))?.character;
            if (character?.chaId === stub.chaId) characters.push({ ...character, archived: true });
        }
        return characters;
    } finally {
        db.close();
    }
}

// ── Request log parsing ─────────────────────────────────────────────────────

function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
    return '';
}

/** Prompt turns as [{ role: 'user' | 'model' | 'system', text }]. */
function promptTurns(requestBody) {
    let body;
    try { body = JSON.parse(requestBody); } catch { return null; }
    if (Array.isArray(body?.contents)) {
        return body.contents.map((c) => ({ role: c.role === 'model' ? 'model' : 'user', text: (c.parts ?? []).map((p) => p?.text ?? '').join('') }));
    }
    if (Array.isArray(body?.messages)) {
        return body.messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : m.role === 'user' ? 'user' : 'system',
            text: textOf(m.content),
        }));
    }
    return null;
}

/** A logged response as { thoughts, text } or, for plugin text, { formatted }. */
function responseParts(row) {
    const body = String(row.response_body ?? '');
    let thoughts = '';
    let text = '';
    const addGemini = (event) => {
        for (const part of event?.candidates?.[0]?.content?.parts ?? []) {
            if (part.thought) thoughts += part.text ?? '';
            else text += part.text ?? '';
        }
    };
    const addOpenAI = (event) => {
        for (const choice of event?.choices ?? []) {
            const piece = choice.delta ?? choice.message ?? {};
            thoughts += piece.reasoning_content ?? piece.reasoning ?? '';
            text += textOf(piece.content);
        }
    };
    const addAnthropic = (event) => {
        if (event?.type === 'content_block_delta') {
            thoughts += event.delta?.thinking ?? '';
            text += event.delta?.text ?? '';
        }
        for (const block of event?.content ?? []) {
            if (block.type === 'thinking') thoughts += block.thinking ?? '';
            if (block.type === 'text') text += block.text ?? '';
        }
    };
    const add = (event) => { addGemini(event); addOpenAI(event); addAnthropic(event); };
    if (/^\s*data:/m.test(body) && String(row.response_type ?? '').includes('event-stream')) {
        for (const line of body.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try { add(JSON.parse(line.slice(5))); } catch { /* keep-alive or [DONE] */ }
        }
        return { thoughts, text };
    }
    try {
        const json = JSON.parse(body);
        add(json);
        if (thoughts || text) return { thoughts, text };
    } catch { /* not JSON */ }
    // Plugin providers hand back the finished message text.
    return { formatted: body };
}

const THOUGHTS_BLOCK = /^<Thoughts>[\s\S]*?<\/Thoughts>\s*/;
const thoughtsPrefix = (saved) => THOUGHTS_BLOCK.exec(saved)?.[0] ?? '';
const withoutThoughts = (saved) => saved.replace(THOUGHTS_BLOCK, '');

/** A reply in the form the app saves it; `wrap` is the chat's thought wrapper. */
function savedForm(row, wrap) {
    const parts = responseParts(row);
    if (parts.formatted !== undefined) return parts.formatted;
    return (parts.thoughts.trim() ? wrap(parts.thoughts) : '') + parts.text;
}

/** The <Thoughts> wrapper this chat's saved replies use (paths differ). */
function thoughtWrapper(chat) {
    const sample = (chat.message ?? []).find((m) => m.role !== 'user' && String(m.data).startsWith('<Thoughts>'));
    if (sample && String(sample.data).startsWith('<Thoughts>\n\n')) return (t) => `<Thoughts>\n\n${t}\n\n</Thoughts>\n\n`;
    return (t) => `<Thoughts>\n${t}\n</Thoughts>\n\n`;
}

function commonPrefix(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
}

// A prompt copy of a saved reply: equal after dropping <Thoughts>, possibly
// shorter by trailing lines a bot script appends to the newest reply.
function replyMatchesCopy(saved, copy) {
    const visible = withoutThoughts(String(saved)).trim();
    const text = copy.trim();
    if (visible === text) return true;
    return text.length > 0 && visible.startsWith(text);
}

// ── Matching generations to saved chats ─────────────────────────────────────

function indexChats(characters) {
    const byFirstInput = new Map();
    let cold = 0;
    for (const character of characters) {
        for (const chat of character?.chats ?? []) {
            const messages = Array.isArray(chat?.message) ? chat.message : [];
            if (String(messages[0]?.data ?? '').startsWith(COLD_STORAGE_HEADER)) { cold++; continue; }
            const first = messages[0];
            if (!first || first.role !== 'user') continue;
            const key = String(first.data).trim();
            if (!byFirstInput.has(key)) byFirstInput.set(key, []);
            byFirstInput.get(key).push({ character, chat });
        }
    }
    return { byFirstInput, cold };
}

/** Where a saved chat sits in a prompt, and how many saved messages line up. */
function alignChat(turns, chat, start) {
    const messages = chat.message;
    let aligned = 0;
    for (; aligned < messages.length; aligned++) {
        const turn = turns[start + aligned];
        const message = messages[aligned];
        if (!turn) break;
        if (message.role === 'user') {
            if (turn.role !== 'user' || turn.text.trim() !== String(message.data).trim()) break;
        } else if (turn.role !== 'model' || !replyMatchesCopy(message.data, turn.text)) {
            break;
        }
    }
    return aligned;
}

function matchGeneration(turns, index) {
    let best = null;
    turns.forEach((turn, start) => {
        if (turn.role !== 'user') return;
        for (const candidate of index.byFirstInput.get(turn.text.trim()) ?? []) {
            const aligned = alignChat(turns, candidate.chat, start);
            if (!best || aligned > best.aligned || (aligned === best.aligned && candidate.chat.message.length > best.chat.message.length)) {
                best = { ...candidate, start, aligned };
            }
        }
    });
    return best;
}

// ── Rebuilding one chat ─────────────────────────────────────────────────────

function rebuild({ character, chat, start, last, generations, logs }) {
    const saved = chat.message;
    const turns = promptTurns(last.request_body);
    const wrap = thoughtWrapper(chat);
    const notes = [];

    // Replies that later prompts show: alternating user/model turns after
    // the saved part. The prompt tail (instructions + the newest input) ends it.
    const history = [];
    let i = start + saved.length;
    let expectUser = saved.length === 0 || saved.at(-1).role !== 'user';
    while (i < turns.length) {
        const turn = turns[i];
        if (expectUser) {
            if (turn.role !== 'user' || turns[i + 1]?.role !== 'model') break;
        } else if (turn.role !== 'model') {
            break;
        }
        history.push(turn);
        expectUser = !expectUser;
        i++;
    }
    if (history.length > 0 && history.at(-1).role === 'user') {
        history.pop();
        i--;
    }

    // Match each history reply to the generation that produced it: the best
    // prefix match among later generations, kept in order.
    const lastSavedGen = logs.prepare('SELECT max(id) AS id FROM requests WHERE chat_id = ?')
        .get(saved.findLast((m) => m.role !== 'user')?.chatId ?? '')?.id ?? 0;
    let floor = lastSavedGen;
    const messages = [];
    const mapped = [];
    for (const turn of history) {
        if (turn.role === 'user') {
            messages.push({ role: 'user', data: turn.text, time: 0, name: null, chatId: randomUUID() });
            continue;
        }
        let best = null;
        for (const gen of generations) {
            if (gen.id <= floor || gen.id >= last.id) continue;
            const visible = withoutThoughts(savedForm(gen, wrap)).trim();
            const score = commonPrefix(visible, turn.text.trim());
            if (!best || score > best.score || (score === best.score && gen.id > best.gen.id)) best = { gen, score };
        }
        const needed = Math.min(120, Math.floor(turn.text.trim().length * 0.3));
        if (!best || best.score < needed) throw new Error(`no generation matches reply ${messages.length + saved.length}`);
        floor = best.gen.id;
        mapped.push(best.gen.id);
        messages.push(replyMessage(character, best.gen, thoughtsPrefix(savedForm(best.gen, wrap)) + turn.text));
    }

    // The newest input: same distance from the prompt end as the previous
    // input in the previous generation's prompt.
    const tail = turns.slice(i);
    const previousInput = [...saved, ...messages].findLast((m) => m.role === 'user');
    const previousGenId = mapped.at(-1) ?? lastSavedGen;
    const previousGen = previousGenId ? generations.find((g) => g.id === previousGenId) ?? logs.prepare('SELECT * FROM requests WHERE id = ?').get(previousGenId) : null;
    const previousTurns = previousGen ? promptTurns(previousGen.request_body) : null;
    let input = null;
    if (previousTurns && previousInput) {
        const at = previousTurns.findLastIndex((t) => t.role === 'user' && t.text.trim() === String(previousInput.data).trim());
        const fromEnd = at >= 0 ? previousTurns.length - at : -1;
        const candidate = fromEnd > 0 ? turns[turns.length - fromEnd] : null;
        if (candidate?.role === 'user' && turns.length - fromEnd >= i) input = candidate.text;
    }
    if (input === null) {
        const userTail = tail.filter((t) => t.role === 'user');
        notes.push(`newest input not located; tail user turns: ${userTail.map((t) => preview(t.text)).join(', ')}`);
        if (userTail.length !== 1) throw new Error('cannot tell the newest input apart from the bot\'s instructions (see note)');
        input = userTail[0].text;
    }
    messages.push({ role: 'user', data: input, time: 0, name: null, chatId: randomUUID() });
    messages.push(replyMessage(character, last, savedForm(last, wrap)));

    // Lines a bot script keeps on the newest reply only (e.g. anchor
    // comments): move them from the last saved reply to the new last reply.
    const all = [...saved.map((m) => ({ ...m })), ...messages];
    const lastSavedReply = saved.findLastIndex((m) => m.role !== 'user');
    if (lastSavedReply >= 0) {
        const copy = turns[start + lastSavedReply].text.trim();
        const visible = withoutThoughts(String(saved[lastSavedReply].data));
        const extra = visible.trim().startsWith(copy) ? visible.trim().slice(copy.length) : '';
        if (extra.trim()) {
            const kept = thoughtsPrefix(String(saved[lastSavedReply].data)) + copy;
            all[lastSavedReply].data = kept;
            const final = all.findLast((m) => m.role !== 'user');
            final.data = final.data.replace(/\s*$/, '') + extra.replace(/^\s*/, '\n');
            notes.push(`moved ${extra.trim().split('\n').length} trailing line(s) the bot keeps on the newest reply`);
        }
    }
    // User messages get a time just before the reply that answered them.
    for (let k = 0; k < all.length; k++) {
        if (all[k].role === 'user' && !all[k].time) all[k].time = (all[k + 1]?.time ?? Date.now()) - 30_000;
    }
    notes.push('the newest reply is the raw model output; a bot script that rewrites it after arrival (status lines, images) runs again on the next turn or a reroll');
    return { messages: all, recovered: messages.length, mapped, notes };
}

function replyMessage(character, gen, data) {
    return {
        role: 'char',
        data,
        saying: character.chaId,
        time: gen.timestamp + (gen.duration_ms ?? 0),
        generationInfo: { model: gen.model, generationId: gen.chat_id },
        promptInfo: {},
        chatId: gen.chat_id,
    };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv);
    const saveDir = path.resolve(args.save);
    const since = parseTime(args.since, Date.now() - 24 * 3600e3);
    const until = parseTime(args.until, Date.now());

    const characters = await readSavedCharacters(saveDir);
    const index = indexChats(characters);
    const logs = new Database(path.join(saveDir, 'request-logs.db'), { readonly: true, fileMustExist: true });
    const generations = logs.prepare(`
        SELECT * FROM requests
        WHERE category = 'llm' AND success = 1 AND timestamp BETWEEN ? AND ?
          AND chat_id IS NOT NULL AND chat_id != '' AND chat_id NOT LIKE 'aux-%'
          AND request_body IS NOT NULL AND response_body IS NOT NULL
        ORDER BY id`).all(since, until);
    console.log(`generations ${kst(since)} .. ${kst(until)} KST: ${generations.length}` + (index.cold ? ` (${index.cold} cold-stored chats skipped)` : ''));

    // Newest generation per saved chat.
    const newest = new Map();
    for (const gen of generations) {
        const turns = promptTurns(gen.request_body);
        if (!turns) continue;
        const match = matchGeneration(turns, index);
        if (!match || match.aligned < match.chat.message.length) continue; // older than the saved state, or not a chat
        if (args.chat && match.chat.id !== args.chat) continue;
        newest.set(match.chat.id, { ...match, last: gen });
    }

    fs.mkdirSync(args.out, { recursive: true });
    let written = 0;
    for (const entry of newest.values()) {
        const { character, chat, last } = entry;
        if (chat.message.some((m) => m.chatId === last.chat_id)) continue; // newest reply is saved
        const label = `${character.name} / ${chat.name} (${chat.id})${character.archived ? ' [deactivated: activate it before importing]' : ''}`;
        try {
            const result = rebuild({ ...entry, generations, logs });
            console.log(`\n${label}\n  saved ${chat.message.length} + recovered ${result.recovered} = ${result.messages.length} messages, newest generation ${last.id} at ${kst(last.timestamp)}`);
            console.log(`  replies from generations: ${[...result.mapped, last.id].join(', ')}`);
            for (const note of result.notes) console.log(`  note: ${note}`);
            if (args['dry-run']) continue;
            const file = path.join(args.out, `${character.name} - ${chat.name} (복구).json`.replace(/[\\/:*?"<>|]/g, '_'));
            fs.writeFileSync(file, JSON.stringify({ type: 'risuChat', ver: 2, data: { ...chat, name: `${chat.name} (복구)`, message: result.messages } }));
            console.log(`  -> ${file}`);
            written++;
        } catch (error) {
            console.log(`\n${label}\n  NOT rebuilt: ${error.message}`);
        }
    }
    logs.close();
    console.log(`\n${written} import file(s) written${args['dry-run'] ? ' (dry run)' : ''}.`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
