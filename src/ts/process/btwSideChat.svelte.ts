import { language } from 'src/lang'
import { getFirstMessageAtIndex } from '../firstMessage'
import type { character, Chat } from '../storage/database.svelte'
import { findCharacterbyId } from '../util'
import type { OpenAIChat } from './index.svelte'
import { captureModuleRuntimeContext } from './modules'
import { captureChatModelRoute } from './request/modelPresetBinding'
import { requestChatData, type requestDataResponse } from './request/request'
import {
    appendBtwExchange,
    BTW_LIMITS,
    buildBtwRequestMessages,
    fillBtwPlaceholders,
    selectBtwTranscript,
    stripBtwThoughts,
    type BtwExchange,
} from './btwSideChat'

// Runtime of the BTW side chat (see btwSideChat.ts for the request shape).
//
// What it deliberately leaves alone:
// - the chat object: nothing is written to it, so the chat body is not
//   re-saved and the main prompt cannot pick the side conversation up;
// - chat.scriptstate: no trigger, Lua, regex script or CBS parser runs
//   (requestChatData is told to skip the 'request' trigger);
// - the chat's generation slot (generationStates): the chat-list reply mark,
//   the Stop button and the per-chat send guard never see this request;
// - model-job recovery and reply push: the request is an auxiliary one with
//   no realChatId, so a server-side job for it is an 'aux' job, which is never
//   recovered into the chat and never pushed.
//
// The side history lives in memory per chat, mirrored to this tab's
// sessionStorage so reloading the tab (or a mobile browser restoring a
// discarded tab) keeps it. It never syncs to other devices.

export interface BtwChatState {
    history: BtwExchange[]
    pending: { question: string, answer: string } | null
    error: string
}

export type BtwAskOutcome = 'done' | 'aborted' | 'failed' | 'busy' | 'empty'

class BtwSideChatStore {
    open = $state(false)
    chats = $state<Record<string, BtwChatState>>({})
}

export const btwSideChat = new BtwSideChatStore()

const EMPTY_STATE: BtwChatState = Object.freeze({ history: [], pending: null, error: '' }) as BtwChatState
const controllers = new Map<string, AbortController>()

export function openBtwPanel(): void {
    btwSideChat.open = true
}

export function closeBtwPanel(): void {
    btwSideChat.open = false
}

export function btwChatKey(char: Pick<character, 'chaId'>, chat: Pick<Chat, 'id'>): string {
    return `${char.chaId}/${chat.id ?? 'legacy'}`
}

/** Read-only view for rendering; never creates state. */
export function getBtwChatState(key: string): BtwChatState {
    return btwSideChat.chats[key] ?? EMPTY_STATE
}

/** Creates the chat's state, restoring this tab's stored history. */
export function ensureBtwChat(key: string): BtwChatState {
    if (!btwSideChat.chats[key]) {
        btwSideChat.chats[key] = { history: readStoredHistory(key), pending: null, error: '' }
    }
    return btwSideChat.chats[key]
}

// ── Tab-scoped persistence ──────────────────────────────────────────────────
// One sessionStorage key holding the most recently used chats. Bounded by
// chat count and size: sessionStorage is shared with the session-lock
// identity, which must never fail to write because this filled the quota.

const STORAGE_KEY = 'risu-btw-side-chat'
const STORED_CHATS = 8
const STORED_CHARS = 200_000

export interface BtwStoredChat {
    key: string
    history: BtwExchange[]
}

function isExchange(value: unknown): value is BtwExchange {
    const v = value as BtwExchange
    return !!v && typeof v === 'object' && typeof v.question === 'string' && typeof v.answer === 'string' && typeof v.time === 'number'
}

function readStore(): BtwStoredChat[] {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')
        if (!Array.isArray(parsed)) return []
        return parsed
            .filter((entry) => entry && typeof entry.key === 'string' && Array.isArray(entry.history))
            .map((entry) => ({ key: entry.key, history: entry.history.filter(isExchange) }))
    } catch {
        return []
    }
}

function readStoredHistory(key: string): BtwExchange[] {
    return readStore().find((entry) => entry.key === key)?.history.slice(-BTW_LIMITS.storedExchanges) ?? []
}

/** The stored list after saving `history` for `key`, within the bounds. */
export function nextBtwStore(store: readonly BtwStoredChat[], key: string, history: readonly BtwExchange[]): BtwStoredChat[] {
    const next = store.filter((entry) => entry.key !== key)
    if (history.length > 0) next.push({ key, history: [...history] })
    while (next.length > STORED_CHATS) next.shift()
    while (next.length > 0 && JSON.stringify(next).length > STORED_CHARS) {
        // Older chats go first, then the oldest exchanges of the newest one.
        if (next.length > 1) next.shift()
        else if (next[0].history.length > 1) next[0] = { key: next[0].key, history: next[0].history.slice(1) }
        else next.shift()
    }
    return next
}

function writeStoredHistory(key: string, history: readonly BtwExchange[]): void {
    try {
        const next = nextBtwStore(readStore(), key, history)
        if (next.length === 0) sessionStorage.removeItem(STORAGE_KEY)
        else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
        // Best effort: the in-memory history still works for this page.
    }
}

// ── Request ─────────────────────────────────────────────────────────────────

/** The side request for `question`, built from the chat without changing it. */
export function buildBtwRequestFor(char: character, chat: Chat, history: readonly BtwExchange[], question: string): OpenAIChat[] {
    const context = captureModuleRuntimeContext(char, chat)
    const userName = context.userName || 'User'
    const charName = char.name || 'Character'
    const fill = (text: string | undefined) => fillBtwPlaceholders(text ?? '', charName, userName)

    const card = [
        fill(char.desc),
        char.personality ? `Personality: ${fill(char.personality)}` : '',
        char.scenario ? `Scenario: ${fill(char.scenario)}` : '',
    ].filter((part) => part.trim()).join('\n\n')

    const greeting = chat.firstMessageDisabled ? '' : getFirstMessageAtIndex(char, chat.fmIndex)
    const transcript = selectBtwTranscript(chat.message ?? [], (message) => {
        if (message.role === 'user') return userName
        if (message.saying && message.saying !== char.chaId) return findCharacterbyId(message.saying)?.name || charName
        return charName
    }, {
        fill,
        greeting: greeting ? { name: charName, text: greeting } : undefined,
    })

    return buildBtwRequestMessages({
        characterName: charName,
        characterCard: card,
        userName,
        personaPrompt: fill(context.personaPrompt),
        transcript,
        history,
        question,
    })
}

/** Final text of a request response; streams report the text so far. */
export async function readBtwResponse(response: requestDataResponse, signal: AbortSignal, onPartial: (text: string) => void): Promise<string> {
    if (response.type === 'multiline') return response.result.map(([, text]) => text).join('\n')
    if (response.type !== 'streaming') {
        if (response.type === 'fail') throw new Error(response.result)
        return response.result
    }

    const reader = response.result.getReader()
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    let text = ''
    try {
        while (!signal.aborted) {
            let chunk: ReadableStreamReadResult<{ [key: string]: string }>
            try {
                chunk = await reader.read()
            } catch (error) {
                if (signal.aborted) break
                throw error
            }
            if (chunk.value) {
                // Every chunk carries the full text so far under its first key.
                const firstKey = Object.keys(chunk.value)[0]
                if (firstKey !== undefined) {
                    text = chunk.value[firstKey] ?? text
                    onPartial(text)
                }
            }
            if (chunk.done) break
        }
    } finally {
        signal.removeEventListener('abort', cancel)
    }
    return text
}

/**
 * Asks the side question with the chat's main model route, as an auxiliary
 * request. Resolves when the exchange is recorded, stopped or failed; the
 * outcome lets the panel give an unanswered question back to its input.
 */
export async function askBtw(char: character, chat: Chat, question: string): Promise<BtwAskOutcome> {
    const text = question.trim()
    if (!text) return 'empty'
    const key = btwChatKey(char, chat)
    const state = ensureBtwChat(key)
    if (state.pending) return 'busy'

    const controller = new AbortController()
    controllers.set(key, controller)
    state.pending = { question: text, answer: '' }
    state.error = ''
    try {
        const formated = buildBtwRequestFor(char, chat, state.history, text)
        const response = await requestChatData({
            formated,
            bias: {},
            currentChar: char,
            currentChat: chat,
            // The chat's own main route (classic model or model preset),
            // captured now. Mode 'otherAx' keeps the request auxiliary: no
            // Gemini context cache keyed to this chat, sub-request logging.
            routeSnapshot: captureChatModelRoute(chat, 'model'),
            useStreaming: true,
            noMultiGen: true,
            // No tool calls: a side question must not run tools.
            tools: [],
            skipRequestTrigger: true,
        }, 'otherAx', controller.signal)
        const raw = await readBtwResponse(response, controller.signal, (partial) => {
            if (state.pending) state.pending.answer = stripBtwThoughts(partial).trim()
        })
        if (controller.signal.aborted) return 'aborted'
        const answer = stripBtwThoughts(raw).trim()
        if (!answer) throw new Error(language.btwSideChat.emptyAnswer)
        state.history = appendBtwExchange(state.history, { question: text, answer, time: Date.now() })
        writeStoredHistory(key, state.history)
        return 'done'
    } catch (error) {
        if (controller.signal.aborted) return 'aborted'
        console.error('[BTW] side question failed', error)
        state.error = error instanceof Error ? error.message : String(error)
        return 'failed'
    } finally {
        state.pending = null
        if (controllers.get(key) === controller) controllers.delete(key)
    }
}

export function stopBtw(key: string): void {
    controllers.get(key)?.abort()
}

/** Forgets the chat's side conversation (and stops a running question). */
export function clearBtw(key: string): void {
    stopBtw(key)
    const state = btwSideChat.chats[key]
    if (state) {
        state.history = []
        state.error = ''
    }
    writeStoredHistory(key, [])
}
