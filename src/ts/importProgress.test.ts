import { get } from 'svelte/store'
import { beforeEach, describe, expect, it } from 'vitest'
import { adaptLegacyProgress, importTasks, reportImportTask, runExportTask, runImportBatch, runImportTask, runPrefetchedImportBatch } from './importProgress'

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
            id: 'task', fileName: 'a.png', kind: 'import', label: 'running', progress: 0, phase: 'running',
        }]]))

        reportImportTask('task', { label: 'too much', progress: 140 })
        expect(get(importTasks).get('task')?.progress).toBe(100)
        reportImportTask('task', { label: 'reading', progress: null })
        expect(get(importTasks).get('task')?.progress).toBeNull()
    })

    it('tracks a single remote import without blocking the caller UI', async () => {
        const result = await runImportTask('Realm card', async (report) => {
            report({ label: 'Downloading from Realm', progress: null })
            await Promise.resolve()
            report({ label: 'Saving assets', progress: 75 })
            return 42
        })

        expect(result).toBe(42)
        const [task] = [...get(importTasks).values()]
        expect(task.fileName).toBe('Realm card')
        expect(task.phase).toBe('done')
        expect(task.progress).toBe(100)
    })

    it('runs an export on the same toast with export labels', async () => {
        let labelWhileRunning = ''
        const result = await runExportTask('card.charx', async (report) => {
            labelWhileRunning = [...get(importTasks).values()][0].label
            adaptLegacyProgress(report)('Loading... (Adding Assets)', 40)
            expect(get(importTasks).get([...get(importTasks).keys()][0])?.progress).toBe(40)
            return 'written'
        })

        expect(result).toBe('written')
        expect(labelWhileRunning).toBe('Exporting')
        const [task] = [...get(importTasks).values()]
        expect(task.kind).toBe('export')
        expect(task.fileName).toBe('card.charx')
        expect(task.phase).toBe('done')
    })

    describe('prefetched batches', () => {
        // A fetch the test settles by hand.
        function controlledFetches() {
            const pending = new Map<string, { resolve: (v: string) => void, reject: (e: Error) => void }>()
            const started: string[] = []
            const fetchItem = (item: { name: string }) => new Promise<string>((resolve, reject) => {
                started.push(item.name)
                pending.set(item.name, { resolve, reject })
            })
            const settle = async (name: string, error?: Error) => {
                const p = pending.get(name)!
                if (error) p.reject(error)
                else p.resolve(`data:${name}`)
                await new Promise((r) => setTimeout(r, 0))
            }
            return { fetchItem, started, settle }
        }
        const limits = (maxBytes: number, sizes: Record<string, number | null> = {}) => ({
            concurrency: 3,
            maxBytes,
            sizeOf: (item: { name: string }) => sizes[item.name] ?? 10,
            unknownSizeBytes: 10,
        })
        const tick = () => new Promise((r) => setTimeout(r, 0))

        it('fetches ahead in parallel but imports one at a time in list order', async () => {
            const { fetchItem, started, settle } = controlledFetches()
            const imported: string[] = []
            let active = 0
            let maxActive = 0
            const run = runPrefetchedImportBatch(
                ['a', 'b', 'c', 'd'].map((name) => ({ name })),
                fetchItem,
                async (item, fetched) => {
                    active++
                    maxActive = Math.max(maxActive, active)
                    expect(fetched).toBe(`data:${item.name}`)
                    imported.push(item.name)
                    await Promise.resolve()
                    active--
                },
                limits(1000),
            )
            await tick()
            expect(started).toEqual(['a', 'b', 'c'])
            expect(get(importTasks).size).toBe(4)
            // Later fetches finishing first do not reorder the imports.
            await settle('c')
            await settle('b')
            expect(imported).toEqual([])
            await settle('a')
            expect(imported).toEqual(['a', 'b', 'c'])
            expect(started).toEqual(['a', 'b', 'c', 'd'])
            await settle('d')
            expect(await run).toEqual({ completed: 4, failed: 0, total: 4 })
            expect(imported).toEqual(['a', 'b', 'c', 'd'])
            expect(maxActive).toBe(1)
        })

        it('holds fetched bytes until their import ends; a larger item still runs alone', async () => {
            const { fetchItem, started, settle } = controlledFetches()
            const run = runPrefetchedImportBatch(
                ['a', 'b', 'big', 'c'].map((name) => ({ name })),
                fetchItem,
                async () => {},
                limits(25, { a: 10, b: 10, big: 40, c: 10 }),
            )
            await tick()
            // a and b fit in 25 bytes; big would not while they are held.
            expect(started).toEqual(['a', 'b'])
            await settle('a')
            expect(started).toEqual(['a', 'b'])
            await settle('b')
            // Both imported and released: big runs alone, c waits for it.
            expect(started).toEqual(['a', 'b', 'big'])
            await settle('big')
            expect(started).toEqual(['a', 'b', 'big', 'c'])
            await settle('c')
            expect(await run).toEqual({ completed: 4, failed: 0, total: 4 })
        })

        it('a failed fetch fails its task, frees its bytes and the rest continue', async () => {
            const { fetchItem, started, settle } = controlledFetches()
            const imported: string[] = []
            const run = runPrefetchedImportBatch(
                ['a', 'b', 'c'].map((name) => ({ name })),
                fetchItem,
                async (item) => { imported.push(item.name) },
                { ...limits(20), concurrency: 1 },
            )
            await tick()
            expect(started).toEqual(['a'])
            await settle('a', new Error('share gone'))
            expect(started).toEqual(['a', 'b'])
            await settle('b')
            await settle('c')
            expect(await run).toEqual({ completed: 2, failed: 1, total: 3 })
            expect(imported).toEqual(['b', 'c'])
            const tasks = [...get(importTasks).values()]
            expect(tasks.map((task) => task.phase)).toEqual(['failed', 'done', 'done'])
            expect(tasks[0].error).toBe('share gone')
        })

        it('a queued task shows its fetch progress', async () => {
            let reportB: ((update: { label: string, progress?: number | null }) => void) | null = null
            const resolvers: Array<() => void> = []
            const run = runPrefetchedImportBatch(
                ['a', 'b'].map((name) => ({ name })),
                (item, report) => new Promise<string>((resolve) => {
                    if (item.name === 'b') reportB = report
                    resolvers.push(() => resolve(item.name))
                }),
                async () => {},
                limits(1000),
            )
            await tick()
            reportB!({ label: 'downloading', progress: 40 })
            const b = [...get(importTasks).values()][1]
            expect(b.phase).toBe('queued')
            expect(b.progress).toBe(40)
            resolvers.forEach((resolve) => resolve())
            expect(await run).toEqual({ completed: 2, failed: 0, total: 2 })
        })
    })

    it('keeps the remote import error on its background task and rethrows it', async () => {
        await expect(runImportTask('Broken Realm card', async () => {
            throw new Error('realm unavailable')
        })).rejects.toThrow('realm unavailable')

        const [task] = [...get(importTasks).values()]
        expect(task.phase).toBe('failed')
        expect(task.error).toBe('realm unavailable')
    })
})
