import { describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
    LARGE_CHARX_ASSETS,
    LARGE_CHARX_BYTES,
    inspectCharx,
    isLargeCharx,
    planCharxImport,
    readCharxStats,
} from './charxPreflight'

describe('large CHARX thresholds', () => {
    it('treats either inclusive threshold as large', () => {
        expect(LARGE_CHARX_BYTES).toBe(150_000_000)
        expect(LARGE_CHARX_ASSETS).toBe(5_000)
        expect(isLargeCharx({ bytes: 149_999_999, assets: 4_999 })).toBe(false)
        expect(isLargeCharx({ bytes: 150_000_000, assets: 0 })).toBe(true)
        expect(isLargeCharx({ bytes: 1, assets: 5_000 })).toBe(true)
    })

    it('falls back to the size alone when the directory is unreadable', () => {
        expect(isLargeCharx({ bytes: 10, assets: null })).toBe(false)
        expect(isLargeCharx({ bytes: 150_000_000, assets: null })).toBe(true)
    })
})

describe('CHARX directory inspection', () => {
    const archive = () => zipSync({
        'card.json': strToU8('{}'),
        'module.risum': new Uint8Array(4),
        'assets/': new Uint8Array(),
        'assets/a.png': new Uint8Array(10_000),
        'assets/b.webp': new Uint8Array(10_000),
        'x_meta/a.json': strToU8('{}'),
    })

    it('counts asset entries without expanding them', async () => {
        const bytes = archive()
        expect(await inspectCharx(bytes)).toEqual({ bytes: bytes.length, assets: 2 })
    })

    it('reads a File the same way, slice by slice', async () => {
        const bytes = archive()
        const file = new File([new Uint8Array(bytes)], 'bot.charx')
        const slice = vi.spyOn(file, 'slice')
        expect(await inspectCharx(file)).toEqual({ bytes: bytes.length, assets: 2 })
        // Only the tail and the directory, never the whole archive in one read.
        expect(slice.mock.calls.every(([start, end]) => (end ?? 0) - (start ?? 0) <= Math.max(65_536, bytes.length))).toBe(true)
    })

    it('rejects an archive without a directory, and the stats fallback keeps the size', async () => {
        await expect(inspectCharx(new Uint8Array(30))).rejects.toThrow()
        expect(await readCharxStats(new Uint8Array(30))).toEqual({ bytes: 30, assets: null })
    })

    it('reads a ZIP64 end of central directory', async () => {
        const original = zipSync({ 'card.json': strToU8('{}'), 'assets/a.png': Uint8Array.of(1) })
        const end = original.length - 22
        const zip64 = new Uint8Array(original.length + 76)
        zip64.set(original.subarray(0, end))
        zip64.set(original.subarray(end), end + 76)
        const view = new DataView(zip64.buffer)
        const old = new DataView(original.buffer, original.byteOffset)
        view.setUint32(end, 0x06064b50, true)
        view.setBigUint64(end + 4, 44n, true)
        view.setBigUint64(end + 24, 2n, true)
        view.setBigUint64(end + 32, 2n, true)
        view.setBigUint64(end + 40, BigInt(old.getUint32(end + 12, true)), true)
        view.setBigUint64(end + 48, BigInt(old.getUint32(end + 16, true)), true)
        view.setUint32(end + 56, 0x07064b50, true)
        view.setBigUint64(end + 64, BigInt(end), true)
        view.setUint32(end + 72, 1, true)
        view.setUint16(end + 76 + 10, 0xffff, true)
        expect((await inspectCharx(zip64)).assets).toBe(1)
    })
})

describe('CHARX import plan', () => {
    // A 150 MB file whose bytes are not a ZIP, without allocating 150 MB.
    const hugeUnreadable = () => ({
        size: LARGE_CHARX_BYTES,
        slice: () => new Blob([new Uint8Array(64)]),
    }) as unknown as Blob
    const many = (count: number) => {
        const files: Record<string, Uint8Array> = { 'card.json': strToU8('{}') }
        for (let i = 0; i < count; i++) files[`assets/${i}.png`] = Uint8Array.of(i & 0xff)
        return zipSync(files, { level: 0 })
    }

    it('leaves small files, other formats and streams on the old path without asking', async () => {
        const ask = vi.fn()
        expect(await planCharxImport('bot.charx', many(3), ask)).toEqual({ kind: 'normal' })
        expect(await planCharxImport('bot.png', hugeUnreadable(), ask)).toEqual({ kind: 'normal' })
        expect(await planCharxImport('bot.charx', new ReadableStream(), ask)).toEqual({ kind: 'normal' })
        expect(ask).not.toHaveBeenCalled()
    })

    it('asks for an asset-heavy archive and follows the answer', async () => {
        const bytes = many(LARGE_CHARX_ASSETS)
        const stats = { bytes: bytes.length, assets: LARGE_CHARX_ASSETS }
        expect(await planCharxImport('Pack.CHARX', bytes, async () => 'module'))
            .toEqual({ kind: 'guarded', destination: 'module', stats })
        expect(await planCharxImport('pack.charx', bytes, async () => 'character'))
            .toEqual({ kind: 'guarded', destination: 'character', stats })
        expect(await planCharxImport('pack.charx', bytes, async () => null))
            .toEqual({ kind: 'cancel', stats })
    })

    it('asks for a large file even when its directory cannot be read', async () => {
        const ask = vi.fn(async () => 'character' as const)
        const plan = await planCharxImport('broken.charx', hugeUnreadable(), ask)
        expect(ask).toHaveBeenCalledWith({ bytes: LARGE_CHARX_BYTES, assets: null })
        expect(plan.kind).toBe('guarded')
    })
})
