import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db, translate, translateHTML } = vi.hoisted(() => ({
    db: { translatorType: 'google' as string, translator: 'ko' },
    translate: vi.fn(async (text: string) => `KO(${text})`),
    translateHTML: vi.fn(async (text: string) => `KH(${text})`),
}))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => db }))
vi.mock('./translator/translator', () => ({ translate, translateHTML }))

import { translateKoView } from './koViewTranslate'

beforeEach(() => {
    translate.mockClear()
    translateHTML.mockClear()
})

describe('KO-VIEW translation', () => {
    it('sends other translators one line at a time with macros and tags masked', async () => {
        db.translatorType = 'google'
        const out = await translateKoView('Hello {{char}}\n\nSee <b>this</b>\nBye')
        expect(out).toBe('KO(Hello {{char}})\n\nKO(See <b>this</b>)\nKO(Bye)')
        expect(translate.mock.calls.map((call) => call[0])).toEqual(['Hello ⟦0⟧', 'See ⟦0⟧this⟦1⟧', 'Bye'])
        expect(translateHTML).not.toHaveBeenCalled()
    })

    it('sends the LLM translator whole paragraphs, line breaks kept, through translateHTML', async () => {
        db.translatorType = 'llm'
        const out = await translateKoView('- one\n- two\n\nLast {{user}}')
        expect(out).toBe('KH(- one\n- two)\n\nKH(Last {{user}})')
        expect(translateHTML.mock.calls.map((call) => call[0])).toEqual(['- one\n- two', 'Last {{user}}'])
        expect(translate).not.toHaveBeenCalled()
    })

    it('refuses without a translator and fails on an untranslated answer', async () => {
        db.translatorType = 'none'
        await expect(translateKoView('Hello')).rejects.toThrow('translator-none')
        db.translatorType = 'google'
        db.translator = ''
        await expect(translateKoView('Hello')).rejects.toThrow('translator-none')
        db.translator = 'ko'
        translate.mockImplementationOnce(async (text: string) => text)
        await expect(translateKoView('Hello')).rejects.toThrow('translation-failed')
        expect(await translateKoView('')).toBe('')
    })

    it('keeps unchanged names and labels when another line translates', async () => {
        db.translatorType = 'google'
        translate.mockImplementation(async (text: string) => text === 'Hello' ? '안녕' : text)
        expect(await translateKoView('Modernia\nHP: 100\nHello')).toBe('Modernia\nHP: 100\n안녕')
    })

    it('fails when no translatable line changes', async () => {
        db.translatorType = 'google'
        translate.mockImplementation(async (text: string) => text)
        await expect(translateKoView('Modernia\nHP: 100')).rejects.toThrow('translation-failed')
    })

    it('still rejects translator error results', async () => {
        db.translatorType = 'google'
        translate.mockImplementationOnce(async () => 'ERR:: unavailable')
        await expect(translateKoView('Hello')).rejects.toThrow('translation-failed')
    })
})
