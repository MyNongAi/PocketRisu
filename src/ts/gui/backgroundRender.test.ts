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
