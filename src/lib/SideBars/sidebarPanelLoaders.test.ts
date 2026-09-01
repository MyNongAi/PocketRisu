import { describe, expect, it, vi } from 'vitest'
import { createCachedLoader } from './sidebarPanelLoaders'

describe('createCachedLoader', () => {
    it('shares a successful component import', async () => {
        const importer = vi.fn(async () => ({ default: 'component' }))
        const load = createCachedLoader(importer)
        const [first, second] = await Promise.all([load(), load()])
        expect(first).toBe(second)
        expect(importer).toHaveBeenCalledTimes(1)
    })

    it('allows retry after an import failure', async () => {
        const importer = vi.fn()
            .mockRejectedValueOnce(new Error('temporary'))
            .mockResolvedValueOnce({ default: 'component' })
        const load = createCachedLoader(importer)
        await expect(load()).rejects.toThrow('temporary')
        await expect(load()).resolves.toEqual({ default: 'component' })
        expect(importer).toHaveBeenCalledTimes(2)
    })
})
