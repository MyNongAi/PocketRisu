import { describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'

vi.mock('../globalApi.svelte', () => ({
    AppendableBuffer: class {
        private parts: Uint8Array[] = []
        append(data: Uint8Array) { this.parts.push(data.slice()) }
        get buffer() {
            const out = new Uint8Array(this.parts.reduce((n, part) => n + part.length, 0))
            let offset = 0
            for (const part of this.parts) { out.set(part, offset); offset += part.length }
            return out
        }
    },
    saveAsset: vi.fn(async () => 'assets/saved.png'),
}))
vi.mock('../alert', () => ({ alertStore: { set: vi.fn() } }))
vi.mock('../parser/parser.svelte', () => ({ hasher: vi.fn(async (data: Uint8Array) => `h${data.length}`) }))
vi.mock('../characterCards', () => ({ hubURL: '' }))
vi.mock('../util', () => {
    class Semaphore {
        private available: number
        private waiting: Array<() => void> = []
        constructor(max: number) { this.available = max }
        async acquire() {
            if (this.available > 0) { this.available -= 1; return }
            await new Promise<void>((resolve) => this.waiting.push(resolve))
        }
        release() {
            const next = this.waiting.shift()
            if (next) next()
            else this.available += 1
        }
    }
    return {
        Semaphore,
        asBuffer: (value: unknown) => value,
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    }
})

import { CharXImporter } from './processzip'

describe('CharXImporter', () => {
    it('reads an archive of thousands of tiny entries handed over as one chunk', async () => {
        // fflate recurses once per entry found in a pushed buffer; one chunk
        // with this many entries overflowed the stack before slicing.
        const files: Record<string, Uint8Array> = {}
        const entries = 6000
        for (let i = 0; i < entries; i++) files[`assets/other/image/t${i}.png`] = new Uint8Array([i & 255, 1, 2, 3])
        files['card.json'] = strToU8(JSON.stringify({ spec: 'chara_card_v3', data: { name: '시험' } }))
        const archive = zipSync(files, { level: 0 })

        const importer = new CharXImporter()
        importer.skipSaving = true
        await importer.parse(archive)
        await importer.done()

        expect(JSON.parse(importer.cardData ?? '{}').data.name).toBe('시험')
        expect(Object.keys(importer.assets)).toHaveLength(entries)
    })
})
