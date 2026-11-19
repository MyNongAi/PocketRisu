import { describe, expect, it } from 'vitest'
import vertexGemini from './registry/bundled/base-providers/vertex-gemini-native.json'
import vertexOpenAi from './registry/bundled/base-providers/vertex-openai.json'
import anthropic from './registry/bundled/profiles/anthropic/sonnet-55.json'
import type { RegistryUiSchema } from './types'
import { quickSettingKeys } from './quickSettings'

const ui = (profile: { uiSchema: unknown }) => profile.uiSchema as RegistryUiSchema

describe('quickSettingKeys', () => {
    it('includes Vertex native reasoning in order, then its request tier', () => {
        expect(quickSettingKeys(ui(vertexGemini))).toEqual(['thinkingLevel', 'includeThoughts', 'sharedRequestType'])
    })

    it('includes OpenAI-compatible reasoning and request tier', () => {
        expect(quickSettingKeys(ui(vertexOpenAi))).toEqual(['reasoning_effort', 'sharedRequestType'])
    })

    it('includes service_tier from model profiles', () => {
        expect(quickSettingKeys(ui(anthropic))).toContain('service_tier')
    })

    it('recognizes the camel-case service tier spelling', () => {
        expect(quickSettingKeys({ groups: [], fields: [{ key: 'serviceTier', widget: 'select', visibility: 'advanced' }] })).toEqual(['serviceTier'])
    })

    it('returns no keys when the profile has neither kind of field', () => {
        expect(quickSettingKeys({ groups: [], fields: [{ key: 'temperature', widget: 'slider', visibility: 'basic' }] })).toEqual([])
    })
})
