import { describe, expect, it } from 'vitest'
import pkg from './chat-content-version.cjs'

const { evaluateChatVersion } = pkg as {
    evaluateChatVersion: (options: {
        expectedEtag?: string
        currentEtag?: string | null
        renewed?: boolean
        hasCurrentPayload?: boolean
        hasCatalogStub?: boolean
    }) => { ok: boolean, repairMissingPayload: boolean, reason?: string }
}

describe('chat content version recovery', () => {
    it('repairs a catalog stub whose server payload is missing', () => {
        expect(evaluateChatVersion({
            expectedEtag: 'old-full-chat',
            currentEtag: null,
            hasCurrentPayload: false,
            hasCatalogStub: true,
        })).toEqual({ ok: true, repairMissingPayload: true })
    })

    it('does not resurrect a chat deleted from both stores', () => {
        expect(evaluateChatVersion({
            expectedEtag: 'old-full-chat',
            currentEtag: null,
            hasCurrentPayload: false,
            hasCatalogStub: false,
        })).toMatchObject({ ok: false, reason: 'missing' })
    })

    it('still rejects a real same-chat version conflict', () => {
        expect(evaluateChatVersion({
            expectedEtag: 'older',
            currentEtag: 'newer',
            hasCurrentPayload: true,
            hasCatalogStub: true,
        })).toMatchObject({ ok: false, reason: 'changed' })
    })

    it('allows another chat with no stale precondition', () => {
        expect(evaluateChatVersion({
            currentEtag: 'chat-b-current',
            hasCurrentPayload: true,
            hasCatalogStub: true,
        })).toEqual({ ok: true, repairMissingPayload: false })
    })
})
