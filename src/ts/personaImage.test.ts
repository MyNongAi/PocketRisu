import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    decodePersonaImageInBrowser,
    getPersonaImageInfo,
    isSupportedPersonaImage,
    validatePersonaImage,
} from './personaImage'

const VALID_PNG = new Uint8Array(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
))

const VALID_GIF = new Uint8Array(Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    'base64',
))

const STRUCTURAL_WEBP_VP8X = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
])

const STRUCTURAL_JPEG = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
])

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('persona image validation', () => {
    it('accepts complete minimal PNG and GIF images with dimensions', () => {
        expect(getPersonaImageInfo(VALID_PNG)).toMatchObject({
            type: 'PNG', extension: 'png', mime: 'image/png', width: 1, height: 1,
        })
        expect(getPersonaImageInfo(VALID_GIF)).toMatchObject({
            type: 'GIF', extension: 'gif', mime: 'image/gif', width: 1, height: 1,
        })
    })

    it('maps structurally complete WebP and JPEG data to their real storage extensions', () => {
        expect(getPersonaImageInfo(STRUCTURAL_WEBP_VP8X)).toMatchObject({
            type: 'WEBP', extension: 'webp', mime: 'image/webp', width: 1, height: 1,
        })
        expect(getPersonaImageInfo(STRUCTURAL_JPEG)).toMatchObject({
            type: 'JPEG', extension: 'jpg', mime: 'image/jpeg', width: 1, height: 1,
        })
    })

    it('rejects header-only, truncated, empty, and renamed non-image data', () => {
        expect(isSupportedPersonaImage(VALID_PNG.slice(0, -12))).toBe(false)
        expect(isSupportedPersonaImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false)
        expect(isSupportedPersonaImage(new Uint8Array())).toBe(false)
        expect(isSupportedPersonaImage(new TextEncoder().encode('not really a png'))).toBe(false)
    })

    it('requires the real decoder to return positive dimensions', async () => {
        const decoder = vi.fn(async () => ({ width: 1, height: 1 }))
        await expect(validatePersonaImage(VALID_PNG, decoder)).resolves.toMatchObject({ width: 1, height: 1 })
        expect(decoder).toHaveBeenCalledWith(VALID_PNG, 'image/png')

        await expect(validatePersonaImage(
            VALID_PNG,
            async () => ({ width: 0, height: 1 }),
        )).rejects.toThrow('invalid dimensions')
    })

    it('revokes the temporary Object URL after a successful browser decode', async () => {
        const createObjectURL = vi.fn(() => 'blob:persona-image')
        const revokeObjectURL = vi.fn()
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
        vi.stubGlobal('Image', class {
            naturalWidth = 1
            naturalHeight = 1
            width = 0
            height = 0
            onload: (() => void) | null = null
            onerror: (() => void) | null = null
            set src(_value: string) {
                queueMicrotask(() => this.onload?.())
            }
        })

        await expect(decodePersonaImageInBrowser(VALID_PNG, 'image/png')).resolves.toEqual({ width: 1, height: 1 })
        expect(createObjectURL).toHaveBeenCalledOnce()
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:persona-image')
    })

    it('also revokes the temporary Object URL when decoding fails', async () => {
        const revokeObjectURL = vi.fn()
        vi.stubGlobal('URL', { createObjectURL: () => 'blob:broken-persona-image', revokeObjectURL })
        vi.stubGlobal('Image', class {
            naturalWidth = 0
            naturalHeight = 0
            width = 0
            height = 0
            onload: (() => void) | null = null
            onerror: (() => void) | null = null
            set src(_value: string) {
                queueMicrotask(() => this.onerror?.())
            }
        })

        await expect(decodePersonaImageInBrowser(VALID_PNG, 'image/png')).rejects.toThrow('could not be decoded')
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:broken-persona-image')
    })

    it('revokes the Object URL even if the browser image constructor fails', async () => {
        const revokeObjectURL = vi.fn()
        vi.stubGlobal('URL', { createObjectURL: () => 'blob:constructor-failure', revokeObjectURL })
        vi.stubGlobal('Image', class {
            constructor() {
                throw new Error('Image constructor failed')
            }
        })

        await expect(decodePersonaImageInBrowser(VALID_PNG, 'image/png')).rejects.toThrow('constructor failed')
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:constructor-failure')
    })
})
