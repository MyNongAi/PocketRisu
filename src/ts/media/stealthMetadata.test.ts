import { afterEach, describe, expect, it, vi } from 'vitest'
import { canCarryStealth, detectStealthMetadata, findTextMetadata, readStealthMagic } from './stealthMetadata'

const enc = new TextEncoder()
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const pngChunk = (type: string, data: number[]) => [...u32be(data.length), ...enc.encode(type), ...data, 0, 0, 0, 0]
/** A PNG holding only the given tEXt chunks, enough for the text reader. */
function pngWithText(texts: Record<string, string>): Uint8Array<ArrayBuffer> {
    const chunks = Object.entries(texts).flatMap(([key, text]) => pngChunk('tEXt', [...enc.encode(key), 0, ...enc.encode(text)]))
    return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...pngChunk('IHDR', new Array(13).fill(0)), ...chunks, ...pngChunk('IEND', [])])
}
/** A JPEG whose EXIF holds one UserComment. */
function jpegWithComment(text: string): Uint8Array<ArrayBuffer> {
    const comment = [...enc.encode('ASCII\0\0\0'), ...enc.encode(text)]
    const le16 = (n: number) => [n & 255, n >> 8]
    const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
    const ifd0At = 8, exifAt = ifd0At + 2 + 12 + 4, dataAt = exifAt + 2 + 12 + 4
    const tiff = [
        0x49, 0x49, 42, 0, ...le32(ifd0At),
        ...le16(1), ...le16(0x8769), ...le16(4), ...le32(1), ...le32(exifAt), ...le32(0),
        ...le16(1), ...le16(0x9286), ...le16(7), ...le32(comment.length), ...le32(dataAt), ...le32(0),
        ...comment,
    ]
    const app1 = [...enc.encode('Exif\0\0'), ...tiff]
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1, 0xff, 0xda, 0, 2])
}
const naiComment = JSON.stringify({ prompt: '1girl, silver hair', uc: 'lowres', steps: 28, scale: 5 })
const webuiText = 'a dog\nNegative prompt: text\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 6, Seed: 1'

/**
 * Build RGBA pixel data whose alpha LSBs spell `magic` when read column-major,
 * which is the order NovelAI writes them in.
 */
function pixelsWithMagic(magic: string, width: number, height: number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4)
    // Start fully opaque so the only signal is the bit we clear.
    for (let i = 3; i < data.length; i += 4) data[i] = 255

    let bitIndex = 0
    for (const char of magic) {
        const code = char.charCodeAt(0)
        for (let b = 7; b >= 0; b--) {
            const x = Math.floor(bitIndex / height)
            const y = bitIndex % height
            const alphaAt = (y * width + x) * 4 + 3
            data[alphaAt] = (code >> b) & 1 ? 255 : 254
            bitIndex++
        }
    }
    return data
}

describe('stealth magic reading', () => {
    it('reads a magic written column-major into the alpha LSBs', () => {
        const width = 4
        const height = 40
        const data = pixelsWithMagic('stealth_pngcomp', width, height)

        expect(readStealthMagic(data, width, height)).toBe('stealth_pngcomp')
    })

    // A fully opaque image has no LSB variation at all, which is the common
    // shape for an asset that never carried metadata.
    it('does not report a magic for fully opaque pixels', () => {
        const width = 4
        const height = 40
        const data = new Uint8ClampedArray(width * height * 4).fill(255)

        expect(readStealthMagic(data, width, height)).not.toBe('stealth_pngcomp')
    })

    // The payload spans columns when the image is short, so the reader must
    // wrap rather than stop at the end of the first one.
    it('spans columns when one is shorter than the magic', () => {
        const width = 20
        const height = 8
        const data = pixelsWithMagic('stealth_pnginfo', width, height)

        expect(readStealthMagic(data, width, height)).toBe('stealth_pnginfo')
    })
})

describe('formats that can carry stealth metadata', () => {
    // Deliberately format-agnostic: the payload survives a lossless WebP encode
    // and dies in a lossy one, so extension alone never decides the answer.
    it('accepts the image formats and rejects everything else', () => {
        for (const ext of ['png', 'webp', 'PNG', 'jpeg', 'avif']) {
            expect(canCarryStealth(ext)).toBe(true)
        }
        for (const ext of ['mp3', 'mp4', 'wav', 'txt', '']) {
            expect(canCarryStealth(ext)).toBe(false)
        }
    })
})

describe('generation data outside the alpha channel', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('finds a prompt in PNG text chunks or EXIF', () => {
        expect(findTextMetadata(pngWithText({ Software: 'NovelAI', Comment: naiComment }))).toBe('pngText')
        expect(findTextMetadata(pngWithText({ parameters: webuiText }))).toBe('pngText')
        expect(findTextMetadata(jpegWithComment(webuiText))).toBe('exif')
    })

    it('does not take a title or a software name for a prompt', () => {
        expect(findTextMetadata(pngWithText({ Software: 'Photoshop', Title: 'holiday' }))).toBeNull()
        expect(findTextMetadata(jpegWithComment('holiday at the sea'))).toBeNull()
        expect(findTextMetadata(new Uint8Array([1, 2, 3]))).toBeNull()
    })

    // The red the user questioned (2026-10-28): no stealth copy, but the prompt
    // still in the file. Pixels are fully opaque, so the alpha check says absent.
    it('reports the text when the alpha channel has nothing', async () => {
        const width = 4, height = 40
        vi.stubGlobal('createImageBitmap', async () => ({ width, height, close() {} }))
        vi.stubGlobal('OffscreenCanvas', class {
            getContext() {
                return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4).fill(255) }) }
            }
        })

        expect(await detectStealthMetadata(new Blob([pngWithText({ Comment: naiComment })]))).toBe('pngText')
        expect(await detectStealthMetadata(new Blob([jpegWithComment(webuiText)]))).toBe('exif')
        expect(await detectStealthMetadata(new Blob([pngWithText({ Title: 'holiday' })]))).toBe('absent')
    })

    it('keeps green when the stealth copy is there, whatever the text says', async () => {
        const width = 4, height = 40
        vi.stubGlobal('createImageBitmap', async () => ({ width, height, close() {} }))
        vi.stubGlobal('OffscreenCanvas', class {
            getContext() {
                // The detector asks for only the first columns, so lay the
                // pixels out at the width it asked for.
                return { drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: pixelsWithMagic('stealth_pngcomp', w, h) }) }
            }
        })

        expect(await detectStealthMetadata(new Blob([pngWithText({ Comment: naiComment })]))).toBe('present')
    })
})
