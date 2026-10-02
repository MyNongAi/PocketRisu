// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import type { character, Chat } from 'src/ts/storage/database.svelte'

const mocks = vi.hoisted(() => ({
    requestChatData: vi.fn(),
}))

vi.mock('src/ts/process/request/request', () => ({ requestChatData: mocks.requestChatData }))
vi.mock('src/ts/process/request/modelPresetBinding', () => ({
    captureChatModelRoute: () => ({ kind: 'classic', aiModel: 'main-model', providerKey: 'classic:main-model', fallbackModels: [] }),
}))
vi.mock('src/ts/process/modules', () => ({
    captureModuleRuntimeContext: (char: character, chat: Chat) => ({ character: char, chat, userName: 'Me', personaPrompt: '' }),
}))
vi.mock('src/ts/util', () => ({ findCharacterbyId: () => ({ name: 'Other' }) }))
vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: { sendKeyPC: 'enter', sendKeyMobile: 'enter' } } }))

import BtwSidePanel from './BtwSidePanel.svelte'
import { btwSideChat } from 'src/ts/process/btwSideChat.svelte'
import { language } from 'src/lang'

const character = { chaId: 'aria', name: 'Aria', desc: 'A knight.', firstMessage: '', alternateGreetings: [] } as unknown as character
let seq = 0
const mounted: unknown[] = []

function makeChat(): Chat {
    seq++
    return { id: `panel-chat-${seq}`, name: 'c', note: '', localLore: [], message: [{ role: 'user', data: 'hello' }] } as Chat
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        flushSync()
    }
}

function render(chat: Chat, onInsert = vi.fn()) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(BtwSidePanel, { target, props: { character, chat, onInsert } }))
    flushSync()
    return { target, onInsert }
}

function button(target: HTMLElement, label: string): HTMLButtonElement {
    const found = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
    if (!found) throw new Error(`no button ${label}`)
    return found as HTMLButtonElement
}

beforeEach(() => {
    mocks.requestChatData.mockReset()
    sessionStorage.clear()
    btwSideChat.chats = {}
    btwSideChat.open = true
})

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
    document.body.replaceChildren()
})

describe('BtwSidePanel', () => {
    test('a quick question shows the answer, which can go to the message box', async () => {
        mocks.requestChatData.mockResolvedValue({ type: 'success', result: 'You just arrived.' })
        const { target, onInsert } = render(makeChat())

        expect(target.textContent).toContain(language.btwSideChat.intro)
        button(target, language.btwSideChat.quickRecap).click()
        await settle()

        expect(mocks.requestChatData.mock.calls[0][0].formated.at(-1).content).toBe(language.btwSideChat.quickRecapPrompt)
        expect(target.textContent).toContain('You just arrived.')
        expect(target.textContent).not.toContain(language.btwSideChat.intro)

        button(target, language.btwSideChat.insert).click()
        expect(onInsert).toHaveBeenCalledWith('You just arrived.')
    })

    test('shows a stop button while answering and gives a stopped question back', async () => {
        let release!: () => void
        mocks.requestChatData.mockImplementation((_arg: unknown, _mode: unknown, signal: AbortSignal) => new Promise((resolve) => {
            release = () => resolve({ type: 'fail', result: 'Aborted' })
            signal.addEventListener('abort', () => release())
        }))
        const { target } = render(makeChat())
        const box = target.querySelector('textarea') as HTMLTextAreaElement
        box.value = 'Is the gate open?'
        box.dispatchEvent(new Event('input', { bubbles: true }))
        flushSync()
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await settle()

        expect(box.value).toBe('')
        expect(target.textContent).toContain('Is the gate open?')
        expect(target.textContent).toContain(language.btwSideChat.thinking)
        button(target, language.btwSideChat.stop).click()
        await settle()

        expect(target.textContent).not.toContain(language.btwSideChat.thinking)
        expect(box.value).toBe('Is the gate open?')
        expect(button(target, language.btwSideChat.send)).toBeTruthy()
    })

    test('clear removes the side conversation', async () => {
        mocks.requestChatData.mockResolvedValue({ type: 'success', result: 'Noted.' })
        const { target } = render(makeChat())
        button(target, language.btwSideChat.quickCheck).click()
        await settle()
        expect(target.textContent).toContain('Noted.')

        button(target, language.btwSideChat.clear).click()
        await tick()
        flushSync()
        expect(target.textContent).not.toContain('Noted.')
        expect(target.textContent).toContain(language.btwSideChat.intro)
    })

    test('close hides the panel through the shared store', () => {
        const { target } = render(makeChat())
        button(target, language.btwSideChat.close).click()
        expect(btwSideChat.open).toBe(false)
    })
})
