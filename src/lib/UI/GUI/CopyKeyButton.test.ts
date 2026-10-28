// @vitest-environment happy-dom

// The 📋 beside a model preset's API key (the user's request, 2026-10-28).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'

const alert = vi.hoisted(() => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }))
vi.mock('src/ts/alert', () => alert)

import CopyKeyButton from './CopyKeyButton.svelte'

const mounted: Record<string, any>[] = []
afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component)
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

function mountButton(text: string | undefined) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(CopyKeyButton, { target, props: { text } }))
    flushSync()
    return target.querySelector('[data-copy-key]') as HTMLButtonElement
}

describe('the copy-key button', () => {
    it('puts the key on the clipboard and says so', async () => {
        const writeText = vi.fn(async (_text: string) => {})
        vi.stubGlobal('navigator', { clipboard: { writeText } })
        const button = mountButton('pst-secret')
        button.click()
        await tick()
        await Promise.resolve()
        expect(writeText).toHaveBeenCalledWith('pst-secret')
        expect(alert.notifySuccess).toHaveBeenCalledTimes(1)
    })

    it('is off while there is no key', () => {
        const button = mountButton(undefined)
        expect(button.disabled).toBe(true)
    })

    it('says why when the browser refuses', async () => {
        vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
        mountButton('k').click()
        await tick()
        await Promise.resolve()
        expect(alert.notifyError).toHaveBeenCalledWith('Error: denied')
    })
})
