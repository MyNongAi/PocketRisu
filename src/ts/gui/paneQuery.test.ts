// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'

vi.mock('../stores.svelte', () => ({
    DBState: { db: { characters: [] } },
    selIdState: { selId: -1 },
    MobileGUI: writable(false),
}))

const { paneState } = await import('../chatPanes.svelte')
const { queryInActivePane } = await import('./paneQuery')

function page(html: string) {
    document.body.innerHTML = html
}

afterEach(() => {
    document.body.replaceChildren()
    paneState.active = 'main'
})

const split = `
    <div data-chat-pane="main"><button class="button-icon-send" id="m"></button><button class="button-icon-reroll" id="mr"></button></div>
    <div data-chat-pane="side"><button class="button-icon-send" id="s"></button></div>
    <div class="outside" id="o"></div>`

describe('queryInActivePane', () => {
    it('finds the button of the pane holding the selection', () => {
        page(split)
        paneState.active = 'side'
        expect(queryInActivePane('.button-icon-send')?.id).toBe('s')
        paneState.active = 'main'
        expect(queryInActivePane('.button-icon-send')?.id).toBe('m')
    })

    it('finds nothing from the other pane', () => {
        page(split)
        paneState.active = 'side'
        expect(queryInActivePane('.button-icon-reroll')).toBeNull()
    })

    it('still finds what is outside every pane', () => {
        page(split)
        paneState.active = 'side'
        expect(queryInActivePane('.outside')?.id).toBe('o')
    })

    it('is document.querySelector with one pane on the page', () => {
        page(`<div data-chat-pane="main"><button class="button-icon-send" id="m"></button></div>`)
        for (const active of ['main', 'side'] as const) {
            paneState.active = active
            expect(queryInActivePane('.button-icon-send')).toBe(document.querySelector('.button-icon-send'))
        }
    })
})
