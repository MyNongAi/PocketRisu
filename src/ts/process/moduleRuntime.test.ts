import { describe, expect, test } from 'vitest'
import { collectModuleRuntimeIds, collectModuleRuntimeUi } from './moduleRuntime'

describe('collectModuleRuntimeIds', () => {
    test('keeps simultaneous chat targets independent of the selected UI chat', () => {
        const common = { enabledModules: ['global'], moduleIntegration: 'integrated' }
        const chatA = collectModuleRuntimeIds({
            ...common,
            chatModules: ['chat-a'],
            characterModules: ['character-a'],
            embeddedModuleId: 'persona-a',
        })
        const chatB = collectModuleRuntimeIds({
            ...common,
            chatModules: ['chat-b'],
            characterModules: ['character-b'],
            embeddedModuleId: 'persona-b',
        })

        expect(chatA).toEqual(['global', 'chat-a', 'character-a', 'persona-a', 'integrated'])
        expect(chatB).toEqual(['global', 'chat-b', 'character-b', 'persona-b', 'integrated'])
    })
})

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
