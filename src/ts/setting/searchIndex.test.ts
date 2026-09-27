import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { searchSettings } from './searchIndex'
import { SettingsRoute } from '../routing'
import { changeLanguage } from 'src/lang'

// A settings entry is reachable two ways and they cover different text: the
// declarative items index each SETTING's label/keywords/help, while the manifest
// indexes the TAB name (which is only breadcrumb text on the declarative side).
// Searching the name printed on the tab must find it.
//
// Conditions across the other settings pages dereference arbitrary db fields
// (db.aiModel.startsWith(...), db.someList.includes(...)). A proxy answering ''
// for anything unset satisfies both string and array-ish probes, so the search
// walks every source the way it does in the app.
const db: any = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : '') })
const modelInfo: any = new Proxy({}, { get: () => '' })
const ctx = { db, modelInfo, subModelInfo: modelInfo } as any

/** Sub-tab indices of every Model Preset hit. Locale-independent, unlike the
 * label — the test runtime has no locale set, so labels come back in English. */
function moduleTabHits(query: string): number[] {
    return searchSettings(query, ctx)
        .filter((r) => r.route === SettingsRoute.ModelPreset && r.subTab === 3)
        .map((r) => r.subTab!)
}

describe('searchSettings — module binding tab', () => {
    test('finds the tab by the name shown on it', () => {
        expect(moduleTabHits('모듈 분리 바인딩').length).toBeGreaterThan(0)
    })

    test('finds it without spaces', () => {
        expect(moduleTabHits('모듈분리바인딩').length).toBeGreaterThan(0)
    })

    test('finds it in English', () => {
        expect(moduleTabHits('module binding').length).toBeGreaterThan(0)
    })

    test('finds the toggle setting via its own keywords', () => {
        expect(moduleTabHits('모듈별').length).toBeGreaterThan(0)
    })

    test('an unrelated query does not hit the tab', () => {
        expect(moduleTabHits('persona')).toEqual([])
    })
})

describe('searchSettings — accessibility navigation', () => {
    beforeAll(() => changeLanguage('ko'))
    afterAll(() => changeLanguage('en'))

    test('finds the new-message auto-scroll toggle in the scroll tab', () => {
        const result = searchSettings('새 메시지로 자동 스크롤', ctx)
            .find((item) => item.key.endsWith(':acc.autoScrollToNewMessage'))
        expect(result).toMatchObject({
            route: SettingsRoute.Accessibility,
            subTab: 1,
            itemId: 'acc.autoScrollToNewMessage',
        })
    })
})

/** Route + sub-tab of every hit for a setting id. */
function hitsFor(query: string, itemId: string) {
    return searchSettings(query, ctx)
        .filter((r) => r.itemId === itemId)
        .map((r) => ({ route: r.route, subTab: r.subTab }))
}

describe('searchSettings — advanced settings tabs and moved items', () => {
    test('advanced items land on their tab', () => {
        expect(hitsFor('lorebook', 'adv.lbDepth')).toEqual([{ route: SettingsRoute.Advanced, subTab: 0 }])
        expect(hitsFor('retr', 'adv.retries')).toEqual([{ route: SettingsRoute.Advanced, subTab: 1 }])
        expect(hitsFor('dynamic asset', 'adv.dynAssets')).toEqual([{ route: SettingsRoute.Advanced, subTab: 2 }])
        expect(hitsFor('developer', 'adv.devTools')).toEqual([{ route: SettingsRoute.Advanced, subTab: 3 }])
    })

    test('external asset items land on the assets tab', () => {
        expect(hitsFor('asset window', 'adv.externalAssetRecentOutputs')).toEqual([{ route: SettingsRoute.Advanced, subTab: 2 }])
    })

    test('items moved out of Advanced point at their new page', () => {
        expect(hitsFor('bookmark', 'adv.bookmark')).toEqual([{ route: SettingsRoute.Accessibility, subTab: 0 }])
        expect(hitsFor('scroll', 'adv.scrollToActive')).toEqual([{ route: SettingsRoute.Accessibility, subTab: 2 }])
        expect(hitsFor('height', 'adv.heightMode')).toEqual([{ route: SettingsRoute.Display, subTab: 1 }])
        expect(hitsFor('css', 'adv.cssErr')).toEqual([{ route: SettingsRoute.Display, subTab: 0 }])
        expect(hitsFor('image', 'adv.newImgBeta')).toEqual([{ route: SettingsRoute.InlayImageGallery, subTab: 1 }])
    })
})
