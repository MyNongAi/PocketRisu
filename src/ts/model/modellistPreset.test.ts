import { beforeEach, describe, expect, it, vi } from 'vitest'

// getModelInfo only needs the database and the plugin stores it consults; keep
// the rest of the app out of the import graph.
let mockDb: any
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => mockDb }))
vi.mock('../stores.svelte', () => ({ DBState: { get db() { return mockDb } } }))
vi.mock('../globalApi.svelte', () => ({ fetchNative: vi.fn() }))
vi.mock('../plugins/plugins.svelte', () => ({ customProviderStore: { subscribe: () => () => {} }, pluginV2: { providerOptions: new Map() } }))
vi.mock('../plugins/apiV3/v3.svelte', () => ({ customV3ProviderMetaStore: [] }))

const { getModelInfo } = await import('./modellist')
const { LLMFlags, LLMTokenizer } = await import('./types')

beforeEach(() => {
    // vitest.setup.ts swaps in a JSON clone that cannot copy undefined, which
    // getModelInfo clones for every id outside the built-in list. The app's
    // own helper uses structuredClone.
    vi.stubGlobal('safeStructuredClone', (value: unknown) => structuredClone(value))
    mockDb = {
        modelPresets: [
            {
                id: 'p37',
                name: 'Vertex AI 5 · gemini-3.7-flash',
                userValues: {},
                profileSnapshot: { adapterKind: 'google-gemini', capabilities: ['streaming', 'vision'], recommendedTokenizer: 'gemma', modelId: 'gemini-3.7-flash', schema: [] },
            },
            {
                id: 'ptext',
                name: 'Text only',
                userValues: {},
                tokenizerOverride: 'claude',
                profileSnapshot: { adapterKind: 'anthropic-messages', capabilities: ['streaming'], modelId: 'claude-x', schema: [] },
            },
        ],
    }
})

describe('getModelInfo for a model preset picked in the model picker', () => {
    it('shows the preset name and uses its tokenizer and image support', () => {
        const info = getModelInfo('modelpreset:::p37')
        expect(info.shortName).toBe('Vertex AI 5 · gemini-3.7-flash')
        expect(info.fullName).toBe('Vertex AI 5 · gemini-3.7-flash')
        expect(info.tokenizer).toBe(LLMTokenizer.Gemma)
        expect(info.flags).toContain(LLMFlags.hasImageInput)
    })

    it('honours a tokenizer override and leaves images off without vision', () => {
        const info = getModelInfo('modelpreset:::ptext')
        expect(info.tokenizer).toBe(LLMTokenizer.Claude)
        expect(info.flags).not.toContain(LLMFlags.hasImageInput)
    })

    it('names a deleted preset instead of showing the raw id', () => {
        expect(getModelInfo('modelpreset:::gone').shortName).toBe('Missing model preset')
    })
})
