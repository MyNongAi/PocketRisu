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

function moduleButton(target: HTMLElement) {
    return target.querySelector<HTMLButtonElement>('button[data-scope-button]')!
}

async function openScopeMenu(target: HTMLElement) {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    moduleButton(target).dispatchEvent(event)
    await settle()
    expect(event.defaultPrevented).toBe(true)
}

function menuItem(label: string) {
    return [...document.body.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')]
        .find((item) => item.textContent?.includes(label))!
}

describe('ModuleSettings activation scope', () => {
    it('toggles only the open chat from the side panel', async () => {
        useTogglesTestDb()
        const target = await mountSettings(true)
        const button = moduleButton(target)
        expect(button.querySelector('svg')?.getAttribute('class')).toContain('globe')
        expect(button.className).toContain('text-textcolor2')
        // moduleGlobeHold runs its tap action from the click event.
        button.click()
        await settle()
        expect(DBState.db.characters[0].chats[0].modules).toContain(PERVENTIA_ID)
        expect(DBState.db.enabledModules).not.toContain(PERVENTIA_ID)
        expect(moduleButton(target).className).toContain('text-blue-500')
        expect(moduleButton(target).querySelector('svg')?.getAttribute('class')).toContain('message-square')
        expect(moduleButton(target).getAttribute('aria-label')).toContain(language.moduleSideChatOn)

        moduleButton(target).click()
        await settle()
        expect(DBState.db.characters[0].chats[0].modules).not.toContain(PERVENTIA_ID)
        expect(DBState.db.enabledModules).not.toContain(PERVENTIA_ID)
    })

    it('turns off a global module without adding it to the chat', async () => {
        useTogglesTestDb({ enabledModules: [PERVENTIA_ID] })
        const target = await mountSettings(true)
        expect(moduleButton(target).className).toContain('text-blue-500')
        expect(moduleButton(target).querySelector('svg')?.getAttribute('class')).toContain('globe')
        expect(moduleButton(target).getAttribute('aria-label')).toContain(language.moduleSideGlobalOn)
        moduleButton(target).click()
        await settle()
        expect(DBState.db.enabledModules).not.toContain(PERVENTIA_ID)
        expect(DBState.db.characters[0].chats[0].modules ?? []).not.toContain(PERVENTIA_ID)
    })

    it('unlinks a bot module without adding it to the chat', async () => {
        useTogglesTestDb({ characterModules: [PERVENTIA_ID] })
        const target = await mountSettings(true)
        expect(moduleButton(target).className).toContain('text-amber-500')
        expect(moduleButton(target).getAttribute('aria-label')).toContain(language.moduleSideBotOn)
        moduleButton(target).click()
        await settle()
        expect(DBState.db.characters[0].modules).not.toContain(PERVENTIA_ID)
        expect(DBState.db.characters[0].chats[0].modules ?? []).not.toContain(PERVENTIA_ID)
    })

    it('toggles all three scopes from the context menu', async () => {
        useTogglesTestDb()
        const target = await mountSettings(true)
        await openScopeMenu(target)
        menuItem(language.moduleSideChat).click()
        await settle()
        expect(DBState.db.characters[0].chats[0].modules).toContain(PERVENTIA_ID)
        await openScopeMenu(target)
        menuItem(language.moduleSideChat).click()
        await settle()
        expect(DBState.db.characters[0].chats[0].modules).not.toContain(PERVENTIA_ID)
        await openScopeMenu(target)
        menuItem(language.moduleSideGlobal).click()
        await settle()
        expect(DBState.db.enabledModules).toContain(PERVENTIA_ID)
        await openScopeMenu(target)
        menuItem(language.moduleSideGlobal).click()
        await settle()
        expect(DBState.db.enabledModules).not.toContain(PERVENTIA_ID)
        await openScopeMenu(target)
        menuItem(language.moduleSideBot.replace('{}', 'Test character')).click()
        await settle()
        expect(DBState.db.characters[0].modules).toContain(PERVENTIA_ID)
        await openScopeMenu(target)
        menuItem(language.moduleSideBot.replace('{}', 'Test character')).click()
        await settle()
        expect(DBState.db.characters[0].modules).not.toContain(PERVENTIA_ID)
    })

    it('disables chat activation when the selected bot has no open chat', async () => {
        useTogglesTestDb()
        DBState.db.characters[0].chats = []
        const target = await mountSettings(true)
        const button = moduleButton(target)
        expect(button.className).toContain('cursor-not-allowed')
        expect(button.getAttribute('aria-label')).toContain(language.moduleChatRequiresOpenChat)
        button.click()
        await settle()
        expect(DBState.db.enabledModules).not.toContain(PERVENTIA_ID)
    })

    it('keeps the Settings page tap global', async () => {
        useTogglesTestDb()
        const target = await mountSettings(false)
        const button = [...target.querySelectorAll<HTMLButtonElement>('button.select-none')]
            .find((button) => button.getAttribute('aria-label')?.includes(language.enableGlobal))
        expect(button).toBeTruthy()
        button!.click()
        await settle()
        expect(DBState.db.enabledModules).toContain(PERVENTIA_ID)
        expect(DBState.db.characters[0].chats[0].modules ?? []).not.toContain(PERVENTIA_ID)
    })
})
