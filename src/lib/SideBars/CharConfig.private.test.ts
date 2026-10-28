// @vitest-environment happy-dom

// A private-licensed bot (Realm "private", or a Risu-only card exported with
// it) shows only the first tab of its settings. CharConfig used to reset the
// tab from inside its template, which Svelte 5 rejects with
// state_unsafe_mutation: opening such a bot while another tab was open threw
// and left the previous bot's tab (its export button among it) on screen.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { language } from 'src/lang'
import { CharConfigSubMenu, DBState, selectedCharID } from 'src/ts/stores.svelte'
import { refreshModules } from 'src/ts/process/modules'
import CharConfig from './CharConfig.svelte'
import { useTogglesTestDb } from './togglesTestDb.svelte'

const SHARE_TAB = 6
const mounted: Record<string, any>[] = []

beforeEach(() => {
    selectedCharID.set(0)
})

afterEach(() => {
    for (const component of mounted.splice(0).reverse()) unmount(component)
    document.body.replaceChildren()
    CharConfigSubMenu.set(0)
    refreshModules()
})

async function settle() {
    flushSync()
    await tick()
    flushSync()
}

function mountCharConfig() {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(CharConfig, { target, props: {} }))
    return target
}

describe('CharConfig with a private-licensed bot', () => {
    it('opens on the first tab instead of throwing when the share tab was open', async () => {
        const db = useTogglesTestDb()
        db.characters[0].license = 'private'
        CharConfigSubMenu.set(SHARE_TAB)
        await settle()

        const target = mountCharConfig()
        await settle()

        expect(get(CharConfigSubMenu)).toBe(0)
        expect(target.textContent).not.toContain(language.exportCharacter)
    })

    it('leaves the share tab when the open bot turns out private', async () => {
        useTogglesTestDb()
        CharConfigSubMenu.set(SHARE_TAB)
        await settle()
        const target = mountCharConfig()
        await settle()
        expect(target.textContent).toContain(language.exportCharacter)

        DBState.db.characters[0].license = 'private'
        await settle()

        expect(get(CharConfigSubMenu)).toBe(0)
        expect(target.textContent).not.toContain(language.exportCharacter)
    })
})
