// Detect NovelAI's "stealth" metadata — the generation parameters it hides in
// an image's alpha-channel least significant bits, read column-major.
//
// This is what decides whether an asset can be dropped back onto NovelAI's site
// and reproduce its prompt. It is independent of the file format: the payload
// survives a lossless WebP encode and dies in a lossy one, so a `.webp` may
// carry it and a `.png` may not. Verified against real assets of both kinds.
//
// Only the 15-byte magic is read, from as few pixel columns as that needs, so
// the cost is dominated by decoding the image rather than by scanning it.
//
// Without the stealth copy an image can still say how it was made in its PNG
// text chunks or EXIF, and the icon showed that as red all the same (the
// user's question, 2026-10-28). Those are 'pngText' and 'exif', shown yellow:
// 🎨 reads them, but they are the first thing other sites strip.

import { isPng, metaFromTexts, readExifText, readPngText } from '../process/imageMeta'

export type StealthStatus = 'present' | 'pngText' | 'exif' | 'absent' | 'unsupported' | 'error'

const MAGICS = ['stealth_pnginfo', 'stealth_pngcomp', 'stealth_rgbinfo', 'stealth_rgbcomp']
const MAGIC_BITS = 15 * 8

/** Formats that can hold the payload at all; audio and video never can. */
const IMAGE_EXTENSIONS = new Set(['png', 'webp', 'avif', 'bmp', 'jpg', 'jpeg', 'gif'])

export function canCarryStealth(extension: string): boolean {
    return IMAGE_EXTENSIONS.has(extension.toLowerCase())
}

/**
 * Read the magic out of the alpha LSBs of an already-decoded image.
 * Exported for tests; callers normally use detectStealthMetadata.
 */
export function readStealthMagic(data: Uint8ClampedArray, width: number, height: number): string {
    let bits = ''
    outer:
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            bits += data[(y * width + x) * 4 + 3] & 1
            if (bits.length >= MAGIC_BITS) break outer
        }
    }
    let magic = ''
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        magic += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2))
    }
    return magic
}

/**
 * Where an image keeps its generation data outside the alpha channel: PNG text
 * chunks or EXIF, or null. Only text that reads as a prompt counts, so a camera
 * note or a bare title is not taken for one.
 */
export function findTextMetadata(bytes: Uint8Array): 'pngText' | 'exif' | null {
    if (isPng(bytes)) return metaFromTexts(readPngText(bytes)) ? 'pngText' : null
    const texts = readExifText(bytes)
    if (texts.length === 0) return null
    return metaFromTexts(Object.fromEntries(texts.map((text, index) => [`exif${index}`, text]))) ? 'exif' : null
}

/**
 * Whether `blob` carries NovelAI stealth metadata, and if not, whether its
 * text fields still hold the prompt.
 *
 * Returns 'unsupported' when the environment has no canvas to decode with, so
 * callers can tell "no metadata" apart from "could not look".
 */
export async function detectStealthMetadata(blob: Blob): Promise<StealthStatus> {
    const alpha = await readAlphaStatus(blob)
    if (alpha !== 'absent') return alpha
    try {
        return findTextMetadata(new Uint8Array(await blob.arrayBuffer())) ?? 'absent'
    } catch {
        return 'absent'
    }
}

async function readAlphaStatus(blob: Blob): Promise<StealthStatus> {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
        return 'unsupported'
    }

    let bitmap: ImageBitmap
    try {
        bitmap = await createImageBitmap(blob)
    } catch {
        return 'error'
    }

    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return 'unsupported'
        context.drawImage(bitmap, 0, 0)

        // The magic never runs past the first columns, so only read those.
        const columns = Math.min(bitmap.width, Math.ceil(MAGIC_BITS / Math.max(1, bitmap.height)))
        const { data } = context.getImageData(0, 0, columns, bitmap.height)
        const magic = readStealthMagic(data, columns, bitmap.height)
        return MAGICS.includes(magic) ? 'present' : 'absent'
    } catch {
        return 'error'
    } finally {
        bitmap.close?.()
    }
}
