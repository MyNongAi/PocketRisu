// Log image capture: the pure parts (range, file name, how a tall log is cut
// into images). The rendering lives in logCaptureRender.ts, the ✂️ selection
// in logCaptureState.svelte.ts.

/**
 * Tallest tile html-to-image draws (pixels): it squeezes a canvas above
 * 16384 px. Also the image height when the browser takes nothing taller.
 */
export const LOG_IMAGE_MAX_HEIGHT = 16000
/**
 * Image heights to try, tallest first (pixels): as much of the log as the
 * browser lets one canvas hold goes into one image, so one copy takes it all.
 * Chromium and Firefox take 32767 px a side; Safari's area limit is far lower.
 */
export const LOG_IMAGE_HEIGHT_STEPS = [32000, 28000, 24000, 20000] as const
/** Chromium's canvas area limit; no browser takes more. */
export const LOG_IMAGE_MAX_AREA = 268_435_456

/** The tallest step a `width` px canvas takes, by `works`; LOG_IMAGE_MAX_HEIGHT when none does. */
export function pickLogImageHeight(width: number, works: (width: number, height: number) => boolean): number {
    for (const height of LOG_IMAGE_HEIGHT_STEPS) {
        if (width * height > LOG_IMAGE_MAX_AREA) continue
        if (works(width, height)) return height
    }
    return LOG_IMAGE_MAX_HEIGHT
}
/** A cut may move up to a message boundary, but never leave an image shorter than this share. */
export const LOG_IMAGE_MIN_PART_SHARE = 0.25
export const LOG_IMAGE_DEFAULT_WIDTH = 900
export const LOG_IMAGE_MIN_WIDTH = 360
export const LOG_IMAGE_MAX_WIDTH = 1600
export const LOG_IMAGE_DEFAULT_SCALE = 150

/** One rendered block (header or message) in the capture root, in CSS px from its top. */
export interface LogBlock {
    top: number
    height: number
}

/** One output image: the slice [top, top + height) of the capture root. */
export interface LogPart {
    top: number
    height: number
}

/** The two marked messages in reading order; the greeting is -1. */
export function logCaptureRange(a: number, b: number): { from: number; to: number } {
    return a <= b ? { from: a, to: b } : { from: b, to: a }
}

export function clampLogImageWidth(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : LOG_IMAGE_DEFAULT_WIDTH
    return Math.min(LOG_IMAGE_MAX_WIDTH, Math.max(LOG_IMAGE_MIN_WIDTH, n))
}

/** Text size in percent: the log is laid out at width / scale and drawn at scale. */
export function clampLogImageScale(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : LOG_IMAGE_DEFAULT_SCALE
    return Math.min(250, Math.max(100, n))
}

/**
 * Where the image starting at `start` ends. It ends on the top of a message
 * when one is close enough below the limit (`atBoundary`), so a message is
 * cut only when it alone is too tall for an image.
 */
export function nextLogPartEnd(blocks: readonly LogBlock[], start: number, totalHeight: number, maxHeight = LOG_IMAGE_MAX_HEIGHT): { end: number; atBoundary: boolean } {
    const total = Math.max(0, Math.ceil(totalHeight))
    const limitHeight = Math.max(1, Math.floor(maxHeight))
    const limit = start + limitHeight
    if (limit >= total) return { end: total, atBoundary: true }
    const earliest = start + limitHeight * LOG_IMAGE_MIN_PART_SHARE
    let best = -1
    for (const block of blocks) {
        const top = Math.round(block.top)
        if (top > earliest && top <= limit && top > best) best = top
    }
    return best > 0 ? { end: best, atBoundary: true } : { end: limit, atBoundary: false }
}

/** Cuts a capture of `totalHeight` px into images no taller than `maxHeight`. */
export function planLogImageParts(blocks: readonly LogBlock[], totalHeight: number, maxHeight = LOG_IMAGE_MAX_HEIGHT): LogPart[] {
    const total = Math.max(0, Math.ceil(totalHeight))
    const parts: LogPart[] = []
    let start = 0
    while (start < total) {
        const { end } = nextLogPartEnd(blocks, start, total, maxHeight)
        parts.push({ top: start, height: end - start })
        start = end
    }
    return parts
}

/**
 * A cut through the middle of a message moves up to a blank row between
 * lines of text: one that equals the rows above and below it across the
 * whole width. `pixels` is the bottom of the image (RGBA as 32-bit words,
 * `rows` rows of `width`); returns how many of those rows to keep (the
 * blank row stays above the cut), or null when no blank row is found.
 */
export function findLogCutRow(pixels: Uint32Array, width: number, rows: number): number | null {
    const rowEquals = (a: number, b: number) => {
        const offsetA = a * width
        const offsetB = b * width
        for (let x = 0; x < width; x++) {
            if (pixels[offsetA + x] !== pixels[offsetB + x]) return false
        }
        return true
    }
    for (let y = rows - 2; y >= 1; y--) {
        if (rowEquals(y, y - 1) && rowEquals(y, y + 1)) return y + 1
    }
    return null
}

/** The part of a block that falls inside a part, in both coordinate systems. */
export function blockSliceInPart(block: LogBlock, part: LogPart): { sourceY: number; targetY: number; height: number } | null {
    const top = Math.max(block.top, part.top)
    const bottom = Math.min(block.top + block.height, part.top + part.height)
    if (bottom <= top) return null
    return { sourceY: top - block.top, targetY: top - part.top, height: bottom - top }
}

/** Message number shown to people: the greeting is 0, the first message 1. */
export function logMessageNumber(index: number): number {
    return index + 1
}

/** "messages #3 to #7", or "message #3" for one; the greeting by name. */
export function formatLogRange(from: number, to: number, text: { greeting: string; range: string; single: string }): string {
    const label = (index: number) => index < 0 ? text.greeting : `#${logMessageNumber(index)}`
    if (from === to) return text.single.replace('{}', label(from))
    return text.range.replace('{}', label(from)).replace('{}', label(to))
}

function safeFilePart(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
}

export function logImageFileName(characterName: string, from: number, to: number, part: number, partCount: number): string {
    const name = safeFilePart(characterName) || 'log'
    const range = `${logMessageNumber(from)}-${logMessageNumber(to)}`
    const suffix = partCount > 1 ? `_${part + 1}of${partCount}` : ''
    return `${name}_${range}${suffix}.png`
}
