// @vitest-environment happy-dom

// Deleting a chat from the chat list while its confirmation is open. The
// question can be tucked away (ALERT-QUESTION-TUCK) and the list change
// meanwhile; the delete used the row's index, and the row's `chat` is read
// again by position, so a new chat on top made it delete the neighbour.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'
import { useTogglesTestDb } from './togglesTestDb.svelte'

const hoisted = vi.hoisted(() => ({ answer: null as null | ((yes: boolean) => void) }))

vi.mock('src/ts/alert', async (importOriginal) => {
    const real: any = await importOriginal()
    return {
        ...real,
        alertConfirm: () => new Promise<boolean>((resolve) => { hoisted.answer = resolve }),
        notifySuccess: () => {},
    }
})

vi.mock('src/ts/globalApi.svelte', async (importOriginal) => {
    const real: any = await importOriginal()
    return { ...real, changeChatTo: () => {}, requestImmediateSave: async () => {} }
})

const { default: SideChatList } = await import('./SideChatList.svelte')

const mounted: Record<string, any>[] = []

const chat = (id: string) => ({ message: [], note: '', name: id, localLore: [], fmIndex: -1, id })

async function settle() {
    flushSync()
    await tick()
    flushSync()
}

function trashOf(name: string): HTMLElement {
    const row = [...document.querySelectorAll<HTMLElement>('button[data-risu-chat-idx]')]
        .find((candidate) => candidate.textContent?.includes(name))
    const trash = row?.querySelector<HTMLElement>('[role="button"].hover\\:text-red-400')
    if (!trash) throw new Error(`no delete button for ${name}`)
    return trash
}

beforeEach(() => {
    const db: any = useTogglesTestDb()
    db.characters[0].chats = [chat('A'), chat('B'), chat('C')]
    db.characters[0].chatPage = 0
    selectedCharID.set(0)
    hoisted.answer = null
})

afterEach(() => {
    for (const component of mounted.splice(0).reverse()) unmount(component)
    document.body.replaceChildren()
})

function mountList() {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(SideChatList, { target, props: { chara: DBState.db.characters[0] } }))
}

describe('deleting a chat while the list changes', () => {
    it('deletes the chat that was clicked after a new chat was added on top', async () => {
        mountList()
        await settle()
        trashOf('B').click()
        await settle()
        DBState.db.characters[0].chats.unshift(chat('NEW'))
        await settle()
        hoisted.answer?.(true)
        await settle()
        expect(DBState.db.characters[0].chats.map((c: any) => c.name)).toEqual(['NEW', 'A', 'C'])
    })

    it('deletes nothing when the clicked chat is already gone', async () => {
        mountList()
        await settle()
        trashOf('B').click()
        await settle()
        DBState.db.characters[0].chats.splice(1, 1)
        await settle()
        hoisted.answer?.(true)
        await settle()
        expect(DBState.db.characters[0].chats.map((c: any) => c.name)).toEqual(['A', 'C'])
    })
})
