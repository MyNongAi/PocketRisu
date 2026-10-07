import { describe, expect, it } from 'vitest'
import type { folder } from './storage/database.svelte'
import { BOT_LINK_FOLDER_NAME, botsWithOwnModules, gatherLinkedBots } from './linkedBotFolder'

type Entry = string | folder
const f = (id: string, data: string[], extra: Partial<folder> = {}): folder => ({ id, name: id, color: '', data, ...extra })
const show = (order: Entry[]) => order.map((e) => typeof e === 'string' ? e : `[${e.name}:${e.data.join(',')}${e.nodeOnlyParentFolderId ? '^' + e.nodeOnlyParentFolderId : ''}${e.nodeOnlyLinkNested ? '*' : ''}]`)
let n = 0
const newId = () => `L${++n}`

describe('botsWithOwnModules', () => {
    it('lists the bots outside the trash that carry modules', () => {
        expect([...botsWithOwnModules([{ chaId: 'a', modules: ['m'] }, { chaId: 'b', modules: [] }, { chaId: 'c', modules: ['m'], trashTime: 1 }, null])]).toEqual(['a'])
    })
})

describe('gatherLinkedBots', () => {
    it('moves loose linked bots into a new [링크] folder at the top and shows their folders inside it', () => {
        n = 0
        const order: Entry[] = ['x', 'a', f('Creator', ['k1', 'k2']), 'b', f('User', ['u'])]
        const next = gatherLinkedBots(order, new Set(['a', 'b', 'k1']), newId)!
        expect(show(next)).toEqual([`[${BOT_LINK_FOLDER_NAME}:a,b]`, 'x', '[Creator:k1,k2^L1*]', '[User:u]'])
    })

    it('brings the topmost folder: a similarity folder shown in a creator folder brings the creator folder', () => {
        n = 0
        const order: Entry[] = [f('C', ['c1']), f('S', ['s1', 's2'], { nodeOnlyParentFolderId: 'C' })]
        expect(show(gatherLinkedBots(order, new Set(['s1']), newId)!)).toEqual([`[${BOT_LINK_FOLDER_NAME}:]`, '[C:c1^L1*]', '[S:s1,s2^C]'])
    })

    it('lets an unlinked bot out where the folder is, un-nests what it nested, and drops an empty [링크]', () => {
        const link = f('L', ['a'], { name: BOT_LINK_FOLDER_NAME, nodeOnlyLinkFolder: true })
        const order: Entry[] = ['x', link, f('C', ['k'], { nodeOnlyParentFolderId: 'L', nodeOnlyLinkNested: true }), f('Mine', ['m'], { nodeOnlyParentFolderId: 'L' })]
        // The user's own nesting under [링크] stays, so [링크] stays too.
        expect(show(gatherLinkedBots(order, new Set(), newId)!)).toEqual(['x', `[${BOT_LINK_FOLDER_NAME}:]`, 'a', '[C:k]', '[Mine:m^L]'])
        const bare: Entry[] = ['x', link]
        expect(show(gatherLinkedBots(bare, new Set(), newId)!)).toEqual(['x', 'a'])
    })

    it('renames the [링크] folder that still carries the emoji of 2026-10-08', () => {
        const link = f('L', ['a'], { name: '🔗 [링크]', nodeOnlyLinkFolder: true })
        expect(show(gatherLinkedBots([link, 'x'], new Set(['a']), newId)!)).toEqual([`[${BOT_LINK_FOLDER_NAME}:a]`, 'x'])
    })

    it('leaves system folders alone and changes nothing when everything is in place', () => {
        const star = f('nodeonly-favorites', ['a'], { nodeOnlySystem: 'favorites' })
        expect(gatherLinkedBots([star, 'x'], new Set(['a']), newId)).toBeNull()
        const link = f('L', ['a'], { name: BOT_LINK_FOLDER_NAME, nodeOnlyLinkFolder: true })
        const settled: Entry[] = [link, f('C', ['k'], { nodeOnlyParentFolderId: 'L', nodeOnlyLinkNested: true }), 'x']
        expect(gatherLinkedBots(settled, new Set(['a', 'k']), newId)).toBeNull()
    })
})
