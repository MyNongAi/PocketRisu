import { describe, expect, it } from 'vitest'
import { chunkKoText, fingerprint, isKoStale, maskKoMarkup, sanitizeKoEntries, setKoEntry, validKoMap } from './koView'

describe('KO-VIEW reading data', () => {
    it('fingerprints English and spots changed source without changing the Korean', () => {
        const entry = { text: '안녕', src: fingerprint('Hello') }
        expect(isKoStale(entry, 'Hello')).toBe(false)
        expect(isKoStale(entry, 'Hello!')).toBe(true)
        expect(entry.text).toBe('안녕')
    })

    it('chunks long lines at sentences and preserves blank lines when joined', () => {
        const source = `${'A sentence. '.repeat(200)}\n\n${'Final. '.repeat(150)}`
        const chunks = chunkKoText(source, 1500)
        expect(chunks.every(chunk => chunk.length <= 1500)).toBe(true)
        expect(chunks.join('')).toBe(source)
        expect(chunks.length).toBeGreaterThan(2)
        const llm = chunkKoText(`${'Paragraph. '.repeat(900)}\n\nLast`, 6000)
        expect(llm.every(chunk => chunk.length <= 6000)).toBe(true)
        expect(llm.join('')).toContain('\n\nLast')
    })

    it('masks nested CBS and HTML, restoring surviving tokens', () => {
        const masked = maskKoMarkup('Hi {{outer {{inner}} tail}} <b>there</b>')
        expect(masked.text).toBe('Hi ⟦0⟧ ⟦1⟧there⟦2⟧')
        expect(masked.restore('안녕 ⟦0⟧ ⟦1⟧여기⟦2⟧')).toBe('안녕 {{outer {{inner}} tail}} <b>여기</b>')
        expect(masked.restore('안녕 ⟦0⟧ 여기')).toBe('안녕 {{outer {{inner}} tail}} 여기')
    })

    it('removes empty maps and rejects malformed or oversized card data', () => {
        const owner: { nodeOnlyKo?: Record<string, { text: string, src: string }> } = {}
        setKoEntry(owner, 'desc', { text: '설명', src: '123' })
        setKoEntry(owner, 'desc', undefined)
        expect(owner.nodeOnlyKo).toBeUndefined()
        expect(validKoMap({ desc: { text: '설명', src: '123' }, bad: { text: 3, src: 'x' }, huge: { text: 'x'.repeat(200_001), src: 'x' } })).toEqual({ desc: { text: '설명', src: '123' } })
    })

    it('validates lorebook maps carried whole by modules', () => {
        const entries = [{ nodeOnlyKo: { content: { text: '내용', src: 'a' }, bad: { text: 4, src: 'b' } } }]
        sanitizeKoEntries(entries as any)
        expect(entries[0].nodeOnlyKo).toEqual({ content: { text: '내용', src: 'a' } })
    })
})
