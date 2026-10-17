import { describe, expect, it } from 'vitest'
import {
    DEFAULT_GENERATION_CONCURRENCY_POLICY,
    evaluateGenerationAdmission,
    type ActiveGenerationDescriptor,
} from './generationConcurrency'

const live = (chatKey: string, providerKey?: string): ActiveGenerationDescriptor => ({
    chatKey,
    providerKey,
    kind: 'live',
})

describe('evaluateGenerationAdmission', () => {
    it('allows two distinct chats on the same provider by default', () => {
        const first = [live('chat-a', 'openai')]
        expect(evaluateGenerationAdmission(first, live('chat-b', 'openai'))).toEqual({ allowed: true })
    })

    it('allows two distinct chats on different providers', () => {
        const first = [live('chat-a', 'openai')]
        expect(evaluateGenerationAdmission(first, live('chat-b', 'anthropic'))).toEqual({ allowed: true })
    })

    it('always rejects a second request for the same chat', () => {
        expect(evaluateGenerationAdmission(
            [live('chat-a', 'openai')],
            live('chat-a', 'anthropic'),
        )).toEqual({ allowed: false, reason: 'same-chat', limit: 1 })
    })

    it('has no cap by default: many chats on one provider at once', () => {
        const active = Array.from({ length: 12 }, (_, i) => live(`chat-${i}`, 'openai'))
        expect(DEFAULT_GENERATION_CONCURRENCY_POLICY.maxConcurrentChats).toBe(Number.POSITIVE_INFINITY)
        expect(evaluateGenerationAdmission(active, live('chat-new', 'openai'))).toEqual({ allowed: true })
    })

    it('rejects a third distinct chat at a configured global limit', () => {
        expect(evaluateGenerationAdmission(
            [live('chat-a', 'openai'), live('chat-b', 'anthropic')],
            live('chat-c', 'google'),
            { maxConcurrentChats: 2, defaultProviderLimit: 2 },
        )).toEqual({
            allowed: false,
            reason: 'global-limit',
            limit: 2,
        })
    })

    it('supports a provider-specific single-flight override', () => {
        expect(evaluateGenerationAdmission(
            [live('chat-a', 'local-llm')],
            live('chat-b', 'local-llm'),
            {
                maxConcurrentChats: 2,
                defaultProviderLimit: 2,
                providerLimits: { 'local-llm': 1 },
            },
        )).toEqual({
            allowed: false,
            reason: 'provider-limit',
            providerKey: 'local-llm',
            limit: 1,
        })
    })

    it('counts background jobs because they still occupy a chat request slot', () => {
        expect(evaluateGenerationAdmission(
            [
                { chatKey: 'chat-a', kind: 'background', providerKey: 'openai' },
                live('chat-b', 'anthropic'),
            ],
            live('chat-c', 'google'),
            { maxConcurrentChats: 2, defaultProviderLimit: 2 },
        )).toMatchObject({ allowed: false, reason: 'global-limit' })
    })
})
