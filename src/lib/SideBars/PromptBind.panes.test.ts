// @vitest-environment happy-dom

// The prompt preset binding (PromptBind.svelte) in both split panes. Each
// pane's panel mounts it for its own chat; db.botPresetsId is app-wide, so
// two panes bound to different presets flipped it until Svelte gave up
// (effect_update_depth_exceeded), and the pane beside the selection snapped
// the selected chat's preset back to its own binding.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'
import { useTogglesTestDb } from './togglesTestDb.svelte'

const hoisted = vi.hoisted(() => ({
    switches: [] as number[],
    nextView: null as unknown,
}))

// The preset switch saves and loads whole presets; here it only moves the index.
vi.mock('src/ts/storage/database.svelte', async (importOriginal) => {
    const real: any = await importOriginal()
    return {
        ...real,
        changeToPreset: (id: number) => {
            hoisted.switches.push(id)
            if (hoisted.switches.length > 50) throw new Error('preset flip loop')
            real.getDatabase().botPresetsId = id
        },
    }
})

// The pane a mount is drawn in (Sidebar's setPaneContext in the app).
vi.mock('src/ts/chatPanes.svelte', async (importOriginal) => {
    const real: any = await importOriginal()
    return { ...real, getPaneView: () => hoisted.nextView ?? real.selectionPaneView }
})

const { paneState, paneView } = await import('src/ts/chatPanes.svelte')
const { default: PromptBind } = await import('./PromptBind.svelte')

const mounted: Record<string, any>[] = []

function mountIn(pane: 'main' | 'side' | null) {
    hoisted.nextView = pane ? paneView(pane) : null
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(PromptBind, { target }))
    hoisted.nextView = null
}

async function settle() {
    flushSync()
    await tick()
    flushSync()
}

beforeEach(() => {
    hoisted.switches.length = 0
    const db: any = useTogglesTestDb({
        botPresets: ['p0', 'p1', 'p2'].map((id) => ({ id, name: id })),
        botPresetsId: 0,
    })
    const character = db.characters[0]
    character.chats = [
        { message: [], note: '', name: 'A1', localLore: [], fmIndex: -1, id: 'a1', bindedBotPreset: 'p1' },
        { message: [], note: '', name: 'A2', localLore: [], fmIndex: -1, id: 'a2', bindedBotPreset: 'p2' },
    ]
    character.chatPage = 0
    selectedCharID.set(0)
    paneState.active = 'main'
    paneState.held.main = { chaId: character.chaId, chatId: 'a1' }
    paneState.held.side = { chaId: character.chaId, chatId: 'a2' }
})

afterEach(() => {
    for (const component of mounted.splice(0).reverse()) unmount(component)
    document.body.replaceChildren()
})

describe('prompt preset binding in split panes', () => {
    it('two panes bound to different presets do not fight over the preset', async () => {
        mountIn('main')
        mountIn('side')
        await settle()
        expect(DBState.db.botPresetsId).toBe(1)
        expect(hoisted.switches).toEqual([1])
    })

    it('the pane beside the selection does not snap the selected chat back', async () => {
        DBState.db.characters[0].chats[0].bindedBotPreset = ''
        mountIn('main')
        mountIn('side')
        await settle()
        DBState.db.botPresetsId = 0
        await settle()
        expect(DBState.db.botPresetsId).toBe(0)
        expect(hoisted.switches).toEqual([])
    })

    it('the binding follows the selection to the other pane', async () => {
        mountIn('main')
        mountIn('side')
        await settle()
        paneState.active = 'side'
        DBState.db.characters[0].chatPage = 1
        await settle()
        expect(DBState.db.botPresetsId).toBe(2)
    })

    it('without the split a bound chat keeps its preset', async () => {
        mountIn(null)
        await settle()
        expect(DBState.db.botPresetsId).toBe(1)
        DBState.db.botPresetsId = 0
        await settle()
        expect(DBState.db.botPresetsId).toBe(1)
    })
})
