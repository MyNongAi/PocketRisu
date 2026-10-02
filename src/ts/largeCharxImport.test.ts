import { beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'

const alertConfirmMulti = vi.hoisted(() => vi.fn())
vi.mock('./alert', () => ({ alertConfirmMulti }))

const { askLargeCharxDestination, planLargeCharxImport } = await import('./largeCharxImport')
const { language } = await import('src/lang')

describe('large CHARX question', () => {
    beforeEach(() => alertConfirmMulti.mockReset())

    it('offers bot and module with the file size and asset count, the expected one highlighted', async () => {
        alertConfirmMulti.mockResolvedValueOnce(1)
        const answer = await askLargeCharxDestination('pack.charx', { bytes: 312_400_000, assets: 7421 }, 'character')
        expect(answer).toBe('module')
        const [title, actions, detail] = alertConfirmMulti.mock.calls[0]
        expect(title).toBe(language.largeCharxImport.title)
        expect(actions).toEqual([
            { label: language.largeCharxImport.asCharacter, variant: 'primary' },
            { label: language.largeCharxImport.asModule, variant: 'default' },
        ])
        expect(detail).toContain('pack.charx')
        expect(detail).toContain('312.4 MB')
        expect(detail).toContain((7421).toLocaleString())
    })

    it('maps the first button to a bot and the dialog cancel to null', async () => {
        alertConfirmMulti.mockResolvedValueOnce(0).mockResolvedValueOnce(-1)
        expect(await askLargeCharxDestination('a.charx', { bytes: 2_000_000_000, assets: null }, 'module')).toBe('character')
        expect(await askLargeCharxDestination('a.charx', { bytes: 2_000_000_000, assets: null }, 'module')).toBeNull()
        expect(alertConfirmMulti.mock.calls[0][2]).toContain('2.00 GB')
    })

    it('highlights the module for a module export even from the bot importer, and never asks for a small file', async () => {
        const files: Record<string, Uint8Array> = { 'card.json': strToU8('{}') }
        for (let i = 0; i < 5000; i++) files[`assets/${i}.png`] = Uint8Array.of(1)
        alertConfirmMulti.mockResolvedValueOnce(1)
        const plan = await planLargeCharxImport('Pack.module.charx', zipSync(files, { level: 0 }), 'character')
        expect(plan).toMatchObject({ kind: 'guarded', destination: 'module' })
        expect(alertConfirmMulti.mock.calls[0][1][1].variant).toBe('primary')

        expect(await planLargeCharxImport('small.charx', zipSync({ 'card.json': strToU8('{}') }), 'character'))
            .toEqual({ kind: 'normal' })
        expect(alertConfirmMulti).toHaveBeenCalledTimes(1)
    })
})
