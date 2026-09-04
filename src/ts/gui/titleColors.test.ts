import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseTitleColor, isRealmAssetRecoveryAvailable, listTitleColor, normalizeTitleColor, TITLE_COLOR_OPTIONS } from './titleColors'

const prompts = vi.hoisted(() => ({ select: vi.fn(), input: vi.fn() }))
vi.mock('../alert', () => ({ alertSelect: prompts.select, alertInput: prompts.input }))
beforeEach(() => { vi.resetAllMocks() })

describe('title colors', () => {
    it('accepts only a complete hex color and normalizes it', () => {
        expect(normalizeTitleColor(' #ABC123 ')).toBe('#abc123')
        for (const value of [undefined, null, 1, '', '#abc', 'red', 'url(https://example.test)', '#abcdef;display:none']) {
            expect(normalizeTitleColor(value)).toBeUndefined()
        }
    })
    it('uses red as the missing default without overriding a manual title color', () => {
        expect(listTitleColor('#4ade80', true)).toBe('#4ade80')
        expect(listTitleColor('', true)).toBe('#f87171')
        expect(listTitleColor('#4ade80', false)).toBe('#4ade80')
        expect(listTitleColor('', false)).toBeUndefined()
    })
    it('uses valid colors for every non-default palette entry', () => {
        for (const option of TITLE_COLOR_OPTIONS.slice(1)) {
            expect(normalizeTitleColor(option.value)).toBe(option.value)
        }
    })
    it('marks Realm recovery only from an explicit id or conclusive lookup', () => {
        expect(isRealmAssetRecoveryAvailable({ realmId: 'realm-1' })).toBe(true)
        expect(isRealmAssetRecoveryAvailable({ extentions: { risuRealmImportId: 'realm-2' } })).toBe(true)
        expect(isRealmAssetRecoveryAvailable({ sourceInfo: { realmAssetRecoveryAvailable: true } })).toBe(true)
        expect(isRealmAssetRecoveryAvailable({ sourceInfo: { realmAssetRecoveryAvailable: false } })).toBe(false)
        expect(isRealmAssetRecoveryAvailable({ realmId: '   ' })).toBe(false)
    })
    it('does not confuse cancelled/null responses with the default selection', async () => {
        for (const value of ['', 'null', 'cancel', '-1', '2abc', null, undefined]) {
            prompts.select.mockResolvedValueOnce(value)
            expect(await chooseTitleColor('#4ade80')).toBeNull()
        }
    })
    it('returns a reset only when the default is explicitly selected', async () => {
        prompts.select.mockResolvedValueOnce('0')
        expect(await chooseTitleColor('#4ade80')).toBe('')
    })
    it('validates custom input instead of saving arbitrary CSS', async () => {
        prompts.select.mockResolvedValue(String(TITLE_COLOR_OPTIONS.length))
        prompts.input.mockResolvedValueOnce('#ABC123')
        expect(await chooseTitleColor()).toBe('#abc123')
        prompts.input.mockResolvedValueOnce('red;display:none')
        expect(await chooseTitleColor()).toBeNull()
    })
})
