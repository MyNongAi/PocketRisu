import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'

vi.mock('src/lang', () => ({ language: { remoteDevice: 'Other device' } }))

const { receivePresence, remoteGenerations, onRemoteDraft, startPresencePublisher, publishDraft, REMOTE_GENERATION_LAPSE_MS, PRESENCE_SEND_MS, PRESENCE_END_GRACE_MS, DRAFT_SEND_MS } = await import('./remoteActivity')
const { requestStatuses, startStatus, appendText, endStatus, clearStatus } = await import('../status/requestStatus')
const { finishedReplies, clearFinishedReply } = await import('../gui/chatReplyStatus')

beforeEach(() => {
    vi.useFakeTimers()
    remoteGenerations.set(new Map())
    requestStatuses.set(new Map())
    clearFinishedReply('x')
})

afterEach(() => {
    vi.useRealTimers()
})

describe('a reply another device is writing', () => {
    it('shows as running with its counts, then as finished', () => {
        receivePresence({ kind: 'generation', origin: 'phone', chatId: 'x', state: 'progress', phase: 'responding', label: 'Model', startedAt: 1000, responseTokens: 42, chars: 120 }, 2000)
        expect(get(remoteGenerations).get('x')).toMatchObject({ origin: 'phone', phase: 'responding', responseTokens: 42 })
        const status = get(requestStatuses).get('remote:x')!
        expect(status).toMatchObject({ remote: true, chatId: 'x', kind: 'main', label: 'Model', phase: 'responding', responseTokens: 42 })
        expect(status.badges.map((b) => b.text)).toEqual(['Other device'])

        receivePresence({ kind: 'generation', origin: 'phone', chatId: 'x', state: 'end', outcome: 'done' }, 3000)
        expect(get(remoteGenerations).has('x')).toBe(false)
        expect(get(requestStatuses).get('remote:x')?.phase).toBe('done')
        expect(get(finishedReplies).has('x')).toBe(true)
    })

    it('stops showing when the device goes quiet', () => {
        receivePresence({ kind: 'generation', origin: 'phone', chatId: 'x', state: 'progress', phase: 'connecting' })
        vi.advanceTimersByTime(REMOTE_GENERATION_LAPSE_MS + 1)
        expect(get(remoteGenerations).has('x')).toBe(false)
        expect(get(requestStatuses).get('remote:x')?.phase).toBe('aborted')
        // a reply that vanished is not marked as arrived
        expect(get(finishedReplies).has('x')).toBe(false)
    })

    it('hands typed text to the composers listening', () => {
        const heard: [string, string][] = []
        const stop = onRemoteDraft((chatId, text) => heard.push([chatId, text]))
        receivePresence({ kind: 'draft', origin: 'phone', chatId: 'x', text: 'hello' })
        stop()
        receivePresence({ kind: 'draft', origin: 'phone', chatId: 'x', text: 'ignored' })
        expect(heard).toEqual([['x', 'hello']])
    })
})

describe('telling other devices', () => {
    const setup = (replyChars?: (chatId: string) => number) => {
        const sent: any[] = []
        const running = writable(new Map<string, { startedAt: number }>())
        const stop = startPresencePublisher(async (body) => { sent.push(body) }, { running, statuses: requestStatuses, replyChars })
        return { sent, running, stop }
    }

    it("sends a model-preset reply's progress at most once a second, and its end", async () => {
        const { sent, running, stop } = setup()
        running.set(new Map([['x', { startedAt: Date.now() }]]))
        startStatus('g1', { kind: 'main', label: 'Model', chatId: 'x', now: Date.now() })
        appendText('g1', { response: 'Hel' }, Date.now())
        appendText('g1', { response: 'lo' }, Date.now())
        await vi.advanceTimersByTimeAsync(PRESENCE_SEND_MS)
        const progress = sent.filter((b) => b.state === 'progress')
        expect(progress.length).toBeGreaterThanOrEqual(1)
        expect(progress.length).toBeLessThanOrEqual(2)
        expect(progress.at(-1)).toMatchObject({ kind: 'generation', chatId: 'x', phase: 'responding', label: 'Model', chars: 5 })

        endStatus('g1', 'done', { now: Date.now() })
        running.set(new Map())
        await vi.advanceTimersByTimeAsync(PRESENCE_END_GRACE_MS)
        expect(sent.at(-1)).toEqual({ kind: 'generation', chatId: 'x', state: 'end', outcome: 'done' })
        // another device's reply shown here is not echoed back
        receivePresence({ kind: 'generation', origin: 'phone', chatId: 'y', state: 'progress', phase: 'responding' })
        await vi.advanceTimersByTimeAsync(PRESENCE_SEND_MS * 2)
        expect(sent.some((b) => b.chatId === 'y')).toBe(false)
        clearStatus('g1')
        stop()
    })

    it('measures a reply without a request card in the chat, and keeps one reply across a resend', async () => {
        let chars = 0
        const { sent, running, stop } = setup(() => chars)
        running.set(new Map([['x', { startedAt: 1 }]]))
        await vi.advanceTimersByTimeAsync(PRESENCE_SEND_MS)
        expect(sent.at(-1)).toMatchObject({ chatId: 'x', state: 'progress', phase: 'connecting', chars: 0 })
        chars = 400
        await vi.advanceTimersByTimeAsync(PRESENCE_SEND_MS * 2)
        expect(sent.at(-1)).toMatchObject({ phase: 'responding', chars: 400, responseTokens: 100 })

        // auto-continue: ends and starts again at once
        running.set(new Map())
        running.set(new Map([['x', { startedAt: 2 }]]))
        await vi.advanceTimersByTimeAsync(PRESENCE_END_GRACE_MS * 2)
        expect(sent.some((b) => b.state === 'end')).toBe(false)

        running.set(new Map())
        await vi.advanceTimersByTimeAsync(PRESENCE_END_GRACE_MS)
        expect(sent.at(-1)).toEqual({ kind: 'generation', chatId: 'x', state: 'end', outcome: 'done' })
        stop()
    })

    it('passes typed text on after a pause, only the last of a burst', async () => {
        const { sent, stop } = setup()
        publishDraft('x', 'h')
        publishDraft('x', 'hi')
        await vi.advanceTimersByTimeAsync(DRAFT_SEND_MS)
        expect(sent).toEqual([{ kind: 'draft', chatId: 'x', text: 'hi' }])
        stop()
    })
})
