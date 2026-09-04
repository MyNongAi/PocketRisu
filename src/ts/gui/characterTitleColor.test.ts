import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
    db: { characters: [] as { chaId: string, titleColor?: string }[] },
    choose: vi.fn(),
}))
vi.mock('../stores.svelte', () => ({ DBState: { db: state.db } }))
vi.mock('./titleColors', () => ({ chooseTitleColor: state.choose }))
import { editCharacterTitleColor } from './characterTitleColor'

beforeEach(() => {
    state.db.characters = [{ chaId: 'a', titleColor: '#4ade80' }, { chaId: 'b' }]
    state.choose.mockReset()
})

describe('character title color updates', () => {
    it('updates by stable ID even when the catalog order changes during the picker', async () => {
        state.choose.mockImplementation(async () => {
            state.db.characters.reverse()
            return '#38bdf8'
        })
        await editCharacterTitleColor('a')
        expect(state.db.characters.find(item => item.chaId === 'a')?.titleColor).toBe('#38bdf8')
        expect(state.db.characters.find(item => item.chaId === 'b')?.titleColor).toBeUndefined()
    })
    it('leaves metadata unchanged on cancel and removes it on reset', async () => {
        state.choose.mockResolvedValueOnce(null)
        await editCharacterTitleColor('a')
        expect(state.db.characters[0].titleColor).toBe('#4ade80')
        state.choose.mockResolvedValueOnce('')
        await editCharacterTitleColor('a')
        expect(state.db.characters[0]).not.toHaveProperty('titleColor')
    })
    it('does not modify a different bot if the target disappears while choosing', async () => {
        state.choose.mockImplementation(async () => {
            state.db.characters = [{ chaId: 'b' }]
            return '#38bdf8'
        })
        await editCharacterTitleColor('a')
        expect(state.db.characters).toEqual([{ chaId: 'b' }])
    })
})
