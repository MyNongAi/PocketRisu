import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { planLargeCharxImport } from './largeCharxImport'

function largeCharx() {
    const files: Record<string, Uint8Array> = { 'card.json': strToU8('{}') }
    for (let i = 0; i < 5000; i++) files[`assets/${i}.png`] = Uint8Array.of(1)
    return zipSync(files, { level: 0 })
}

describe('large CHARX destination', () => {
    it('goes where the file was headed, without asking', async () => {
        expect(await planLargeCharxImport('pack.charx', largeCharx(), 'character'))
            .toMatchObject({ kind: 'guarded', destination: 'character' })
        expect(await planLargeCharxImport('pack.charx', largeCharx(), 'module'))
            .toMatchObject({ kind: 'guarded', destination: 'module' })
    })

    it('makes a module export a module even from the bot importer; a small file is a normal import', async () => {
        expect(await planLargeCharxImport('Pack.module.charx', largeCharx(), 'character'))
            .toMatchObject({ kind: 'guarded', destination: 'module' })
        expect(await planLargeCharxImport('small.charx', zipSync({ 'card.json': strToU8('{}') }), 'character'))
            .toEqual({ kind: 'normal' })
    })
})
