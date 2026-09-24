import { describe, expect, it } from 'vitest'
import { matchesCatalogText } from './catalogSearch'

describe('bounded Korean catalog search', () => {
    it.each([
        ['홍길동', 'ㅎㄱㄷ', true],
        ['홍길동', '홍ㄱㄷ', true],
        ['넬리 섬', 'ㄴㄹㅅ', true],
        ['넬리 섬', '넬리섬', true],
        ['넬리섬', '넬리 섬', true],
        ['홍길동', '홍기', true],
        ['홍길동', '홍김', false],
        ['홍길동', 'ㅅㄱㄷ', false],
        ['메이드 로봇', 'ㅁㅇㄷㄹㅂ', true],
        ['Rem & Ram', 'REM', true],
        ['C++ [2]', '[2]', true],
        ['plain title', '.*', false],
        ['plain title', '[', false],
        ['가나다'.normalize('NFD'), 'ㄱㄴㄷ', true],
        ['가나다', 'ᄀᄂᄃ', true],
        ['무관한 이름', '홍길동', false],
        ['', '   ', true],
        ['', 'missing', false],
    ])('%s / %s → %s', (target, query, expected) => {
        expect(matchesCatalogText(target, query)).toBe(expected)
    })

    it('does not broaden completed non-final syllables or truncate long queries', () => {
        expect(matchesCatalogText('홍길동', '호길동')).toBe(false)
        expect(matchesCatalogText('a'.repeat(300), 'a'.repeat(301))).toBe(false)
    })

    it('remains correct after query-cache eviction and across 2000 rows', () => {
        for (let index = 0; index < 100; index++) matchesCatalogText('same', `query-${index}`)
        const rows = Array.from({ length: 2000 }, (_, i) => i % 2 ? `넬리 섬 ${i}` : `기타 ${i}`)
        expect(rows.filter(title => matchesCatalogText(title, 'ㄴㄹㅅ'))).toHaveLength(1000)
    })
})
