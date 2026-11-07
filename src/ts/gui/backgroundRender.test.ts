import { describe, expect, it } from 'vitest'
import { LatestBackground } from './backgroundRender'

function deferred() {
    let resolve!: (value: string) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('LatestBackground', () => {
    it('keeps the same bot\'s background while it parses again (2026-11-07)', async () => {
        const shown: string[] = []
        const bg = new LatestBackground((html) => shown.push(html))
        const first = deferred()
        bg.render('bot-a', () => first.promise)
        first.resolve('<style>.pnl{}</style>A1')
        await flush()
        expect(shown.at(-1)).toBe('<style>.pnl{}</style>A1')

        const again = deferred()
        bg.render('bot-a', () => again.promise)
        await flush()
        // Not emptied while the new parse runs.
        expect(shown.at(-1)).toBe('<style>.pnl{}</style>A1')
        again.resolve('<style>.pnl{}</style>A2')
        await flush()
        expect(shown.at(-1)).toBe('<style>.pnl{}</style>A2')
    })

    it('shows a parse that ends while a newer one still runs (2026-11-08)', async () => {
        // A Lua display that writes a variable the background reads starts
        // a new parse each time: the first to end shows, not none of them.
        const shown: string[] = []
        const bg = new LatestBackground((html) => shown.push(html))
        const first = deferred()
        const second = deferred()
        bg.render('bot-a', () => first.promise)
        bg.render('bot-a', () => second.promise)
        first.resolve('<style>.pnl{}</style>1')
        await flush()
        expect(shown.at(-1)).toBe('<style>.pnl{}</style>1')
        second.resolve('<style>.pnl{}</style>2')
        await flush()
        expect(shown.at(-1)).toBe('<style>.pnl{}</style>2')
    })

    it('never shows the last bot\'s parse after switching', async () => {
        const shown: string[] = []
        const bg = new LatestBackground((html) => shown.push(html))
        const old = deferred()
        bg.render('bot-a', () => old.promise)
        const fresh = deferred()
        bg.render('bot-b', () => fresh.promise)
        old.resolve('A')
        await flush()
        expect(shown).not.toContain('A')
        fresh.resolve('B')
        await flush()
        expect(shown.at(-1)).toBe('B')
    })

    it('clears at once for another bot', async () => {
        const shown: string[] = []
        const bg = new LatestBackground((html) => shown.push(html))
        bg.render('bot-a', async () => 'A')
        await flush()
        const other = deferred()
        bg.render('bot-b', () => other.promise)
        expect(shown.at(-1)).toBe('')
        other.resolve('B')
        await flush()
        expect(shown.at(-1)).toBe('B')
    })

    it('shows only the latest parse when an older one finishes last', async () => {
        const shown: string[] = []
        const bg = new LatestBackground((html) => shown.push(html))
        const older = deferred()
        const newer = deferred()
        bg.render('bot-a', () => older.promise)
        bg.render('bot-a', () => newer.promise)
        newer.resolve('new')
        await flush()
        older.resolve('old')
        await flush()
        expect(shown.at(-1)).toBe('new')
        expect(shown).not.toContain('old')
    })

    it('keeps what it showed when a parse fails', async () => {
        const shown: string[] = []
        const bg = new LatestBackground((html) => shown.push(html))
        bg.render('bot-a', async () => 'A')
        await flush()
        const failing = deferred()
        const errors = console.error
        console.error = () => {}
        try {
            bg.render('bot-a', () => failing.promise)
            failing.reject(new Error('parse failed'))
            await flush()
            bg.render('bot-a', () => { throw new Error('sync failure') })
        } finally {
            console.error = errors
        }
        expect(shown.at(-1)).toBe('A')
    })

    it('clear and stop drop a parse in flight', async () => {
        const shown: string[] = []
        const bg = new LatestBackground((html) => shown.push(html))
        const pending = deferred()
        bg.render('bot-a', () => pending.promise)
        bg.clear()
        expect(shown.at(-1)).toBe('')
        pending.resolve('late')
        await flush()
        expect(shown).not.toContain('late')

        const pending2 = deferred()
        bg.render('bot-a', () => pending2.promise)
        bg.stop()
        pending2.resolve('late2')
        await flush()
        expect(shown).not.toContain('late2')
    })
})

describe('LatestBackground waiting (2026-11-08)', () => {
    it('waits from a new bot until its first background shows, not on a redraw', async () => {
        const waits: boolean[] = []
        const bg = new LatestBackground(() => {}, (w) => waits.push(w))
        const first = deferred()
        bg.render('bot-a', () => first.promise)
        expect(waits).toEqual([true])
        first.resolve('<style></style>')
        await flush()
        expect(waits).toEqual([true, false])
        bg.render('bot-a', async () => 'again')
        await flush()
        expect(waits).toEqual([true, false])
    })

    it('stops waiting after the limit, on a failure and on clear', async () => {
        const waits: boolean[] = []
        const bg = new LatestBackground(() => {}, (w) => waits.push(w), 20)
        bg.render('bot-a', () => new Promise<string>(() => {}))
        await new Promise((r) => setTimeout(r, 40))
        expect(waits).toEqual([true, false])

        const errors = console.error
        console.error = () => {}
        try {
            const failing = deferred()
            bg.render('bot-b', () => failing.promise)
            failing.reject(new Error('parse failed'))
            await flush()
        } finally {
            console.error = errors
        }
        expect(waits).toEqual([true, false, true, false])

        bg.render('bot-c', () => new Promise<string>(() => {}))
        bg.clear()
        expect(waits).toEqual([true, false, true, false, true, false])
    })

    it('another bot\'s late parse does not end the wait', async () => {
        const waits: boolean[] = []
        const bg = new LatestBackground(() => {}, (w) => waits.push(w))
        const old = deferred()
        bg.render('bot-a', () => old.promise)
        bg.render('bot-b', () => new Promise<string>(() => {}))
        old.resolve('A')
        await flush()
        expect(waits.at(-1)).toBe(true)
        bg.stop()
        expect(waits.at(-1)).toBe(false)
    })
})
