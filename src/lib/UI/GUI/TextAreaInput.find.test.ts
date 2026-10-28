// @vitest-environment happy-dom

// Find in a field (the user's request, 2026-10-28): a field typed straight
// into in the bottom bar's empty left, the buttons at the bar's right end as
// upstream lays them out, and the resize corner in the text's own corner.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { DBState } from 'src/ts/stores.svelte'
import TextAreaInput from './TextAreaInput.svelte'

const mounted: Record<string, any>[] = []
beforeEach(() => {
    DBState.db = { showInputActionBar: true } as never
})
afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component)
    document.body.replaceChildren()
})

async function settle() {
    flushSync()
    await tick()
    flushSync()
}

async function mountField(props: Record<string, unknown>) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(TextAreaInput, { target, props: { value: 'apple banana apple', ...props } }))
    await settle()
    return target
}

describe('finding in a text field', () => {
    it('is typed straight into in the bottom bar, and clears on Escape', async () => {
        const target = await mountField({ findable: true, resizable: true })
        const bar = target.querySelector('[data-field-find]') as HTMLElement
        const input = bar.querySelector('input') as HTMLInputElement
        // In the bar under the text, before the buttons; no bar above the text.
        expect(bar.parentElement?.previousElementSibling?.querySelector('textarea, [contenteditable]')).toBeTruthy()
        expect(bar.nextElementSibling?.querySelectorAll('button').length).toBe(3)
        expect(bar.querySelector('button')).toBeNull()

        input.value = 'apple'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await settle()
        expect(bar.textContent).toContain('1/2')
        expect(bar.querySelectorAll('button').length).toBe(3)
        // The field's own buttons step aside while finding, for room.
        expect(target.querySelector('[data-field-actions]')).toBeNull()

        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await settle()
        expect(input.value).toBe('')
        expect(bar.querySelector('button')).toBeNull()
        expect(target.querySelector('[data-field-actions]')).toBeTruthy()
    })

    it('keeps the resize corner in the text, not in the button row', async () => {
        const target = await mountField({ findable: true, resizable: true })
        const corner = target.querySelector('[data-resize-corner]') as HTMLElement
        expect(corner).toBeTruthy()
        expect(corner.parentElement?.querySelector('[data-field-find]')).toBeNull()
        expect(corner.parentElement?.querySelector('textarea, [contenteditable]')).toBeTruthy()
    })

    it('has no find field where the field is not findable', async () => {
        const target = await mountField({})
        expect(target.querySelector('[data-field-find]')).toBeNull()
    })
})
