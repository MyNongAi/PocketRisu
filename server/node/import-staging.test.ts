import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { unzipSync, zipSync, strToU8 } from 'fflate'
import stagingPkg from './import-staging.cjs'

const {
    StagingStopped,
    stageImportFile,
    stagedFormatOf,
    RPACK_MAP,
    RPACK_ENCODE,
    RPACK_DECODE,
    parseRisum,
    readPng,
    rpack,
} = stagingPkg as any

const NONCE = '0123456789abcdef0123456789abcdef'
const sha = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex')
const stubOf = (ref: string) => `PRSTAGE1:${NONCE}:${ref}\n`

/** An asset store that answers like the external one, recording what it got. */
function fakeStore(options: { fail?: string } = {}) {
    const writes = new Map<string, Buffer>()
    return {
        writes,
        ctx: {
            nonce: NONCE,
            writeAsset: async (key: string, data: Buffer) => {
                if (options.fail && data.toString('utf-8') === options.fail) throw new Error('disk full')
                expect(key).toBe(`assets/${sha(data)}.png`)
                writes.set(key, Buffer.from(data))
                return `external://main-assets/${sha(data)}`
            },
        },
    }
}

function risum(main: object, assets: Uint8Array[]): Buffer {
    const len = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b }
    const encodedMain = rpack(Buffer.from(JSON.stringify({ type: 'risuModule', module: main })), RPACK_ENCODE)
    const parts = [Buffer.from([111, 0]), len(encodedMain.length), encodedMain]
    for (const asset of assets) {
        const encoded = rpack(Buffer.from(asset), RPACK_ENCODE)
        parts.push(Buffer.from([1]), len(encoded.length), encoded)
    }
    parts.push(Buffer.from([0]))
    return Buffer.concat(parts)
}

function pngChunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    return Buffer.concat([head, data, Buffer.alloc(4)])
}
const textChunk = (key: string, value: string) => pngChunk('tEXt', Buffer.concat([Buffer.from(key), Buffer.from([0]), Buffer.from(value)]))
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IHDR = pngChunk('IHDR', Buffer.from('header-bytes'))
const IDAT = pngChunk('IDAT', Buffer.from('picture-bytes'))
const IEND = pngChunk('IEND', Buffer.alloc(0))

describe('the RPack map', () => {
    it('is the one the client decodes modules with', () => {
        const file = fs.readFileSync(path.join(__dirname, '../../src/ts/rpack/rpack_map.bin'))
        expect(Buffer.compare(RPACK_MAP, file)).toBe(0)
        const sample = Buffer.from('any bytes \u0000ÿ')
        expect(rpack(rpack(sample, RPACK_ENCODE), RPACK_DECODE).equals(sample)).toBe(true)
    })
})

describe('which files are staged', () => {
    it('bots and modules by their importer formats, nothing else', () => {
        expect(stagedFormatOf('Bot.CHARX')).toBe('charx')
        expect(stagedFormatOf('bot.jpeg')).toBe('charx')
        expect(stagedFormatOf('card.png')).toBe('png')
        expect(stagedFormatOf('assets.risum')).toBe('risum')
        expect(stagedFormatOf('preset.risup')).toBeNull()
        expect(stagedFormatOf('plugin.js')).toBeNull()
    })
})

describe('CHARX', () => {
    const card = strToU8(JSON.stringify({ spec: 'chara_card_v3', data: { name: 'Bot' } }))
    const picture = new Uint8Array([1, 2, 3, 4, 5])
    const sound = new Uint8Array([9, 9, 9])
    const moduleAsset = new Uint8Array([7, 7])

    it('stores every asset, stubs it in place and keeps the card and module text', async () => {
        const archive = zipSync({
            'card.json': card,
            'assets/icon/image/main.png': picture,
            'assets/other/audio/한글.mp3': sound,
            'x_meta/main.json': strToU8('{"type":"png"}'),
            'module.risum': risum({ name: 'inner', assets: [['a', '', 'png']] }, [moduleAsset]),
        })
        const store = fakeStore()
        const staged = await stageImportFile('Bot.charx', Buffer.from(archive), store.ctx)

        expect(staged.format).toBe('charx')
        expect(staged.assets).toBe(3)
        const out = unzipSync(staged.data)
        expect(Object.keys(out)[0]).toBe('card.json')
        expect(Buffer.from(out['card.json']).equals(Buffer.from(card))).toBe(true)
        // The importer ignores other JSON; it is not sent.
        expect(out['x_meta/main.json']).toBeUndefined()
        expect(Buffer.from(out['assets/icon/image/main.png']).toString()).toBe(stubOf(`external://main-assets/${sha(picture)}`))
        expect(Buffer.from(out['assets/other/audio/한글.mp3']).toString()).toBe(stubOf(`external://main-assets/${sha(sound)}`))
        expect(store.writes.get(`assets/${sha(picture)}.png`)?.equals(Buffer.from(picture))).toBe(true)

        const inner = parseRisum(Buffer.from(out['module.risum']))
        expect(inner.assets).toHaveLength(1)
        expect(rpack(inner.assets[0], RPACK_DECODE).toString()).toBe(stubOf(`external://main-assets/${sha(moduleAsset)}`))
        expect(store.writes.has(`assets/${sha(moduleAsset)}.png`)).toBe(true)
    })

    it('stores nothing for an archive without a card (the importer refuses it)', async () => {
        const store = fakeStore()
        const staged = await stageImportFile('Bot.charx', Buffer.from(zipSync({ 'assets/a.png': picture })), store.ctx)
        expect(store.writes.size).toBe(0)
        expect(Object.keys(unzipSync(staged.data))).toEqual([])
    })

    it('reads a JPEG with the archive after the picture, as the importer streams it', async () => {
        const jpegCharx = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]), Buffer.from(zipSync({ 'card.json': card, 'assets/a.png': picture }))])
        const store = fakeStore()
        const staged = await stageImportFile('Bot.jpeg', jpegCharx, store.ctx)
        expect(Buffer.from(unzipSync(staged.data)['assets/a.png']).toString()).toBe(stubOf(`external://main-assets/${sha(picture)}`))
    })

    it('fails, with every write settled, when one asset cannot be stored', async () => {
        const store = fakeStore({ fail: 'bad' })
        const archive = zipSync({ 'card.json': card, 'assets/ok.png': picture, 'assets/bad.png': strToU8('bad') })
        await expect(stageImportFile('Bot.charx', Buffer.from(archive), store.ctx)).rejects.toThrow('disk full')
        expect(store.writes.has(`assets/${sha(picture)}.png`)).toBe(true)
    })

    it('stops when nobody waits any more', async () => {
        const store = fakeStore()
        const archive = zipSync({ 'card.json': card, 'assets/a.png': picture })
        await expect(stageImportFile('Bot.charx', Buffer.from(archive), { ...store.ctx, stopped: () => true })).rejects.toBeInstanceOf(StagingStopped)
    })
})

describe('PNG cards', () => {
    const embedded = Buffer.from('embedded emotion picture')

    it('stores the chunk assets and the picture, and keeps the card text', async () => {
        const file = Buffer.concat([
            SIGNATURE, IHDR,
            textChunk('chara', 'Y2FyZA=='),
            textChunk('chara-ext-asset_:0', embedded.toString('base64')),
            textChunk('Software', 'some editor'),
            IDAT, IEND,
        ])
        const store = fakeStore()
        const staged = await stageImportFile('card.png', file, store.ctx)
        expect(staged.assets).toBe(2)

        const out = readPng(staged.data)
        expect(out.texts.map((t: any) => t.key)).toEqual(['chara', 'chara-ext-asset_:0'])
        expect(out.texts[0].value).toBe('Y2FyZA==')
        expect(Buffer.from(out.texts[1].value, 'base64').toString()).toBe(stubOf(`external://main-assets/${sha(embedded)}`))
        // The picture the importer saves is the file without its text chunks.
        const picture = Buffer.concat([SIGNATURE, IHDR, IDAT, IEND])
        expect(store.writes.get(`assets/${sha(picture)}.png`)?.equals(picture)).toBe(true)
        expect(out.trimmed.toString('latin1')).toContain(stubOf(`external://main-assets/${sha(picture)}`))
        expect(out.trimmed.length).toBeLessThan(1024)
    })

    it('sends a bare shell for a picture that is not a card, storing nothing', async () => {
        const store = fakeStore()
        const staged = await stageImportFile('photo.png', Buffer.concat([SIGNATURE, IHDR, IDAT, IEND]), store.ctx)
        expect(store.writes.size).toBe(0)
        expect(readPng(staged.data).texts).toEqual([])
    })

    it('leaves a cut-off file whole', async () => {
        const file = Buffer.concat([SIGNATURE, IHDR, textChunk('chara', 'eA==')]).subarray(0, 30)
        expect(await stageImportFile('card.png', file, fakeStore().ctx)).toBeNull()
    })
})

describe('.risum modules', () => {
    it('stores each asset and stubs it, keeping the module data', async () => {
        const assets = [new Uint8Array([1, 1]), new Uint8Array([2, 2, 2])]
        const file = risum({ name: 'm', assets: [['a', '', 'png'], ['b', '', 'png']] }, assets)
        const store = fakeStore()
        const staged = await stageImportFile('m.risum', file, store.ctx)
        const parsed = parseRisum(staged.data)
        expect(parsed.main.equals(parseRisum(file).main)).toBe(true)
        expect(parsed.assets.map((a: Buffer) => rpack(a, RPACK_DECODE).toString())).toEqual(
            assets.map((a) => stubOf(`external://main-assets/${sha(a)}`)))
        expect(store.writes.size).toBe(2)
    })

    it('leaves files the module reader would refuse whole', async () => {
        const store = fakeStore()
        expect(await stageImportFile('m.risum', Buffer.from([1, 2, 3]), store.ctx)).toBeNull()
        // An asset without metadata fails the import: not staged.
        expect(await stageImportFile('m.risum', risum({ name: 'm', assets: [] }, [new Uint8Array([1])]), store.ctx)).toBeNull()
        expect(store.writes.size).toBe(0)
    })
})
