import { describe, expect, it } from 'vitest'
import { fitPngToBytes, LOG_IMAGE_COPY_MAX_BYTES, nextFitScale } from './logImageFit'

describe('log image copy size', () => {
    it('scales by the square root of the size ratio, with headroom, never up', () => {
        expect(nextFitScale(40, 10)).toBeCloseTo(0.475)
        expect(nextFitScale(5, 10)).toBe(1)
    })

    it('copies an image that fits, or one that cannot be redrawn, as it is', async () => {
        const small = new Blob([new Uint8Array(10)], { type: 'image/png' })
        expect(await fitPngToBytes(small)).toBe(small)
        // jsdom has no createImageBitmap.
        const large = new Blob([new Uint8Array(LOG_IMAGE_COPY_MAX_BYTES + 1)], { type: 'image/png' })
        expect(await fitPngToBytes(large)).toBe(large)
    })
})
