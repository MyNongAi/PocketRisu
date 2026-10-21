// What other devices are doing in a chat right now (presence events of
// server/node/sync-hub.cjs): a reply being written there, and the message
// being typed there. A page with the chat open shows that reply as busy in the
// chat list, the composer and a request card, instead of an idle chat that
// suddenly gains a reply, and the typed text follows into its input (the
// user's request, 2026-10-21). Memory only; nothing here is saved.

import { get, writable, type Readable } from 'svelte/store'
import {
    addBadge,
    endStatus,
    isTerminalPhase,
    requestStatuses,
    setRemoteProgress,
    startStatus,
    type RequestPhase,
    type RequestStatusEntry,
} from '../status/requestStatus'
import { clearFinishedReply, markFinishedReply } from '../gui/chatReplyStatus'
import { language } from 'src/lang'

export interface RemoteGeneration {
    origin: string
    chatId: string
    phase: RequestPhase
    label: string
    startedAt: number
    thinkingTokens: number
    responseTokens: number
    chars: number
}

export interface PresenceEvent {
    kind: string
    origin?: string
    chatId?: string
    state?: string
    outcome?: string
    phase?: string
    label?: string
    startedAt?: number
    thinkingTokens?: number
    responseTokens?: number
    chars?: number
    text?: string
}

/** Replies other devices are writing now, by chat id. */
export const remoteGenerations = writable<Map<string, RemoteGeneration>>(new Map())

/** A device renews its reply's state every few seconds; one silent this long is taken as gone. */
export const REMOTE_GENERATION_LAPSE_MS = 15_000
/** How often a reply's progress goes out at most, and how often it is renewed when nothing changes. */
export const PRESENCE_SEND_MS = 1_000
export const PRESENCE_RENEW_MS = 5_000
/** A reply that ends and starts again within this (auto-continue, a resend) stays one reply elsewhere. */
export const PRESENCE_END_GRACE_MS = 1_500
/** Typing goes out after this pause. */
export const DRAFT_SEND_MS = 400

const RECEIVED_PHASES = new Set<RequestPhase>(['connecting', 'thinking', 'responding', 'retrying', 'stalled', 'background'])
const remoteStatusId = (chatId: string) => `remote:${chatId}`
// Request cards for another device's reply follow this page's own setting.
let showStatusCards: () => boolean = () => true
const lapseTimers = new Map<string, ReturnType<typeof setTimeout>>()

function finishRemote(chatId: string, outcome: 'done' | 'failed' | 'aborted', now: number): void {
    clearTimeout(lapseTimers.get(chatId))
    lapseTimers.delete(chatId)
    if (!get(remoteGenerations).has(chatId)) return
    remoteGenerations.update((map) => {
        const next = new Map(map)
        next.delete(chatId)
        return next
    })
    endStatus(remoteStatusId(chatId), outcome, { now })
    if (outcome === 'done') markFinishedReply(chatId)
}

function progressRemote(event: PresenceEvent, chatId: string, now: number): void {
    const phase = RECEIVED_PHASES.has(event.phase as RequestPhase) ? event.phase as RequestPhase : 'connecting'
    const generation: RemoteGeneration = {
        origin: event.origin ?? '',
        chatId,
        phase,
        label: event.label ?? '',
        startedAt: event.startedAt || now,
        thinkingTokens: event.thinkingTokens ?? 0,
        responseTokens: event.responseTokens ?? 0,
        chars: event.chars ?? 0,
    }
    const known = get(remoteGenerations).has(chatId)
    // A new reply there: the chat list's check for the last one goes, as for one written here.
    if (!known) clearFinishedReply(chatId)
    remoteGenerations.update((map) => new Map(map).set(chatId, generation))
    const statusId = remoteStatusId(chatId)
    const status = get(requestStatuses).get(statusId)
    if (showStatusCards() && (!known || !status || isTerminalPhase(status.phase))) {
        startStatus(statusId, { kind: 'main', label: generation.label, chatId, phase, now: generation.startedAt, remote: true })
        addBadge(statusId, { key: 'remote', text: language.remoteDevice ?? 'Other device', tone: 'info' })
    }
    setRemoteProgress(statusId, { phase, thinkingTokens: generation.thinkingTokens, responseTokens: generation.responseTokens }, now)
    clearTimeout(lapseTimers.get(chatId))
    lapseTimers.set(chatId, setTimeout(() => finishRemote(chatId, 'aborted', Date.now()), REMOTE_GENERATION_LAPSE_MS))
}

type DraftListener = (chatId: string, text: string) => void
const draftListeners = new Set<DraftListener>()

/** Text typed on another device for a chat; the composer showing that chat takes it. */
export function onRemoteDraft(listener: DraftListener): () => void {
    draftListeners.add(listener)
    return () => { draftListeners.delete(listener) }
}

/** A presence event from another device (this page's own are filtered out before). */
export function receivePresence(event: PresenceEvent, now = Date.now()): void {
    const chatId = event?.chatId
    if (!chatId) return
    if (event.kind === 'generation') {
        if (event.state === 'end') {
            const outcome = event.outcome === 'failed' || event.outcome === 'aborted' ? event.outcome : 'done'
            finishRemote(chatId, outcome, now)
        } else {
            progressRemote(event, chatId, now)
        }
    } else if (event.kind === 'draft' && typeof event.text === 'string') {
        for (const listener of draftListeners) listener(chatId, event.text)
    }
}

export type PresencePost = (body: Record<string, unknown>) => Promise<unknown>
let post: PresencePost | null = null

/** What a chat's reply here looks like now, for the devices that show it. */
export interface OwnReply {
    phase: RequestPhase
    label: string
    startedAt: number
    thinkingTokens: number
    responseTokens: number
    chars: number
}

export interface PresenceSources {
    /** Chats with a reply running here (generationStates), with when it started. */
    running: Readable<Map<string, { startedAt: number }>>
    /** Request cards, for the phase and counts of a model-preset reply. */
    statuses: Readable<Map<string, RequestStatusEntry>>
    /** Length of the reply text so far, for a reply without a card (the classic path). */
    replyChars?: (chatId: string) => number
    /** The reply was stopped by the user. */
    aborted?: (chatId: string) => boolean
}

/** The main request card of each chat this page writes a reply for. */
function ownCards(statuses: Map<string, RequestStatusEntry>): Map<string, RequestStatusEntry> {
    const cards = new Map<string, RequestStatusEntry>()
    for (const entry of statuses.values()) {
        if (entry.remote || !entry.chatId || entry.kind !== 'main') continue
        const current = cards.get(entry.chatId)
        if (!current || isTerminalPhase(current.phase) || (!isTerminalPhase(entry.phase) && entry.startedAt > current.startedAt)) {
            cards.set(entry.chatId, entry)
        }
    }
    return cards
}

/** Estimated tokens from characters, as the request card does before it counts. */
const estimateTokens = (chars: number) => Math.round(chars / 4)

/**
 * Tell other devices about the replies this page writes: their progress at
 * most every PRESENCE_SEND_MS, renewed every PRESENCE_RENEW_MS, and their end.
 * A reply that ends and starts again at once (auto-continue, a resend) stays
 * one reply there. Returns a stop function.
 */
export function startPresencePublisher(send: PresencePost, sources: PresenceSources, options: { statusCards?: () => boolean } = {}): () => void {
    post = send
    showStatusCards = options.statusCards ?? (() => true)
    const lastSent = new Map<string, { at: number, fingerprint: string }>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const endTimers = new Map<string, ReturnType<typeof setTimeout>>()
    let running = new Map<string, { startedAt: number }>()
    let cards = new Map<string, RequestStatusEntry>()

    const deliver = (body: Record<string, unknown>) => {
        void send(body).catch(() => { /* presence is best effort */ })
    }
    const replyOf = (chatId: string): OwnReply | null => {
        const generation = running.get(chatId)
        if (!generation) return null
        const card = cards.get(chatId)
        if (card && !isTerminalPhase(card.phase)) {
            return {
                phase: card.phase,
                label: card.label,
                startedAt: card.startedAt,
                thinkingTokens: card.thinkingTokens,
                responseTokens: card.responseTokens,
                chars: card.responseText.length,
            }
        }
        const chars = sources.replyChars?.(chatId) ?? 0
        return {
            phase: chars > 0 ? 'responding' : 'connecting',
            label: '',
            startedAt: generation.startedAt,
            thinkingTokens: 0,
            responseTokens: estimateTokens(chars),
            chars,
        }
    }
    const fingerprintOf = (reply: OwnReply) => `${reply.phase}|${reply.thinkingTokens}|${reply.responseTokens}|${reply.chars}`
    const sendProgress = (chatId: string) => {
        timers.delete(chatId)
        const reply = replyOf(chatId)
        if (!reply) return
        lastSent.set(chatId, { at: Date.now(), fingerprint: fingerprintOf(reply) })
        deliver({ kind: 'generation', chatId, state: 'progress', ...reply })
    }
    const schedule = (chatId: string) => {
        if (timers.has(chatId)) return
        const since = Date.now() - (lastSent.get(chatId)?.at ?? 0)
        timers.set(chatId, setTimeout(() => sendProgress(chatId), Math.max(0, PRESENCE_SEND_MS - since)))
    }
    const sendEnd = (chatId: string) => {
        endTimers.delete(chatId)
        if (running.has(chatId) || !lastSent.has(chatId)) return
        clearTimeout(timers.get(chatId))
        timers.delete(chatId)
        lastSent.delete(chatId)
        const card = cards.get(chatId)
        const outcome = sources.aborted?.(chatId) ? 'aborted' : card && isTerminalPhase(card.phase) ? card.phase : 'done'
        deliver({ kind: 'generation', chatId, state: 'end', outcome })
    }
    const refresh = () => {
        for (const chatId of lastSent.keys()) {
            if (!running.has(chatId) && !endTimers.has(chatId)) endTimers.set(chatId, setTimeout(() => sendEnd(chatId), PRESENCE_END_GRACE_MS))
        }
        for (const chatId of running.keys()) {
            clearTimeout(endTimers.get(chatId))
            endTimers.delete(chatId)
            const reply = replyOf(chatId)
            if (reply && lastSent.get(chatId)?.fingerprint !== fingerprintOf(reply)) schedule(chatId)
        }
    }

    const stopRunning = sources.running.subscribe((map) => {
        running = new Map([...map].filter(([chatId]) => chatId !== 'nochat'))
        refresh()
    })
    const stopCards = sources.statuses.subscribe((map) => {
        cards = ownCards(map)
        refresh()
    })
    // The text of a classic reply grows without any store saying so, and a
    // stalled one changes nothing: look again every second, renew every few.
    const tick = setInterval(() => {
        const now = Date.now()
        for (const chatId of running.keys()) {
            const sent = lastSent.get(chatId)
            const reply = replyOf(chatId)
            if (!reply) continue
            if (!sent || sent.fingerprint !== fingerprintOf(reply) || now - sent.at >= PRESENCE_RENEW_MS) schedule(chatId)
        }
    }, PRESENCE_SEND_MS)

    return () => {
        stopRunning()
        stopCards()
        clearInterval(tick)
        for (const timer of [...timers.values(), ...endTimers.values()]) clearTimeout(timer)
        post = null
    }
}

const draftTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Pass the composer's text for a chat on to other devices after a short pause. */
export function publishDraft(chatId: string, text: string): void {
    if (!post || !chatId || text.length > 64 * 1024) return
    clearTimeout(draftTimers.get(chatId))
    draftTimers.set(chatId, setTimeout(() => {
        draftTimers.delete(chatId)
        void post?.({ kind: 'draft', chatId, text }).catch(() => { /* best effort */ })
    }, DRAFT_SEND_MS))
}
