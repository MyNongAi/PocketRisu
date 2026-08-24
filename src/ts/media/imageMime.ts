import { getImageType } from './imageType'

const IMAGE_MIME_BY_TYPE = {
    PNG: 'image/png',
    WEBP: 'image/webp',
    GIF: 'image/gif',
    JPEG: 'image/jpeg',
    AVIF: 'image/avif',
    BMP: 'image/bmp',
} as const

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    avif: 'image/avif',
    bmp: 'image/bmp',
}

/**
 * Legacy assets can have a .png suffix around WebP/GIF/JPEG bytes. Prefer byte
 * sniffing, then use the path for unknown formats and old empty placeholders.
 */
export function getInlineImageMimeType(loc: string, data: Uint8Array): string {
    const detected = getImageType(data)
    if (detected !== 'Unknown') return IMAGE_MIME_BY_TYPE[detected]

    const pathWithoutQuery = loc.split(/[?#]/, 1)[0]
    const extension = pathWithoutQuery.split('.').pop()?.toLowerCase() ?? ''
    return IMAGE_MIME_BY_EXTENSION[extension] ?? 'image/png'
}
