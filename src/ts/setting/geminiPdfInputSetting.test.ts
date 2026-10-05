import { describe, expect, it } from 'vitest'
// searchIndex first: it loads the settings graph in the order the app does.
import { searchSettings } from './searchIndex'
import { advancedRequestItems } from './advancedSettingsData'
import { geminiPdfInputItems } from './geminiPdfSettingsData'
import { SettingsRoute } from '../routing'
import { languageEnglish } from 'src/lang/en'
import { languageKorean } from 'src/lang/ko'
import { helpEn } from 'src/lang/help.en'
import { helpKo } from 'src/lang/help.ko'

// GEMINI-PDF-INPUT settings wiring: one global, default-off toggle on
// Chat bot > Model (moved from Advanced > Request, 2026-10-06), labelled and
// explained in en/ko.

const db: any = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : '') })
const modelInfo: any = new Proxy({}, { get: () => '' })
const ctx = { db, modelInfo, subModelInfo: modelInfo } as any

describe('Gemini PDF input setting', () => {
    const item = geminiPdfInputItems.find((i) => i.id === 'adv.geminiPdfInput')

    it('is a check bound to nodeOnlyGeminiPdfInput on the chat bot model tab, not in Advanced', () => {
        expect(advancedRequestItems.some((i) => i.id.startsWith('adv.geminiPdf'))).toBe(false)
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
        const hits = searchSettings('pdf', ctx).filter((r) => r.route === SettingsRoute.ChatBot)
        expect(hits.some((r) => r.subTab === 0)).toBe(true)
    })
})

describe('Gemini PDF media resolution setting', () => {
    const index = geminiPdfInputItems.findIndex((i) => i.id === 'adv.geminiPdfMediaResolution')
    const item = geminiPdfInputItems[index]

    it('is a dropdown right under the PDF toggle: default (not set), low, medium, high', () => {
        expect(geminiPdfInputItems[index - 1]?.id).toBe('adv.geminiPdfInput')
        expect(item).toMatchObject({
            type: 'select',
            bindKey: 'nodeOnlyGeminiPdfMediaResolution',
            labelKey: 'nodeOnlyGeminiPdfMediaResolution',
            helpKey: 'nodeOnlyGeminiPdfMediaResolution',
        })
        // The first option is the fallback default (SelectOption convention).
        expect(item.options?.selectOptions?.map((o) => o.value)).toEqual(['default', 'low', 'medium', 'high'])
    })

    it('shows only while the PDF toggle is on', () => {
        const at = (value: unknown) => item.condition!({ ...ctx, db: { nodeOnlyGeminiPdfInput: value } } as any)
        expect(at(true)).toBe(true)
        expect(at(false)).toBe(false)
        expect(at(undefined)).toBe(false)
    })

    it('has Korean option labels and en/ko help on tokens and small Korean text', () => {
        expect(item.options?.selectOptions?.map((o) => (languageKorean as Record<string, any>)[o.labelKey!]))
            .toEqual(['기본 (지정 안 함)', '낮음', '중간', '높음'])
        for (const o of item.options?.selectOptions ?? []) {
            expect((languageEnglish as Record<string, any>)[o.labelKey!]).toBeTruthy()
        }
        expect(languageKorean.nodeOnlyGeminiPdfMediaResolution).toBeTruthy()
        expect(languageEnglish.nodeOnlyGeminiPdfMediaResolution).toBeTruthy()
        const ko = (helpKo as Record<string, string>).nodeOnlyGeminiPdfMediaResolution
        const en = (helpEn as Record<string, string>).nodeOnlyGeminiPdfMediaResolution
        expect(ko).toMatch(/토큰/)
        expect(ko).toMatch(/작은 한국어 글자/)
        expect(ko).toMatch(/실제 채팅에서 먼저/)
        expect(en).toMatch(/fewer tokens/)
        expect(en).toMatch(/small Korean text/)
    })

    it('is findable in settings search while the toggle is on', () => {
        const on = { ...ctx, db: new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : key === 'nodeOnlyGeminiPdfInput' ? true : '') }) } as any
        const ids = (c: any) => searchSettings('해상도', c).map((r) => r.itemId)
        expect(ids(on)).toContain('adv.geminiPdfMediaResolution')
        expect(ids(ctx)).not.toContain('adv.geminiPdfMediaResolution')
    })
})
