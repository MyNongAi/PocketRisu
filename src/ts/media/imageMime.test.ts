import { describe, expect, it } from 'vitest'
import { getInlineImageMimeType } from './imageMime'

describe('inline image MIME inference', () => {
    it('prefers actual bytes for legacy assets saved with a .png suffix', () => {
        const webpBytes = new Uint8Array([
            0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0,
            0x57, 0x45, 0x42, 0x50,
        ])
        expect(getInlineImageMimeType('assets/legacy.png', webpBytes)).toBe('image/webp')
    })

    it('falls back to a real path extension when bytes are unknown', () => {
        expect(getInlineImageMimeType('assets/persona.jpeg?cache=1', new Uint8Array([1, 2, 3])))
            .toBe('image/jpeg')
    })

    it('keeps PNG as the compatibility default', () => {
        expect(getInlineImageMimeType('assets/unknown', new Uint8Array([1, 2, 3])))
            .toBe('image/png')
    })
})
