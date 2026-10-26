import { describe, expect, it, vi } from 'vitest'

const db = { characters: [{ chaId: 'new', nodeOnlyUnseen: true }, { chaId: 'old' }] as any[] }
vi.mock('./stores.svelte', () => ({ DBState: { db } }))

const { markSeen, hasNewMark, newMarks } = await import('./newMarks.svelte')

describe('NEW on bots and modules received and not looked at yet', () => {
    it('lists the unseen bots and puts the mark before a name', () => {
        expect([...newMarks.characters]).toEqual(['new'])
        expect(hasNewMark(db.characters[0])).toBe(true)
        expect(hasNewMark(db.characters[1])).toBe(false)
    })

    it('drops the mark once looked at', () => {
        const module = { id: 'm', nodeOnlyUnseen: true }
        markSeen(module)
        expect('nodeOnlyUnseen' in module).toBe(false)
        markSeen(null)
    })
})
