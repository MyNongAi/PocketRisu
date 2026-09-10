import { describe, expect, it } from 'vitest'
import { resolveCharacterSourceBadge } from './characterSourceBadge'

describe('character source badge', () => {
    it('normalizes collection labels without confusing mobile web with pc web', () => {
        expect(resolveCharacterSourceBadge('모바일웹리스')).toEqual({ label: '모바일', recorded: true })
        expect(resolveCharacterSourceBadge('PC웹리스')).toEqual({ label: '웹', recorded: true })
        expect(resolveCharacterSourceBadge('로컬리스')).toEqual({ label: '로컬', recorded: true })
        expect(resolveCharacterSourceBadge('Mobile backup')).toEqual({ label: '모바일', recorded: true })
    })

    it('uses the web baseline for legacy entries while marking it as inferred', () => {
        expect(resolveCharacterSourceBadge(undefined)).toEqual({ label: '웹', recorded: false })
        expect(resolveCharacterSourceBadge('')).toEqual({ label: '웹', recorded: false })
        expect(resolveCharacterSourceBadge('unknown collection')).toEqual({ label: '웹', recorded: false })
    })
})
