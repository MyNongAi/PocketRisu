// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'

const mocks = vi.hoisted(() => ({
    selected: 0,
    rankInputWords: vi.fn(),
}))

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: { characters: [{ chaId: 'bot-a', chatPage: 1, chats: [{ id: 'c0' }, { id: 'c1' }] }] } },
    selectedCharID: {
        subscribe(run: (value: number) => void) {
            run(mocks.selected)
            return () => {}
        },
    },
}))
vi.mock('src/ts/globalApi.svelte', () => ({ forageStorage: { realStorage: { rankInputWords: mocks.rankInputWords } } }))

import InputWordRankDialog from './InputWordRankDialog.svelte'
import { inputWordRankOpen } from 'src/ts/inputWordRank'
import { language } from 'src/lang'

const RESULT = {
    words: [['사과', 5], ['배', 2]],
    phrases: [['사과를 먹었다', 3]],
    sentences: [],
    totals: { bots: 3, deactivatedBots: 2, chats: 4, inputs: 9, copies: 6, botInputs: 1, words: 20, failed: 0, approximate: false, stopped: false },
}

let component: ReturnType<typeof mount> | undefined

function button(label: string) {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent.trim().startsWith(label))
    expect(found, label).toBeDefined()
    return found!
}
function check(label: string) {
    const found = [...document.querySelectorAll('label')].find((l) => l.textContent.trim() === label)?.querySelector('input')
    expect(found, label).toBeDefined()
    return found as HTMLInputElement
}
const listed = () => [...document.querySelectorAll('[data-input-word-rank-list] li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim())

async function open() {
    const target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(InputWordRankDialog, { target })
    flushSync()
    inputWordRankOpen.set(true)
    flushSync()
    await vi.waitFor(() => expect(document.querySelector('[data-input-word-rank-run]')).not.toBeNull())
}

beforeEach(() => {
    mocks.selected = 0
    mocks.rankInputWords.mockReset()
    localStorage.clear()
})
afterEach(async () => {
    inputWordRankOpen.set(false)
    if (component) await unmount(component)
    component = undefined
    document.body.replaceChildren()
})

describe('input word rank popup', () => {
    test('counts every bot with the deactivated ones and shows the ranks', async () => {
        mocks.rankInputWords.mockResolvedValue(RESULT)
        await open()
        check(language.inputWordRankScopeAll).click()
        await tick()
        expect(check(language.inputWordRankDeactivated).checked).toBe(true)
        check(language.inputWordRankEnglish).click()
        button(language.inputWordRankRun).click()
        await vi.waitFor(() => expect(listed()).toHaveLength(2))

        expect(mocks.rankInputWords).toHaveBeenCalledOnce()
        const [request, signal] = mocks.rankInputWords.mock.calls[0]
        expect(request).toMatchObject({ scope: 'all', deactivated: true, english: true, botInputs: true, particles: true, chaId: 'bot-a', chatId: 'c1' })
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(listed()[0]).toContain('사과')
        const summary = document.querySelector('[data-input-word-rank-summary]')!.textContent
        expect(summary).toContain(language.inputWordRankTotals(3, 2, 4, 9, 20))
        expect(summary).toContain(language.inputWordRankCopies(6))
        expect(summary).toContain(language.inputWordRankBotInputsLeft(1))

        button(language.inputWordRankPhrases).click()
        await tick()
        expect(listed()).toEqual([expect.stringContaining('사과를 먹었다')])
        button(language.inputWordRankSentences).click()
        await tick()
        expect(document.body.textContent).toContain(language.inputWordRankNoRepeats)
        expect(JSON.parse(localStorage.getItem('risu-input-word-rank')!)).toMatchObject({ scope: 'all', english: true })
    })

    test('this chat needs an open chat', async () => {
        mocks.selected = -1
        await open()
        check(language.inputWordRankScopeChat).click()
        button(language.inputWordRankRun).click()
        await tick()
        expect(document.body.textContent).toContain(language.inputWordRankOpenChat)
        expect(mocks.rankInputWords).not.toHaveBeenCalled()
    })

    test('cancel stops the request and the popup is ready again', async () => {
        let seen: AbortSignal | undefined
        mocks.rankInputWords.mockImplementation((_request, signal: AbortSignal) => {
            seen = signal
            return new Promise(() => {})
        })
        await open()
        button(language.inputWordRankRun).click()
        await vi.waitFor(() => expect(document.body.textContent).toContain(language.inputWordRankCounting))
        button(language.cancel).click()
        await tick()
        expect(seen?.aborted).toBe(true)
        expect(document.querySelector('[data-input-word-rank-run]')).not.toBeNull()
    })
})
