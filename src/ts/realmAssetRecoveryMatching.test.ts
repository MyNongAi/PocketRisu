import { describe, expect, it } from 'vitest'
import { selectStrictRealmRecoveryCandidate } from './realmAssetRecoveryMatching'

const candidate = (id: string, name: string, creatorName?: string) => ({ id, name, creatorName })

describe('selectStrictRealmRecoveryCandidate', () => {
    it('accepts one normalized exact-title candidate', () => {
        const result = selectStrictRealmRecoveryCandidate(
            { name: '메리 [시스터즈]' },
            [candidate('realm-1', '메리 시스터즈')],
        )
        expect(result?.id).toBe('realm-1')
    })

    it('rejects fuzzy titles during unattended recovery', () => {
        const result = selectStrictRealmRecoveryCandidate(
            { name: '메리 시스터즈' },
            [candidate('realm-1', '메리 시스터즈 리메이크')],
        )
        expect(result).toBeNull()
    })

    it('uses a unique exact creator to disambiguate duplicate titles', () => {
        const result = selectStrictRealmRecoveryCandidate(
            { name: 'Alice', creator: 'Author A' },
            [candidate('wrong', 'alice', 'Author B'), candidate('right', 'Alice', 'author a')],
        )
        expect(result?.id).toBe('right')
    })

    it('rejects duplicate titles without a unique matching creator', () => {
        const result = selectStrictRealmRecoveryCandidate(
            { name: 'Alice' },
            [candidate('one', 'Alice', 'A'), candidate('two', 'Alice', 'B')],
        )
        expect(result).toBeNull()
    })
})
