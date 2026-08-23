import { get } from 'svelte/store'
import { beforeEach, describe, expect, it } from 'vitest'
import { importTasks, reportImportTask, runImportBatch } from './importProgress'

describe('import progress queue', () => {
    beforeEach(() => {
        importTasks.set(new Map())
    })

    it('publishes the entire queue before importing sequentially', async () => {
        let active = 0
        let maxActive = 0
        const seen: string[] = []

        const result = await runImportBatch(
            [{ name: 'a.png' }, { name: 'b.png' }],
            async (file, report) => {
                expect(get(importTasks).size).toBe(2)
                active++
                maxActive = Math.max(maxActive, active)
                seen.push(file.name)
                report({ label: '에셋 저장 중', progress: 50 })
                await Promise.resolve()
                active--
            },
        )

        expect(seen).toEqual(['a.png', 'b.png'])
        expect(maxActive).toBe(1)
        expect(result).toEqual({ completed: 2, failed: 0, total: 2 })
        expect([...get(importTasks).values()].every((entry) => entry.phase === 'done')).toBe(true)
    })

    it('keeps later imports running when one file fails', async () => {
        const seen: string[] = []
        const result = await runImportBatch(
            [{ name: 'bad.png' }, { name: 'good.png' }],
            async (file) => {
                seen.push(file.name)
                if (file.name === 'bad.png') throw new Error('broken card')
            },
        )

        expect(seen).toEqual(['bad.png', 'good.png'])
        expect(result).toEqual({ completed: 1, failed: 1, total: 2 })
        expect([...get(importTasks).values()].map((entry) => entry.phase)).toEqual(['failed', 'done'])
    })

    it('clamps determinate progress and allows indeterminate progress', () => {
        importTasks.set(new Map([['task', {
            id: 'task', fileName: 'a.png', label: 'running', progress: 0, phase: 'running',
        }]]))

        reportImportTask('task', { label: 'too much', progress: 140 })
        expect(get(importTasks).get('task')?.progress).toBe(100)
        reportImportTask('task', { label: 'reading', progress: null })
        expect(get(importTasks).get('task')?.progress).toBeNull()
    })
})
