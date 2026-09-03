import { describe, expect, it } from 'vitest'
import type { folder } from './storage/database.svelte'
import { moveCharacterToRecoveryFolder, releaseCharacterFromMissingFolders } from './characterRecoveryFolders'

const folder = (name: string, data: string[], id = name): folder => ({ id, name, data, color: '' })

describe('character recovery folders', () => {
    it('releases a recovered card without hiding it from the sidebar', () => {
        const result = releaseCharacterFromMissingFolders([
            folder('[에셋 누락] 모바일웹리스', ['recovered', 'still-missing']),
            'standalone',
        ], 'recovered')
        expect(result[0]).toBe('recovered')
        expect((result[1] as folder).data).toEqual(['still-missing'])
    })

    it('preserves an existing non-missing folder membership', () => {
        const result = releaseCharacterFromMissingFolders([
            folder('[에셋 누락] 모바일웹리스', ['card']),
            folder('Favorites', ['card']),
        ], 'card')
        expect(result).toEqual([folder('Favorites', ['card'])])
    })

    it('moves an unresolved card into a topmost Proton folder', () => {
        const result = moveCharacterToRecoveryFolder([
            folder('[에셋 누락] 모바일웹리스', ['card', 'other']),
            folder('프로톤', ['old'], 'proton-id'),
            'loose',
        ], 'card', '프로톤', 'unused-id')
        expect(result[0]).toEqual(folder('프로톤', ['card', 'old'], 'proton-id'))
        expect((result[1] as folder).data).toEqual(['other'])
        expect(result).not.toContain('card')
    })
})
