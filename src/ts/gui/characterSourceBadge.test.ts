import { describe, expect, it } from 'vitest'
import { downloadPlaceOf, localOriginOf, resolveCharacterSourceBadge } from './characterSourceBadge'

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

    it('shows 포켓 for what this install brought in without a source label', () => {
        expect(resolveCharacterSourceBadge(undefined, { stamp: 1790000000000 })).toEqual({ label: '포켓', recorded: true })
        expect(resolveCharacterSourceBadge('포켓리스')).toEqual({ label: '포켓', recorded: true })
        // A recorded label still wins over the stamp; no stamp keeps the web guess.
        expect(resolveCharacterSourceBadge('모바일웹리스', { stamp: 1790000000000, proton: true })).toEqual({ label: '모바일', recorded: true })
        expect(resolveCharacterSourceBadge(undefined, { stamp: 0, realm: true })).toEqual({ label: '웹', recorded: false })
        // Realm and Proton are where it was downloaded, not which Risu: still 포켓.
        expect(resolveCharacterSourceBadge(undefined, { proton: true })).toEqual({ label: '포켓', recorded: true })
        expect(resolveCharacterSourceBadge(undefined, { stamp: 1, realm: true })).toEqual({ label: '포켓', recorded: true })
        expect(resolveCharacterSourceBadge(undefined, localOriginOf({ createdAt: 1 }))).toEqual({ label: '포켓', recorded: true })
    })

    it('names where a bot was downloaded from, for its info popup', () => {
        expect(downloadPlaceOf({ nodeOnlyProtonSource: { file: 'bot.charx' }, realmId: 'r' })).toBe('프로톤 (bot.charx)')
        expect(downloadPlaceOf({ nodeOnlyProtonShare: 'https://drive.proton.me/urls/A#k' })).toBe('프로톤')
        expect(downloadPlaceOf({ realmId: 'r' })).toBe('렐름')
        expect(downloadPlaceOf({})).toBe('')
        expect(downloadPlaceOf(undefined)).toBe('')
    })
})
