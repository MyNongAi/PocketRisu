import { getImageType, type ImageType } from './media/imageType'

export const PERSONA_IMAGE_EXTENSIONS = ['png', 'webp', 'gif', 'jpg', 'jpeg'] as const
export const MAX_PERSONA_IMAGE_BYTES = 32 * 1024 * 1024

export type PersonaImageInfo = {
    type: Extract<ImageType, 'PNG' | 'WEBP' | 'GIF' | 'JPEG'>
    extension: 'png' | 'webp' | 'gif' | 'jpg'
    mime: 'image/png' | 'image/webp' | 'image/gif' | 'image/jpeg'
    width: number
    height: number
}

export type PersonaImageDecoder = (
    data: Uint8Array,
    mime: PersonaImageInfo['mime'],
) => Promise<{ width: number, height: number }>

const TYPE_DETAILS: Record<PersonaImageInfo['type'], Pick<PersonaImageInfo, 'extension' | 'mime'>> = {
    PNG: { extension: 'png', mime: 'image/png' },
    WEBP: { extension: 'webp', mime: 'image/webp' },
    GIF: { extension: 'gif', mime: 'image/gif' },
    JPEG: { extension: 'jpg', mime: 'image/jpeg' },
}

function readUint16BE(data: Uint8Array, offset: number): number | null {
    if (offset < 0 || offset + 2 > data.byteLength) return null
    return (data[offset] << 8) | data[offset + 1]
}

function readUint16LE(data: Uint8Array, offset: number): number | null {
    if (offset < 0 || offset + 2 > data.byteLength) return null
    return data[offset] | (data[offset + 1] << 8)
}

function readUint24LE(data: Uint8Array, offset: number): number | null {
    if (offset < 0 || offset + 3 > data.byteLength) return null
    return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)
}

function readUint32BE(data: Uint8Array, offset: number): number | null {
    if (offset < 0 || offset + 4 > data.byteLength) return null
    return (
        (data[offset] * 0x1000000)
        + (data[offset + 1] << 16)
        + (data[offset + 2] << 8)
        + data[offset + 3]
    ) >>> 0
}

function readUint32LE(data: Uint8Array, offset: number): number | null {
    if (offset < 0 || offset + 4 > data.byteLength) return null
    return (
        data[offset]
        + (data[offset + 1] << 8)
        + (data[offset + 2] << 16)
        + (data[offset + 3] * 0x1000000)
    ) >>> 0
}

function bytesEqual(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
    if (offset < 0 || offset + expected.length > data.byteLength) return false
    return expected.every((value, index) => data[offset + index] === value)
}

function readPngDimensions(data: Uint8Array): { width: number, height: number } | null {
    // A complete PNG must have an IHDR and a terminal IEND chunk. The browser
    // decoder below remains the final authority, but these checks reject tiny
    // signature-only files before an Object URL is created.
    if (data.byteLength < 45) return null
    if (readUint32BE(data, 8) !== 13 || !bytesEqual(data, 12, [0x49, 0x48, 0x44, 0x52])) return null
    if (!bytesEqual(data, data.byteLength - 12, [
        0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44,
        0xae, 0x42, 0x60, 0x82,
    ])) return null

    const width = readUint32BE(data, 16)
    const height = readUint32BE(data, 20)
    return width && height ? { width, height } : null
}

function readGifDimensions(data: Uint8Array): { width: number, height: number } | null {
    if (data.byteLength < 14 || data[data.byteLength - 1] !== 0x3b) return null
    const width = readUint16LE(data, 6)
    const height = readUint16LE(data, 8)
    return width && height ? { width, height } : null
}

function readWebpDimensions(data: Uint8Array): { width: number, height: number } | null {
    if (data.byteLength < 30) return null
    const declaredLength = readUint32LE(data, 4)
    if (declaredLength === null || declaredLength + 8 > data.byteLength) return null

    let offset = 12
    while (offset + 8 <= declaredLength + 8) {
        const chunkSize = readUint32LE(data, offset + 4)
        if (chunkSize === null) return null
        const payload = offset + 8
        const chunkEnd = payload + chunkSize
        if (chunkEnd > data.byteLength || chunkEnd > declaredLength + 8) return null

        if (bytesEqual(data, offset, [0x56, 0x50, 0x38, 0x58]) && chunkSize >= 10) {
            const widthMinusOne = readUint24LE(data, payload + 4)
            const heightMinusOne = readUint24LE(data, payload + 7)
            if (widthMinusOne !== null && heightMinusOne !== null) {
                return { width: widthMinusOne + 1, height: heightMinusOne + 1 }
            }
        }

        if (bytesEqual(data, offset, [0x56, 0x50, 0x38, 0x4c]) && chunkSize >= 5 && data[payload] === 0x2f) {
            const bits = readUint32LE(data, payload + 1)
            if (bits !== null) {
                return {
                    width: (bits & 0x3fff) + 1,
                    height: ((bits >>> 14) & 0x3fff) + 1,
                }
            }
        }

        if (
            bytesEqual(data, offset, [0x56, 0x50, 0x38, 0x20])
            && chunkSize >= 10
            && bytesEqual(data, payload + 3, [0x9d, 0x01, 0x2a])
        ) {
            const widthBits = readUint16LE(data, payload + 6)
            const heightBits = readUint16LE(data, payload + 8)
            const width = widthBits === null ? 0 : widthBits & 0x3fff
            const height = heightBits === null ? 0 : heightBits & 0x3fff
            if (width && height) return { width, height }
        }

        offset = chunkEnd + (chunkSize % 2)
    }

    return null
}

function isJpegStartOfFrame(marker: number): boolean {
    return marker >= 0xc0
        && marker <= 0xcf
        && ![0xc4, 0xc8, 0xcc].includes(marker)
}

function readJpegDimensions(data: Uint8Array): { width: number, height: number } | null {
    if (data.byteLength < 12 || !bytesEqual(data, 0, [0xff, 0xd8])) return null
    if (!bytesEqual(data, data.byteLength - 2, [0xff, 0xd9])) return null

    let offset = 2
    while (offset + 4 <= data.byteLength) {
        while (offset < data.byteLength && data[offset] === 0xff) offset += 1
        if (offset >= data.byteLength) return null
        const marker = data[offset++]
        if (marker === 0xd9 || marker === 0xda) return null
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue

        const segmentLength = readUint16BE(data, offset)
        if (segmentLength === null || segmentLength < 2 || offset + segmentLength > data.byteLength) return null
        if (isJpegStartOfFrame(marker)) {
            if (segmentLength < 7) return null
            const height = readUint16BE(data, offset + 3)
            const width = readUint16BE(data, offset + 5)
            return width && height ? { width, height } : null
        }
        offset += segmentLength
    }

    return null
}

/**
 * Fast structural validation and metadata extraction. This deliberately does
 * more than magic-byte sniffing; validatePersonaImage() additionally asks the
 * browser's real image decoder before any existing persona icon is replaced.
 */
export function getPersonaImageInfo(data: Uint8Array): PersonaImageInfo | null {
    if (data.byteLength === 0 || data.byteLength > MAX_PERSONA_IMAGE_BYTES) return null

    const type = getImageType(data)
    let dimensions: { width: number, height: number } | null = null
    if (type === 'PNG') dimensions = readPngDimensions(data)
    else if (type === 'GIF') dimensions = readGifDimensions(data)
    else if (type === 'WEBP') dimensions = readWebpDimensions(data)
    else if (type === 'JPEG') dimensions = readJpegDimensions(data)
    else return null

    if (!dimensions) return null
    return {
        type,
        ...TYPE_DETAILS[type],
        ...dimensions,
    }
}

export function isSupportedPersonaImage(data: Uint8Array): boolean {
    return getPersonaImageInfo(data) !== null
}

/** Decode through the browser while always releasing the temporary URL. */
export async function decodePersonaImageInBrowser(
    data: Uint8Array,
    mime: PersonaImageInfo['mime'],
): Promise<{ width: number, height: number }> {
    if (
        typeof Image === 'undefined'
        || typeof globalThis.URL === 'undefined'
        || typeof globalThis.URL.createObjectURL !== 'function'
    ) {
        throw new Error('A browser image decoder is not available')
    }

    // Copying gives Blob an ArrayBuffer-backed view even when callers supplied
    // a Buffer/SharedArrayBuffer-compatible Uint8Array.
    const blob = new Blob([Uint8Array.from(data)], { type: mime })
    const objectUrl = globalThis.URL.createObjectURL(blob)
    let image: HTMLImageElement | null = null

    try {
        image = new Image()
        return await new Promise((resolve, reject) => {
            image.onload = () => {
                const width = image.naturalWidth || image.width
                const height = image.naturalHeight || image.height
                if (width > 0 && height > 0) resolve({ width, height })
                else reject(new Error('Image has invalid dimensions'))
            }
            image.onerror = () => reject(new Error('Image could not be decoded'))
            image.src = objectUrl
        })
    } finally {
        if (image) {
            image.onload = null
            image.onerror = null
        }
        globalThis.URL.revokeObjectURL(objectUrl)
    }
}

export async function validatePersonaImage(
    data: Uint8Array,
    decoder: PersonaImageDecoder = decodePersonaImageInBrowser,
): Promise<PersonaImageInfo> {
    const info = getPersonaImageInfo(data)
    if (!info) throw new Error('Unsupported, oversized, or corrupt persona image')

    const decoded = await decoder(data, info.mime)
    if (!Number.isFinite(decoded.width) || !Number.isFinite(decoded.height) || decoded.width <= 0 || decoded.height <= 0) {
        throw new Error('Image has invalid dimensions')
    }

    return {
        ...info,
        width: decoded.width,
        height: decoded.height,
    }
}
