import { describe, expect, it } from 'vitest'
import type { folder } from './storage/database.svelte'
import { assignCharactersToFolders, moveCharacterToRecoveryFolder, moveRecoveredCharacter, recoveredFolderName, releaseCharacterFromMissingFolders } from './characterRecoveryFolders'

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

describe('restored cards and bulk sorting', () => {
    it('names the restored folder after the missing-asset folder', () => {
        expect(recoveredFolderName('[에셋 누락] 모바일웹리스')).toBe('[복구] 모바일웹리스')
        expect(recoveredFolderName('프로톤')).toBeNull()
    })

    it('moves a restored card into [복구] instead of the top-level list', () => {
        const result = moveRecoveredCharacter([
            'standalone',
            folder('[에셋 누락] 모바일웹리스', ['restored', 'still-missing']),
        ], 'restored', 'new-id')
        expect(result[0]).toEqual(folder('[복구] 모바일웹리스', ['restored'], 'new-id'))
        expect(result).toContain('standalone')
        const missing = result.find((entry) => typeof entry !== 'string' && entry.name.startsWith('[에셋 누락]')) as folder
        expect(missing.data).toEqual(['still-missing'])
    })

    it('keeps a card outside a missing-asset folder where it was', () => {
        const order = [folder('Favorites', ['card'])]
        expect(moveRecoveredCharacter(order, 'card', 'new-id')).toEqual(order)
    })

    it('assigns cards from the top level and from folders, creating folders once at the top', () => {
        let id = 0
        const result = assignCharactersToFolders([
            'top-a',
            folder('[출처] 모바일웹리스', ['src-a', 'src-b']),
            'top-b',
            folder('[에셋 누락] 모바일웹리스', ['gone']),
        ], new Map([
            ['top-a', '[복구] 모바일웹리스'],
            ['src-b', '[복구] 모바일웹리스'],
            ['top-b', '[출처] 모바일웹리스'],
            ['gone', '[출처] 모바일웹리스'],
        ]), () => `id-${++id}`)
        expect(result).toEqual([
            folder('[복구] 모바일웹리스', ['top-a', 'src-b'], 'id-1'),
            folder('[출처] 모바일웹리스', ['src-a', 'top-b', 'gone']),
        ])
    })
})
