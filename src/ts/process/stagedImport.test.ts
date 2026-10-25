// A file the server staged (server/node/import-staging.cjs) imports to the same
// result as the whole file: the real CHARX importer and PNG chunk reader run on
// both, with a saveAsset that behaves like the real one (a staged stub returns
// its reference, anything else is "uploaded" under its hash).

import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'

const uploads: number[] = []
vi.mock('../globalApi.svelte', async () => {
    const { stagedAssetRef } = await import('../stagedAssets')
    const { createHash } = await import('node:crypto')
    return {
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
        saveAsset: vi.fn(async (data: Uint8Array) => {
            const staged = stagedAssetRef(data)
            if (staged) return staged
            uploads.push(data.length)
            return `assets/${createHash('sha256').update(data).digest('hex')}.png`
        }),
    }
})
vi.mock('../alert', () => ({ alertStore: { set: vi.fn() } }))
vi.mock('../parser/parser.svelte', () => ({ hasher: vi.fn(async () => 'unused') }))
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
        blobToUint8Array: async (blob: Blob) => new Uint8Array(await blob.arrayBuffer()),
    }
})

import { CharXImporter } from './processzip'
import { PngChunk } from '../pngChunk'
import { saveAsset } from '../globalApi.svelte'
import { withStagedAssets } from '../stagedAssets'

const { stageImportFile } = createRequire(import.meta.url)('../../../server/node/import-staging.cjs')

const NONCE = '89abcdef0123456789abcdef01234567'
// The server's store, answering what saveAsset would (the internal key here).
const serverStore = { nonce: NONCE, writeAsset: async (key: string) => key }
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

async function readCharx(data: Uint8Array) {
    const importer = new CharXImporter()
    await importer.parse(data)
    await importer.done()
    return { card: importer.cardData, module: importer.moduleData?.length ?? 0, assets: importer.assets }
}

/** What the PNG branch of importCharacterProcess saves and reads. */
async function readPngCard(data: Uint8Array) {
    const assets: Record<string, string> = {}
    let chara = ''
    let image = ''
    for await (const chunk of PngChunk.readGenerator(data, { returnTrimed: true })) {
        if (!chunk) continue
        if (!('key' in chunk)) {
            image = await saveAsset(chunk.buffer)
            break
        }
        if (chunk.key === 'chara' || chunk.key === 'ccv3') chara = chunk.value
        if (chunk.key.startsWith('chara-ext-asset_')) {
            const index = chunk.key.replace('chara-ext-asset_:', '').replace('chara-ext-asset_', '')
            assets[index] = await saveAsset(Buffer.from(chunk.value, 'base64'))
        }
    }
    return { chara, image, assets }
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length)
    new DataView(out.buffer).setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    return out
}
const text = (key: string, value: string) => pngChunk('tEXt', new TextEncoder().encode(`${key}\0${value}`))
const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let offset = 0
    for (const part of parts) { out.set(part, offset); offset += part.length }
    return out
}

describe('a staged file imports as the whole file does', () => {
    it('CHARX: the same card and the same asset references, with nothing uploaded', async () => {
        // Pictures do not compress: random bytes, like a real archive's images.
        const pictures = Array.from({ length: 30 }, (_, i) => new Uint8Array(randomBytes(2000 + i)))
        const files: Record<string, Uint8Array> = {
            'card.json': strToU8(JSON.stringify({ spec: 'chara_card_v3', data: { name: 'Bot', assets: [] } })),
            'module.risum': new Uint8Array([111, 0, 0, 0, 0, 0, 0]),
        }
        pictures.forEach((picture, i) => { files[`assets/other/image/${i}.webp`] = picture })
        const archive = zipSync(files)

        uploads.length = 0
        const whole = await readCharx(archive)
        expect(uploads).toHaveLength(30)

        const staged = await stageImportFile('bot.charx', Buffer.from(archive), serverStore)
        expect(staged.data.length).toBeLessThan(archive.length / 5)
        uploads.length = 0
        const viaStubs = await withStagedAssets(NONCE, () => readCharx(staged.data))
        expect(uploads).toHaveLength(0)
        expect(viaStubs.card).toBe(whole.card)
        expect(viaStubs.assets).toEqual(whole.assets)
        expect(whole.assets['assets/other/image/3.webp']).toBe(`assets/${sha(pictures[3])}.png`)
    })

    it('PNG card: the same card text, embedded assets and profile picture', async () => {
        const emotion = new Uint8Array(5000).fill(7)
        const file = concat(
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            pngChunk('IHDR', new Uint8Array(13).fill(1)),
            text('chara', btoa('{"spec":"chara_card_v2"}')),
            text('chara-ext-asset_:0', Buffer.from(emotion).toString('base64')),
            pngChunk('IDAT', new Uint8Array(3000).fill(3)),
            pngChunk('IEND', new Uint8Array(0)),
        )
        uploads.length = 0
        const whole = await readPngCard(file)
        expect(uploads).toHaveLength(2)

        const staged = await stageImportFile('card.png', Buffer.from(file), serverStore)
        uploads.length = 0
        const viaStubs = await withStagedAssets(NONCE, () => readPngCard(staged.data))
        expect(uploads).toHaveLength(0)
        expect(viaStubs).toEqual(whole)
        expect(whole.assets['0']).toBe(`assets/${sha(emotion)}.png`)
    })

    it('a stub outside its import is only bytes', async () => {
        const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'assets/a.png': new Uint8Array(100).fill(1) })
        const staged = await stageImportFile('bot.charx', Buffer.from(archive), serverStore)
        uploads.length = 0
        const read = await readCharx(staged.data)
        expect(uploads).toHaveLength(1)
        expect(read.assets['assets/a.png']).not.toBe(`assets/${sha(new Uint8Array(100).fill(1))}.png`)
    })
})
