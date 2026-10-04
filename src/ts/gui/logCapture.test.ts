import { describe, expect, it } from 'vitest'
import { blockSliceInPart, clampLogImageScale, clampLogImageWidth, findLogCutRow, formatLogRange, logCaptureRange, logImageFileName, LOG_IMAGE_MAX_HEIGHT, nextLogPartEnd, pickLogImageHeight, planLogImageParts } from './logCapture'

describe('logCaptureRange', () => {
    it('orders the two marked messages, either way round', () => {
        expect(logCaptureRange(3, 7)).toEqual({ from: 3, to: 7 })
        expect(logCaptureRange(7, 3)).toEqual({ from: 3, to: 7 })
        expect(logCaptureRange(-1, 2)).toEqual({ from: -1, to: 2 })
    })
})

describe('planLogImageParts', () => {
    it('keeps a short log in one image', () => {
        expect(planLogImageParts([{ top: 0, height: 200 }, { top: 200, height: 300 }], 500, 1000)).toEqual([{ top: 0, height: 500 }])
    })

    it('cuts on the top of the last message that still fits', () => {
        const blocks = [0, 300, 600, 900, 1200].map((top) => ({ top, height: 300 }))
        expect(planLogImageParts(blocks, 1500, 1000)).toEqual([
            { top: 0, height: 900 },
            { top: 900, height: 600 },
        ])
    })

    it('splits a message only when it alone is taller than an image', () => {
        const blocks = [{ top: 0, height: 100 }, { top: 100, height: 2500 }, { top: 2600, height: 100 }]
        const parts = planLogImageParts(blocks, 2700, 1000)
        // The short header is not left alone in a tiny first image.
        expect(parts[0]).toEqual({ top: 0, height: 1000 })
        expect(parts.every((part) => part.height <= 1000)).toBe(true)
        expect(parts.reduce((sum, part) => sum + part.height, 0)).toBe(2700)
        for (let i = 1; i < parts.length; i++) expect(parts[i].top).toBe(parts[i - 1].top + parts[i - 1].height)
    })

    it('returns nothing for an empty capture', () => {
        expect(planLogImageParts([], 0, 1000)).toEqual([])
    })
})

describe('nextLogPartEnd', () => {
    it('says whether the cut falls between messages', () => {
        const blocks = [0, 300, 600].map((top) => ({ top, height: 300 }))
        expect(nextLogPartEnd(blocks, 0, 900, 700)).toEqual({ end: 600, atBoundary: true })
        expect(nextLogPartEnd([{ top: 0, height: 5000 }], 0, 5000, 1000)).toEqual({ end: 1000, atBoundary: false })
        expect(nextLogPartEnd(blocks, 600, 900, 700)).toEqual({ end: 900, atBoundary: true })
    })
})

describe('findLogCutRow', () => {
    const image = (rows: string[]) => {
        // One character per pixel: '.' background, '#' ink.
        const width = rows[0].length
        const pixels = new Uint32Array(width * rows.length)
        rows.forEach((row, y) => [...row].forEach((ch, x) => { pixels[y * width + x] = ch === '#' ? 0xffffffff : 0xff202020 }))
        return { pixels, width, rows: rows.length }
    }

    it('cuts below the lowest blank gap between lines', () => {
        const { pixels, width, rows } = image([
            '#.#.', '.#.#', '....', '....', '....', '#..#', '.##.', '#..#',
        ])
        // Rows 2-4 are blank; the lowest row with blank rows on both sides is 3.
        expect(findLogCutRow(pixels, width, rows)).toBe(4)
    })

    it('finds nothing in solid text', () => {
        const { pixels, width, rows } = image(['#.#.', '.#.#', '#.#.', '.#.#'])
        expect(findLogCutRow(pixels, width, rows)).toBeNull()
    })
})

describe('blockSliceInPart', () => {
    it('maps the overlap into block and part coordinates', () => {
        expect(blockSliceInPart({ top: 800, height: 400 }, { top: 1000, height: 1000 })).toEqual({ sourceY: 200, targetY: 0, height: 200 })
        expect(blockSliceInPart({ top: 1100, height: 100 }, { top: 1000, height: 1000 })).toEqual({ sourceY: 0, targetY: 100, height: 100 })
        expect(blockSliceInPart({ top: 0, height: 100 }, { top: 1000, height: 1000 })).toBeNull()
    })
})

describe('formatLogRange', () => {
    const text = { greeting: '인사말', range: '메시지 {}부터 {}까지', single: '메시지 {}' }
    it('names a range, a single message and the greeting', () => {
        expect(formatLogRange(2, 6, text)).toBe('메시지 #3부터 #7까지')
        expect(formatLogRange(4, 4, text)).toBe('메시지 #5')
        expect(formatLogRange(-1, 1, text)).toBe('메시지 인사말부터 #2까지')
    })
})

describe('file names and width', () => {
    it('names images after the bot and 1-based message numbers', () => {
        expect(logImageFileName('Sia', 2, 6, 0, 1)).toBe('Sia_3-7.png')
        expect(logImageFileName('a/b:c', -1, 1, 1, 3)).toBe('a b c_0-2_2of3.png')
        expect(logImageFileName('', 0, 0, 0, 1)).toBe('log_1-1.png')
    })

    it('keeps the width in a usable range', () => {
        expect(clampLogImageWidth(undefined)).toBe(900)
        expect(clampLogImageWidth(100)).toBe(360)
        expect(clampLogImageWidth(5000)).toBe(1600)
        expect(clampLogImageWidth(720.4)).toBe(720)
    })

    it('keeps the text size between 100% and 250%', () => {
        expect(clampLogImageScale(undefined)).toBe(150)
        expect(clampLogImageScale(50)).toBe(100)
        expect(clampLogImageScale(400)).toBe(250)
        expect(clampLogImageScale(125)).toBe(125)
    })
})

describe('pickLogImageHeight', () => {
    it('takes the tallest height the browser holds', () => {
        const tried: number[] = []
        expect(pickLogImageHeight(900, (_w, h) => { tried.push(h); return h <= 24000 })).toBe(24000)
        expect(tried).toEqual([32000, 28000, 24000])
    })

    it('skips heights over the area limit without trying them', () => {
        const tried: number[] = []
        expect(pickLogImageHeight(10000, (_w, h) => { tried.push(h); return true })).toBe(24000)
        expect(tried).toEqual([24000])
    })

    it('falls back to the tile height when nothing taller works (Safari)', () => {
        expect(pickLogImageHeight(900, () => false)).toBe(LOG_IMAGE_MAX_HEIGHT)
    })
})
