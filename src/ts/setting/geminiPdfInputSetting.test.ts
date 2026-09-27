import { describe, expect, it } from 'vitest'
// searchIndex first: it loads the settings graph in the order the app does.
import { searchSettings } from './searchIndex'
import { advancedRequestItems } from './advancedSettingsData'
import { SettingsRoute } from '../routing'
import { languageEnglish } from 'src/lang/en'
import { languageKorean } from 'src/lang/ko'
import { helpEn } from 'src/lang/help.en'
import { helpKo } from 'src/lang/help.ko'

// GEMINI-PDF-INPUT settings wiring: one global, default-off toggle on the
// Advanced > Request & model tab, labelled and explained in en/ko.

const db: any = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : '') })
const modelInfo: any = new Proxy({}, { get: () => '' })
const ctx = { db, modelInfo, subModelInfo: modelInfo } as any

describe('Gemini PDF input setting', () => {
    const item = advancedRequestItems.find((i) => i.id === 'adv.geminiPdfInput')

    it('is a check bound to nodeOnlyGeminiPdfInput on the request tab', () => {
        expect(item).toMatchObject({
            type: 'check',
            bindKey: 'nodeOnlyGeminiPdfInput',
            labelKey: 'nodeOnlyGeminiPdfInput',
            helpKey: 'nodeOnlyGeminiPdfInput',
            showExperimental: true,
        })
        // Always visible: no condition hides it behind another switch.
        expect(item?.condition).toBeUndefined()
    })

    it('has en/ko labels and help covering cost, experimental status, roles and caching', () => {
        expect(languageEnglish.nodeOnlyGeminiPdfInput).toBeTruthy()
        expect(languageKorean.nodeOnlyGeminiPdfInput).toBeTruthy()
        const en = (helpEn as Record<string, string>).nodeOnlyGeminiPdfInput
        const ko = (helpKo as Record<string, string>).nodeOnlyGeminiPdfInput
        expect(en).toMatch(/Experimental/)
        expect(en).toMatch(/258 tokens/)
        expect(en).toMatch(/\[System\], \[User\] and \[Assistant\]/)
        expect(en).toMatch(/implicit context caching/)
        expect(ko).toMatch(/실험적/)
        expect(ko).toMatch(/258토큰/)
        expect(ko).toMatch(/\[System\], \[User\], \[Assistant\]/)
        expect(ko).toMatch(/암묵적 컨텍스트 캐싱/)
    })

    it('is findable in settings search', () => {
        const hits = searchSettings('pdf', ctx).filter((r) => r.route === SettingsRoute.Advanced)
        expect(hits.some((r) => r.subTab === 1)).toBe(true)
    })
})
