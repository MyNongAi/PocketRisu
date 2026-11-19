import { describe, expect, test } from 'vitest'
import type { BaseProviderDefinition, RegistryFieldSchema, RegistryUiField } from './types'
import vertexGeminiNative from './registry/bundled/base-providers/vertex-gemini-native.json'
import vertexOpenAI from './registry/bundled/base-providers/vertex-openai.json'
import { VERTEX_LOCATIONS, isKnownVertexLocation, isVertexGlobalOnlyModel, isVertexLocationField, vertexLocationLabel } from './vertexLocations'

describe('Vertex locations', () => {
    test('values are unique and in display order', () => {
        const values = VERTEX_LOCATIONS.map(location => location.value)
        expect(values).toEqual([
            'global', 'us-central1', 'us-east1', 'us-east4', 'us-east5',
            'us-south1', 'us-west1', 'us-west4', 'asia-northeast1',
            'asia-northeast3', 'asia-east1', 'asia-southeast1',
            'europe-west1', 'europe-west4',
        ])
        expect(new Set(values).size).toBe(values.length)
    })

    test('labels use the selected locale', () => {
        for (const location of VERTEX_LOCATIONS) {
            expect(vertexLocationLabel(location.value, 'ko')).toBe(`${location.value} (${location.ko})`)
            expect(vertexLocationLabel(location.value, 'en')).toBe(`${location.value} (${location.en})`)
        }
    })

    test('recognizes the text Location field in both bundled Vertex providers only', () => {
        for (const provider of [vertexGeminiNative, vertexOpenAI] as BaseProviderDefinition[]) {
            for (const field of provider.requestSchema) {
                const ui = provider.uiSchema.fields.find(item => item.key === field.key)
                if (!ui) continue
                expect(isVertexLocationField(field, ui)).toBe(field.key === 'location')
            }
        }
        const field: RegistryFieldSchema = {
            key: 'other', type: 'string', label: 'Other',
            mapsTo: { target: 'custom', path: 'project' },
        }
        const ui: RegistryUiField = { key: 'other', widget: 'text', visibility: 'basic' }
        expect(isVertexLocationField(field, ui)).toBe(false)
        expect(isVertexLocationField({ ...field, mapsTo: { target: 'custom', path: 'location' } }, { ...ui, widget: 'select' })).toBe(false)
    })

    test('recognizes listed locations only', () => {
        for (const location of VERTEX_LOCATIONS) expect(isKnownVertexLocation(location.value)).toBe(true)
        expect(isKnownVertexLocation('')).toBe(false)
        expect(isKnownVertexLocation(undefined)).toBe(false)
        expect(isKnownVertexLocation('custom-region1')).toBe(false)
    })

    test('recognizes global-only Gemini models and publisher prefixes', () => {
        for (const id of [
            'gemini-4-argon', 'gemini-4-carbon', 'gemini-3-pro-preview',
            'gemini-3.5-flash', 'gemini-3.6-flash',
            'gemini-3.7-flash', 'gemini-3.8-flash',
            'google/gemini-4-argon',
            'publishers/google/models/gemini-4-carbon',
        ]) expect(isVertexGlobalOnlyModel(id)).toBe(true)
        expect(isVertexGlobalOnlyModel('gemini-2.5-pro')).toBe(false)
        expect(isVertexGlobalOnlyModel(undefined)).toBe(false)
    })
})
