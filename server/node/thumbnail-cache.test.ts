import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { cacheFileName, createThumbnailCache } = require('./thumbnail-cache.cjs')

const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir() {
    const dir = await mkdtemp(join(tmpdir(), 'pocketrisu-thumbnails-'))
    tempDirs.push(dir)
    return dir
}

describe('thumbnail cache', () => {
    it('deduplicates concurrent generation and reuses the disk result', async () => {
        const rootDir = await makeTempDir()
        const generate = vi.fn(async (source: Buffer) => Buffer.from(`thumb:${source}`))
        const loadSource = vi.fn(async () => Buffer.from('original'))
        const cache = createThumbnailCache({ rootDir, generate, maxConcurrent: 1 })

        const [first, second] = await Promise.all([
            cache.get('asset-a:v1', loadSource),
            cache.get('asset-a:v1', loadSource),
        ])

        expect(first.data.toString()).toBe('thumb:original')
        expect(second.data.toString()).toBe('thumb:original')
        expect(loadSource).toHaveBeenCalledOnce()
        expect(generate).toHaveBeenCalledOnce()

        const third = await cache.get('asset-a:v1', loadSource)
        expect(third.source).toBe('cache')
        expect(loadSource).toHaveBeenCalledOnce()
    })

    it('bounds persistent thumbnails with least-recently-used pruning', async () => {
        const rootDir = await makeTempDir()
        const cache = createThumbnailCache({
            rootDir,
            maxBytes: 20,
            generate: async (source: Buffer) => source,
        })

        for (const identity of ['one', 'two', 'three']) {
            await writeFile(join(rootDir, cacheFileName(identity)), Buffer.alloc(10, identity))
            await new Promise((resolve) => setTimeout(resolve, 5))
        }

        const result = await cache.prune()
        const files = await readdir(rootDir)
        expect(result.totalBytes).toBeLessThanOrEqual(20)
        expect(result.removed).toBeGreaterThan(0)
        expect(files).not.toContain(cacheFileName('one'))
    })

    it('does not publish a cache file when generation fails', async () => {
        const rootDir = await makeTempDir()
        const cache = createThumbnailCache({
            rootDir,
            generate: async () => { throw new Error('bad image') },
        })

        await expect(cache.get('broken', async () => Buffer.from('bad'))).rejects.toThrow('bad image')
        expect((await readdir(rootDir)).filter((name) => name.endsWith('.webp'))).toEqual([])
    })
})
