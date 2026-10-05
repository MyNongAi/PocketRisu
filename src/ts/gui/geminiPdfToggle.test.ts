import { beforeEach, describe, expect, it, vi } from 'vitest'

let mockDb: any
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mockDb,
}))
vi.mock('src/ts/model/modellist', () => ({
    LLMFormat: { GoogleCloud: 'google', VertexAIGemini: 'vertex', Anthropic: 'anthropic' },
    getModelInfo: (id: string) => ({ format: id.startsWith('gemini') ? 'google' : id.startsWith('vertex') ? 'vertex' : 'anthropic' }),
}))

import { chatSendsToNativeGemini } from './geminiPdfToggle'

const preset = (id: string, adapterKind: string) => ({ id, name: id, profileSnapshot: { adapterKind } })

beforeEach(() => {
    mockDb = {
        aiModel: 'claude-sonnet',
        modelPresets: [preset('g', 'google-gemini'), preset('o', 'openai-compatible')],
        nodeOnlyModelModeLock: 'none',
    }
})

describe('chatSendsToNativeGemini', () => {
    it('is true for a google-gemini model preset, false for another adapter', () => {
        mockDb.aiModel = 'modelpreset:::g'
        expect(chatSendsToNativeGemini({} as any)).toBe(true)
        mockDb.aiModel = 'modelpreset:::o'
        expect(chatSendsToNativeGemini({} as any)).toBe(false)
        // A chat bound to its own preset bundle.
        expect(chatSendsToNativeGemini({ useModelPreset: true, modelBinding: { main: 'g' } } as any)).toBe(true)
    })

    it('is true for classic Google AI and Vertex Gemini models only', () => {
        mockDb.aiModel = 'gemini-2.5-pro'
        expect(chatSendsToNativeGemini({} as any)).toBe(true)
        mockDb.aiModel = 'vertex-gemini-2.5-pro'
        expect(chatSendsToNativeGemini({} as any)).toBe(true)
        mockDb.aiModel = 'claude-sonnet'
        expect(chatSendsToNativeGemini({} as any)).toBe(false)
    })

    it('is false while the chat has no model to send to', () => {
        mockDb.aiModel = 'modelpreset:::gone'
        expect(chatSendsToNativeGemini({} as any)).toBe(false)
    })
})
