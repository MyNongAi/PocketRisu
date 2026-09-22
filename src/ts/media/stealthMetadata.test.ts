import { describe, expect, it } from 'vitest'
import { canCarryStealth, readStealthMagic } from './stealthMetadata'

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
