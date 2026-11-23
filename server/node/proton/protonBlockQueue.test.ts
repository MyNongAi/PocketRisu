import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { discardPartialFile, retryBlock, writeOrderedBlocks } from './protonBlockQueue'

describe('PROTON-STREAM block pipeline', () => {
    it('writes in order while loading at most four blocks concurrently', async () => {
        let active = 0
        let peak = 0
        const written: number[] = []
        await writeOrderedBlocks([1, 2, 3, 4, 5, 6], async (block) => {
            active++
            peak = Math.max(peak, active)
            await new Promise((resolve) => setTimeout(resolve, (7 - block) * 2))
            active--
            return block
        }, async (block) => { written.push(block) })
        expect(peak).toBe(4)
        expect(written).toEqual([1, 2, 3, 4, 5, 6])
    })

    it('retries only the failed block and refreshes a 404 URL', async () => {
        const calls: string[] = []
        const attempts = new Map<number, number>()
        const written: number[] = []
        await writeOrderedBlocks([1, 2, 3], (index) => retryBlock(
            { index, url: `old-${index}` },
            async (block) => {
                calls.push(block.url)
                const count = (attempts.get(block.index) ?? 0) + 1
                attempts.set(block.index, count)
                if (block.index === 2 && count === 1) throw { status: 404 }
                return block.index
            },
            async (block) => ({ ...block, url: `new-${block.index}` }),
            (error) => (error as { status?: number }).status,
        ), async (result) => { written.push(result) })
        expect(calls.filter((url) => url === 'old-1')).toHaveLength(1)
        expect(calls.filter((url) => url === 'old-3')).toHaveLength(1)
        expect(calls.filter((url) => url === 'old-2')).toHaveLength(1)
        expect(calls.filter((url) => url === 'new-2')).toHaveLength(1)
        expect(written).toEqual([1, 2, 3])
    })

    it('stops a pending retry on abort', async () => {
        const controller = new AbortController()
        const pending = retryBlock(1, async () => { throw new TypeError('terminated') }, async (block) => block,
            () => undefined, controller.signal)
        controller.abort(new Error('cancelled'))
        await expect(pending).rejects.toThrow('cancelled')
    })

    it('deletes a synthetic partial file after abort', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-stream-test-'))
        try {
            const file = path.join(dir, 'partial.part')
            fs.writeFileSync(file, Buffer.from('partial'))
            const controller = new AbortController()
            controller.abort(new Error('cancelled'))
            try {
                await writeOrderedBlocks([1], async () => 1, async () => {}, controller.signal)
            } catch {
                await discardPartialFile(undefined, file)
            }
            expect(fs.existsSync(file)).toBe(false)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
