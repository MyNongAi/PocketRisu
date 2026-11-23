// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { language } from 'src/lang'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'
import { refreshModules } from 'src/ts/process/modules'
import { PERVENTIA_ID, PERVENTIA_NAME, useTogglesTestDb } from 'src/lib/SideBars/togglesTestDb.svelte'
import ModuleSettings from './ModuleSettings.svelte'

const mounted: Record<string, any>[] = []

beforeEach(() => {
    selectedCharID.set(0)
    localStorage.clear()
})

afterEach(() => {
    for (const component of mounted.splice(0).reverse()) unmount(component)
    document.body.replaceChildren()
    refreshModules()
})

async function settle() {
    flushSync()
    await tick()
    flushSync()
}

async function mountSettings(sidePanel: boolean) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(ModuleSettings, { target, props: { sidePanel } }))
    await settle()
    const search = target.querySelector<HTMLInputElement>('input')!
    search.value = PERVENTIA_NAME
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    return target
}

function moduleButton(target: HTMLElement, label: string) {
    return [...target.querySelectorAll<HTMLButtonElement>('button.select-none')]
        .find((button) => button.getAttribute('aria-label')?.includes(label))
}

describe('ModuleSettings activation scope', () => {
    it('toggles only the open chat from the side panel', async () => {
        useTogglesTestDb()
        const target = await mountSettings(true)
        const button = moduleButton(target, language.moduleScopeChat)
        expect(button).toBeTruthy()
        // moduleGlobeHold runs its tap action from the click event.
        moduleButton(target, language.moduleScopeChat)!.click()
        await settle()
        expect(DBState.db.characters[0].chats[0].modules).toContain(PERVENTIA_ID)
        expect(DBState.db.enabledModules).not.toContain(PERVENTIA_ID)
        expect(moduleButton(target, language.moduleScopeChat)!.className).toContain('text-blue-500')

        moduleButton(target, language.moduleScopeChat)!.click()
        await settle()
        expect(DBState.db.characters[0].chats[0].modules).not.toContain(PERVENTIA_ID)
        expect(DBState.db.enabledModules).not.toContain(PERVENTIA_ID)
    })

    it('shows a fixed globe for a globally enabled module in the side panel', async () => {
        useTogglesTestDb({ enabledModules: [PERVENTIA_ID] })
        const target = await mountSettings(true)
        expect(moduleButton(target, language.moduleScopeChat)).toBeUndefined()
        expect(target.querySelector(`[aria-label="${language.moduleScopeGlobal}"]`)).toBeTruthy()
    })

    it('disables chat activation when the selected bot has no open chat', async () => {
        useTogglesTestDb()
        DBState.db.characters[0].chats = []
        const target = await mountSettings(true)
        const button = moduleButton(target, language.moduleScopeChat)
        expect(button?.disabled).toBe(true)
        expect(button?.getAttribute('aria-label')).toContain(language.moduleChatRequiresOpenChat)
        button!.click()
        await settle()
        expect(DBState.db.enabledModules).not.toContain(PERVENTIA_ID)
    })

    it('keeps the Settings page tap global', async () => {
        useTogglesTestDb()
        const target = await mountSettings(false)
        const button = moduleButton(target, language.enableGlobal)
        expect(button).toBeTruthy()
        button!.click()
        await settle()
        expect(DBState.db.enabledModules).toContain(PERVENTIA_ID)
        expect(DBState.db.characters[0].chats[0].modules ?? []).not.toContain(PERVENTIA_ID)
    })
})
