import { describe, expect, test } from 'vitest'
import { collectModuleRuntimeUi } from './moduleRuntime'

describe('collectModuleRuntimeUi', () => {
    test('returns an empty background after the final embedding is removed', () => {
        expect(collectModuleRuntimeUi([
            { id: 'a', backgroundEmbedding: '' },
            { id: 'b' },
        ])).toEqual({
            ids: '["a","b"]',
            hideIcon: false,
            backgroundEmbedding: '',
        })
    })

    test('combines active background embeddings and hide-icon state', () => {
        expect(collectModuleRuntimeUi([
            { id: 'a', backgroundEmbedding: '<style>a</style>' },
            null,
            { id: 'b', hideIcon: true, backgroundEmbedding: '<style>b</style>' },
        ])).toEqual({
            ids: '["a","b"]',
            hideIcon: true,
            backgroundEmbedding: '\n<style>a</style>\n\n<style>b</style>\n',
        })
    })

    test('does not collide when imported module ids contain hyphens', () => {
        expect(collectModuleRuntimeUi([{ id: 'a-b' }, { id: 'c' }]).ids)
            .not.toBe(collectModuleRuntimeUi([{ id: 'a' }, { id: 'b-c' }]).ids)
    })
})
