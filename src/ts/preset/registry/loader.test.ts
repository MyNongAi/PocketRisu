import { describe, expect, test } from 'vitest'
import { getBundledRegistryId, loadBundledRegistry } from './loader'

const EXPECTED_BASE_PROVIDER_IDS = [
    'anthropic',
    'bedrock',
    'deepinfra',
    'deepseek',
    'google',
    'nanogpt',
    'ollama',
    'openai',
    'openai-compatible',
    'openrouter',
    'vercel',
    'vertex-openai',
]

const EXPECTED_PROFILE_IDS = [
    'anthropic:standard',
    'bedrock:openai-compatible',
    'deepinfra:openai-compatible',
    'deepseek:openai-compatible',
    'google:standard',
    'nanogpt:openai-compatible',
    'ollama:openai-compatible-local',
    'openai-compatible:custom',
    'openai-compatible:custom-noauth',
    'openai:standard',
    'openrouter:openai-compatible',
    'vercel:openai-compatible',
    'vertex-openai:standard',
]

describe('loadBundledRegistry', () => {
    test('produces a v4 registry cache with the bundled registry id', () => {
        const registry = loadBundledRegistry()
        expect(registry.schemaVersion).toBe(4)
        expect(Object.keys(registry.registries)).toEqual([getBundledRegistryId()])
    })

    test('exposes every bundled base provider keyed by id', () => {
        const registry = loadBundledRegistry()
        const baseProviders = registry.registries[getBundledRegistryId()]?.baseProviders ?? {}
        expect(Object.keys(baseProviders).sort()).toEqual(EXPECTED_BASE_PROVIDER_IDS)
        for (const id of EXPECTED_BASE_PROVIDER_IDS) {
            expect(baseProviders[id]?.id).toBe(id)
            expect(baseProviders[id]?.requestSchema.length).toBeGreaterThan(0)
        }
    })

    test('exposes every bundled profile keyed by id', () => {
        const registry = loadBundledRegistry()
        const profiles = registry.registries[getBundledRegistryId()]?.profiles ?? {}
        expect(Object.keys(profiles).sort()).toEqual(EXPECTED_PROFILE_IDS)
        for (const id of EXPECTED_PROFILE_IDS) {
            expect(profiles[id]?.id).toBe(id)
            expect(profiles[id]?.profileTier).toBe('standard')
        }
    })

    test('returns a stable singleton on repeated load', () => {
        const first = loadBundledRegistry()
        const second = loadBundledRegistry()
        expect(second).toBe(first)
    })
})
