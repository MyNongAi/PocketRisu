import { describe, expect, test } from 'vitest'
import { scoreRealmCandidate } from './realmAssetRecoveryMatching'

describe('scoreRealmCandidate', () => {
    test('normalizes decorated Korean titles and rewards the same creator', () => {
        const score = scoreRealmCandidate({
            name: '[공식] 나히다',
            creator: 'Chae',
        } as any, {
            name: '공식 나히다',
            creatorName: 'chae',
            hasAsset: true,
        } as any)
        expect(score).toBe(1)
    })

    test('does not promote an unrelated title merely because it has assets', () => {
        const score = scoreRealmCandidate({ name: '나히다' } as any, {
            name: '푸리나',
            hasAsset: true,
            hasEmotion: true,
        } as any)
        expect(score).toBeLessThan(0.1)
    })
})
