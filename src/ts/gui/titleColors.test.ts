import { describe, expect, it } from 'vitest'
import { isRealmAssetRecoveryAvailable, isRedListTitle, listTitleColor, normalizeTitleColor, shownMissingAssetCount, TITLE_COLOR_OPTIONS } from './titleColors'
import { setMissingMarkHidden, withoutMissingModules } from './itemInfo'

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
    it('calls a title red when it shows red: its own red colour, or missing assets without a colour', () => {
        expect(isRedListTitle('#F87171')).toBe(true)
        expect(isRedListTitle(undefined, true)).toBe(true)
        expect(isRedListTitle('#4ade80', true)).toBe(false)
        expect(isRedListTitle(undefined, false)).toBe(false)
        expect(isRedListTitle('#fb923c')).toBe(false)
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
    it('offers white among the swatches', () => {
        expect(TITLE_COLOR_OPTIONS.some((option) => option.value === '#ffffff')).toBe(true)
    })
    it('hides the missing mark at the count it was turned off at, and shows it again when more go missing', () => {
        expect(shownMissingAssetCount({ missingAssetCount: 3 })).toBe(3)
        expect(shownMissingAssetCount(undefined)).toBe(0)
        const owner = { sourceInfo: { missingAssetCount: 3 } as { missingAssetCount: number, nodeOnlyMissingMarkHidden?: number } }
        setMissingMarkHidden(owner, true)
        expect(owner.sourceInfo.nodeOnlyMissingMarkHidden).toBe(3)
        expect(shownMissingAssetCount(owner.sourceInfo)).toBe(0)
        owner.sourceInfo.missingAssetCount = 2
        expect(shownMissingAssetCount(owner.sourceInfo)).toBe(0)
        owner.sourceInfo.missingAssetCount = 5
        expect(shownMissingAssetCount(owner.sourceInfo)).toBe(5)
        setMissingMarkHidden(owner, false)
        expect(owner.sourceInfo.nodeOnlyMissingMarkHidden).toBeUndefined()
        setMissingMarkHidden({}, true) // no source info: nothing to hide
    })
    it('clears only the modules that no longer exist from a bot', () => {
        expect(withoutMissingModules(['a', 'gone', 'b'], new Set(['a', 'b']))).toEqual(['a', 'b'])
        expect(withoutMissingModules(undefined, new Set(['a']))).toEqual([])
    })
})
