import { describe, expect, it } from 'vitest'
import { loadBundledRegistry, getBundledRegistryId } from './registry/loader'
import { resolveSnapshot } from './registry/snapshot'
import { buildPreparedRequest } from './adapter/buildRequest'
import { bindingFor, matchesClassicModel, planYumiImport, readYumiVertexModels } from './yumiImport'

// Shaped like a real pm_store; every credential value is fake.
const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n'
const store = JSON.stringify({
    version: 4,
    keys: [
        { id: 'k-old', name: 'Vertex AI 4', type: 'vertex', projectId: 'old-project', clientEmail: 'old@old-project.iam.gserviceaccount.com', privateKey: FAKE_KEY },
        { id: 'k5', name: 'Vertex AI 5', type: 'vertex', projectId: 'demo-project', clientEmail: 'bot@demo-project.iam.gserviceaccount.com', privateKey: FAKE_KEY },
        { id: 'k-api', name: 'Cerebras', type: 'api', key: 'not-a-real-key' },
    ],
    modelGroups: [{ id: 'g5', name: 'Vertex AI 5' }],
    models: [
        { id: 'm37', enabled: true, name: 'gemini-3.7-flash', groupId: 'g5', modelId: 'gemini-3.7-flash', platform: 'vertex', vertexRegion: 'global', keyId: 'k5', provider: { vertexServiceTier: 'flex', thinkingLevel: 'high' }, request: { decoupled: true } },
        { id: 'm38', enabled: true, name: 'gemini-3.8-flash', groupId: 'g5', modelId: 'gemini-3.8-flash', platform: 'vertex', vertexRegion: 'global', keyId: 'k5', provider: { vertexServiceTier: 'flex', thinkingLevel: 'medium' }, request: { decoupled: true } },
        { id: 'm35', enabled: true, name: 'gemini-3.5-flash', groupId: 'g5', modelId: 'gemini-3.5-flash', platform: 'vertex', keyId: 'k5', provider: {}, request: {} },
        { id: 'off', enabled: false, name: 'disabled', groupId: 'g5', modelId: 'gemini-3.6-flash', platform: 'vertex', keyId: 'k5' },
        { id: 'oai', enabled: true, name: 'other', modelId: 'gpt-x', platform: 'openai', keyId: 'k-api' },
    ],
})
const CLASSIC = 'pluginmodel:::[PM] gemini-3.7-flash (Vertex AI 5)'

function plan(existing: any[] = []) {
    const registry = loadBundledRegistry()
    return planYumiImport({
        store,
        registries: [registry],
        registryId: getBundledRegistryId(),
        resolveSnapshot,
        existing,
        classicMain: CLASSIC,
        classicSub: CLASSIC,
        now: 1,
    })
}

describe('reading a Yumi store', () => {
    it('keeps enabled Vertex models with their tier, thinking level and credential', () => {
        const models = readYumiVertexModels(store)
        expect(models.map((model) => model.modelId)).toEqual(['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.5-flash'])
        expect(models[0]).toMatchObject({
            groupName: 'Vertex AI 5', region: 'global', serviceTier: 'flex', thinkingLevel: 'high', decoupled: true,
            credential: { projectId: 'demo-project', clientEmail: 'bot@demo-project.iam.gserviceaccount.com' },
        })
        expect(models[2]).toMatchObject({ region: 'global', serviceTier: undefined, thinkingLevel: undefined, decoupled: false })
    })

    it('recognises the plugin model the classic settings point at', () => {
        const [m37, m38] = readYumiVertexModels(store)
        expect(matchesClassicModel(m37, CLASSIC)).toBe(true)
        expect(matchesClassicModel(m38, CLASSIC)).toBe(false)
        expect(matchesClassicModel(m37, 'gemini-3.7-flash')).toBe(false)
    })

    it('tolerates a double-encoded store and garbage', () => {
        expect(readYumiVertexModels(JSON.stringify(store))).toHaveLength(3)
        expect(readYumiVertexModels('not json')).toEqual([])
        expect(readYumiVertexModels(null)).toEqual([])
    })
})

describe('planning the import', () => {
    it('creates one preset per model and picks the one in use as the default', () => {
        const result = plan()
        expect(result.presets.map((preset) => preset.name)).toEqual([
            'Vertex AI 5 · gemini-3.7-flash', 'Vertex AI 5 · gemini-3.8-flash', 'Vertex AI 5 · gemini-3.5-flash',
        ])
        expect(result.mainPresetId).toBe(result.presets[0].id)
        expect(result.subPresetId).toBe(result.presets[0].id)
        expect(bindingFor(result)).toMatchObject({ main: result.presets[0].id, sub: result.presets[0].id, separateAux: false })
    })

    it('uses the matching Vertex profile, and the generic one for a model without its own', () => {
        const [m37, m38] = plan().presets
        expect(m37.profileSnapshot.profileId).toBe('vertex-gemini-native:gemini-37-flash')
        // No 3.8 profile yet: a real Vertex profile is borrowed, never the
        // old generic one whose endpoint is empty.
        expect(m38.profileSnapshot.profileId).toMatch(/^vertex-gemini-native:gemini-/)
        expect(m38.profileSnapshot.endpoint.kind).toBe('vertex-gemini')
        expect(m38.userValues.modelId).toBe('gemini-3.8-flash')
    })

    it('keeps the three easy choices in the basic view', () => {
        const [m37] = plan().presets
        const visibility = (key: string) => m37.profileSnapshot.uiSchema.fields.find((field) => field.key === key)?.visibility
        expect(visibility('sharedRequestType')).toBe('basic')
        expect(visibility('thinkingLevel')).toBe('basic')
        expect(visibility('modelId')).toBe('basic')
        const models = m37.profileSnapshot.schema.find((field) => field.key === 'modelId')?.enum?.map((option) => option.value)
        expect(models).toEqual(expect.arrayContaining(['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.5-flash']))
    })

    it('builds the same Vertex request the plugin sent', () => {
        const [m37, m38, m35] = plan().presets
        const request = buildPreparedRequest({ preset: m37, credential: { apiKey: 'ya29.fake-token' } })
        expect(request.url).toContain('/locations/global/')
        expect(request.url).toContain('/projects/demo-project/')
        // The model id travels in the body and is appended to this base URL at send time.
        expect((request.body as any).model).toBe('gemini-3.7-flash')
        expect(request.headers['X-Vertex-AI-LLM-Shared-Request-Type']).toBe('flex')
        expect((request.body as any).generationConfig.thinkingConfig.thinkingLevel).toBe('high')

        expect((buildPreparedRequest({ preset: m38, credential: { apiKey: 'ya29.fake-token' } }).body as any)
            .generationConfig.thinkingConfig.thinkingLevel).toBe('medium')
        const plain = buildPreparedRequest({ preset: m35, credential: { apiKey: 'ya29.fake-token' } })
        expect(plain.headers['X-Vertex-AI-LLM-Shared-Request-Type']).toBeUndefined()

        expect(m37.useStreaming).toBe(true)
        expect(m37.decoupledStreaming).toBe(true)
        const sa = JSON.parse(String(m37.userValues.serviceAccountJson))
        expect(sa).toMatchObject({ type: 'service_account', project_id: 'demo-project', client_email: 'bot@demo-project.iam.gserviceaccount.com', private_key: FAKE_KEY })
    })

    it('importing again adds nothing and still points at the existing preset', () => {
        const first = plan()
        const again = plan(first.presets)
        expect(again.presets).toEqual([])
        expect(again.skipped).toHaveLength(3)
        expect(again.mainPresetId).toBe(first.presets[0].id)
    })
})
