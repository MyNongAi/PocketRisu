// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'

vi.mock('src/ts/gui/backLayers.svelte', () => ({ BackLayerRank: { Popup: 200 }, useBackLayer: () => {} }))

import MemoDialog from './MemoDialog.svelte'

let mounted: unknown[] = []
afterEach(() => {
    mounted.splice(0).forEach((component) => unmount(component as never))
    document.body.replaceChildren()
})

describe('MemoDialog', () => {
    it('writes the bot memo to the character and the chat memo to the open chat', () => {
        const chara = { name: 'Bot', chatPage: 1, chats: [{ name: 'first', message: [] }, { name: 'second', message: [] }] } as any
        const close = vi.fn()
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted.push(mount(MemoDialog, { target, props: { chara, close } }))
        flushSync()
        const [botField, chatField] = target.querySelectorAll('textarea')
        botField.value = 'about the bot'
        botField.dispatchEvent(new Event('input', { bubbles: true }))
        chatField.value = 'about this chat'
        chatField.dispatchEvent(new Event('input', { bubbles: true }))
        expect(chara.nodeOnlyMemo).toBe('about the bot')
        expect(chara.chats[1].nodeOnlyMemo).toBe('about this chat')
        expect(chara.chats[0].nodeOnlyMemo).toBeUndefined()
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        expect(close).toHaveBeenCalledOnce()
    })
})
