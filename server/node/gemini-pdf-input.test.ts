import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import pkg from './gemini-pdf-input.cjs'

const {
    createGeminiPdfInput,
    resolveFontSet,
    primaryFontCandidates,
    fallbackFontCandidates,
    sanitizeText,
    createLruCache,
} = pkg as any

type Block = { role: 'system' | 'user' | 'assistant', text: string }

// The real font lookup of this machine. Rendering tests need a Korean-capable
// font; they are skipped (not failed) on a host without one, where the
// feature itself reports "unavailable" — covered by the no-font tests below.
const fontSet = resolveFontSet()
const hasFont = !!fontSet
const emojiCapable = hasFont && fontSet.fonts.some((f: any) => f.font.hasGlyphForCodePoint(0x1F600))

async function extractPdf(pdf: Buffer): Promise<{ text: string, pages: number }> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false }).promise
    let text = ''
    for (let p = 1; p <= doc.numPages; p++) {
        const content = await (await doc.getPage(p)).getTextContent()
        for (const item of content.items as any[]) text += item.str + (item.hasEOL ? '\n' : '')
        text += '\n'
    }
    const pages = doc.numPages
    await doc.destroy()
    return { text, pages }
}

// pdf.js joins/splits items by geometry, so compare without whitespace (and
// without ZWJ, which a fallback emoji font may map to its space glyph).
const squash = (s: string) => s.replace(/[\s‍]+/g, '')

// Deterministic Korean + English prose-like text of about `chars` characters.
function sampleText(chars: number, seed = 7): string {
    let state = seed
    const rnd = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648
    const syllables = Array.from({ length: 700 }, (_, i) => String.fromCharCode(0xAC00 + ((i * 7919) % 11172)))
    let out = ''
    while (out.length < chars) {
        let word = ''
        if (rnd() < 0.6) {
            const n = 1 + Math.floor(rnd() * 4)
            for (let i = 0; i < n; i++) word += syllables[Math.floor(rnd() * syllables.length)]
        } else {
            const n = 2 + Math.floor(rnd() * 8)
            for (let i = 0; i < n; i++) word += String.fromCharCode(97 + Math.floor(rnd() * 26))
        }
        out += word + (rnd() < 0.05 ? (rnd() < 0.3 ? '\n\n' : '\n') : ' ')
    }
    return out
}

function transcript(chars: number): Block[] {
    const blocks: Block[] = []
    let left = chars
    let i = 0
    while (left > 0) {
        const len = Math.min(left, 400 + ((i * 977) % 2500))
        blocks.push({ role: i === 0 ? 'system' : i % 2 ? 'user' : 'assistant', text: sampleText(len, i + 1) })
        left -= len
        i++
    }
    return blocks
}

describe('font discovery', () => {
    it('orders the env override first, then malgun, then non-variable NotoSansKR files', () => {
        const winDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-pdf-fonts-'))
        try {
            fs.mkdirSync(path.join(winDir, 'Fonts'))
            for (const name of ['NotoSansKR-VF.ttf', 'NotoSansKR-VariableFont_wght.ttf', 'NotoSansKR-Bold.otf', 'NotoSansKR-Regular.ttf']) {
                fs.writeFileSync(path.join(winDir, 'Fonts', name), '')
            }
            const list = primaryFontCandidates({ POCKETRISU_PDF_FONT: '/fonts/Custom.ttc#CustomKR-Regular', WINDIR: winDir }, 'win32')
            expect(list[0]).toMatchObject({ file: '/fonts/Custom.ttc', postscriptName: 'CustomKR-Regular', source: 'env' })
            expect(list[1].file).toBe(path.join(winDir, 'Fonts', 'malgun.ttf'))
            const noto = list.filter((c: any) => c.file.startsWith(winDir) && /NotoSansKR/.test(c.file)).map((c: any) => path.basename(c.file))
            expect(noto).toEqual(['NotoSansKR-Regular.ttf', 'NotoSansKR-Bold.otf'])
            const android = list.find((c: any) => c.source === 'android')
            expect(android).toMatchObject({ file: '/system/fonts/NotoSansCJK-Regular.ttc', postscriptName: 'NotoSansCJKkr-Regular' })
            expect(list.some((c: any) => c.source === 'linux' && /NotoSansCJK-Regular\.ttc$/.test(c.file))).toBe(true)
        } finally {
            fs.rmSync(winDir, { recursive: true, force: true })
        }
    })

    it('skips Windows paths off Windows and honours the fallback override', () => {
        const list = primaryFontCandidates({}, 'linux')
        expect(list.some((c: any) => /malgun/i.test(c.file))).toBe(false)
        const fallbacks = fallbackFontCandidates({ POCKETRISU_PDF_FALLBACK_FONTS: ['/a/Emoji.ttf', '/b/Sym.ttf'].join(path.delimiter) }, 'linux')
        expect(fallbacks.slice(0, 2).map((c: any) => c.file)).toEqual(['/a/Emoji.ttf', '/b/Sym.ttf'])
    })

    it('reports unavailable when no candidate is a usable font', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-pdf-nofont-'))
        try {
            const bogus = path.join(dir, 'not-a-font.ttf')
            fs.writeFileSync(bogus, 'definitely not a font')
            expect(resolveFontSet({ primaryCandidates: [{ file: bogus }, { file: path.join(dir, 'missing.ttf') }], fallbackCandidates: [] })).toBeNull()
            const service = createGeminiPdfInput({ primaryCandidates: [{ file: bogus }], fallbackCandidates: [], logger: { info() {}, warn() {}, error() {} } })
            expect(service.status()).toEqual({ available: false })
            const result = await service.render([{ role: 'user', text: 'hello' }])
            expect(result).toMatchObject({ ok: false, reason: 'no-font', httpStatus: 503 })
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('text preparation and cache', () => {
    it('normalizes line endings, expands tabs and drops control characters', () => {
        expect(sanitizeText('a\r\nb\rc\td\u0007e\u0000')).toBe('a\nb\nc    de')
    })

    it('evicts the least recently used entry by count and by bytes', () => {
        const cache = createLruCache({ maxEntries: 2, maxBytes: 100 })
        cache.set('a', 'A', 10)
        cache.set('b', 'B', 10)
        expect(cache.get('a')).toBe('A')
        cache.set('c', 'C', 10)
        expect(cache.get('b')).toBeUndefined()
        expect(cache.get('a')).toBe('A')
        cache.set('d', 'D', 95)
        expect(cache.size).toBe(1)
        expect(cache.get('d')).toBe('D')
        cache.set('huge', 'H', 1000)
        expect(cache.get('huge')).toBeUndefined()
    })
})

describe.skipIf(!hasFont)('PDF rendering (real font)', () => {
    const quiet = { info() {}, warn() {}, error() {} }

    it('round-trips Korean, English and emoji as extractable text', async () => {
        const service = createGeminiPdfInput({ logger: quiet })
        const lines = {
            system: ['You are a helpful storyteller.', '시스템 지시문: 존댓말로 답하세요.'],
            user: ['안녕하세요! Hello there, how are you?', '오늘 날씨가 참 맑네요, and the sky is blue.'],
            assistant: emojiCapable
                ? ['반갑습니다. Nice to meet you 😀', '좋아요 👍🏽 ❤️ ☀ 🇰🇷 끝.']
                : ['반갑습니다. Nice to meet you.', '좋아요, 끝.'],
        }
        const blocks: Block[] = [
            { role: 'system', text: lines.system.join('\n') },
            { role: 'user', text: lines.user.join('\n\n') },
            { role: 'assistant', text: lines.assistant.join('\n') },
        ]
        const result = await service.render(blocks)
        expect(result.ok).toBe(true)
        expect(result.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
        expect(result.replacedChars).toBe(0)

        const extracted = await extractPdf(result.pdf)
        expect(extracted.pages).toBe(1)
        expect(result.pages).toBe(1)
        const text = squash(extracted.text)
        for (const label of ['[System]', '[User]', '[Assistant]']) expect(text).toContain(label)
        for (const line of [...lines.system, ...lines.user, ...lines.assistant]) {
            expect(text).toContain(squash(line))
        }
        // Order is preserved: system, then user, then assistant.
        expect(text.indexOf('[System]')).toBeLessThan(text.indexOf('[User]'))
        expect(text.indexOf('[User]')).toBeLessThan(text.indexOf('[Assistant]'))
    })

    it('breaks long transcripts into pages and reports the real page count', async () => {
        const service = createGeminiPdfInput({ logger: quiet })
        const blocks = transcript(30000)
        const result = await service.render(blocks)
        expect(result.ok).toBe(true)
        const extracted = await extractPdf(result.pdf)
        expect(result.pages).toBeGreaterThan(3)
        expect(extracted.pages).toBe(result.pages)
        const text = squash(extracted.text)
        for (const block of blocks) expect(text).toContain(squash(block.text))
    })

    it('renders identical input to identical bytes and serves repeats from the cache', async () => {
        const service = createGeminiPdfInput({ logger: quiet })
        const blocks = transcript(5000)
        const first = await service.render(blocks)
        const second = await service.render(blocks)
        expect(first.cached).toBe(false)
        expect(second.cached).toBe(true)
        expect(Buffer.compare(first.pdf, second.pdf)).toBe(0)
        service.clearCache()
        const third = await service.render(blocks)
        expect(third.cached).toBe(false)
        expect(Buffer.compare(first.pdf, third.pdf)).toBe(0)
    })

    it('refuses input past the page, size or character limits', async () => {
        const blocks = transcript(30000)
        const pageLimited = createGeminiPdfInput({ logger: quiet, maxPages: 2 })
        expect(await pageLimited.render(blocks)).toMatchObject({ ok: false, reason: 'too-large', httpStatus: 413 })
        const sizeLimited = createGeminiPdfInput({ logger: quiet, maxBytes: 20 * 1024 })
        expect(await sizeLimited.render(blocks)).toMatchObject({ ok: false, reason: 'too-large', httpStatus: 413 })
        const charLimited = createGeminiPdfInput({ logger: quiet, maxInputChars: 1000 })
        expect(await charLimited.render(blocks)).toMatchObject({ ok: false, reason: 'too-large', httpStatus: 413 })
    })

    it('replaces characters no font covers instead of emitting unmapped glyphs', async () => {
        const service = createGeminiPdfInput({ logger: quiet })
        const result = await service.render([{ role: 'user', text: 'private use \u{10FFFD} end' }])
        expect(result.ok).toBe(true)
        expect(result.replacedChars).toBe(1)
        const text = squash((await extractPdf(result.pdf)).text)
        expect(text).toContain('privateuse')
        expect(text).toContain('end')
        expect(text).not.toContain('\u0000')
    })

    it('measures render time for ~50k and ~200k characters', async () => {
        const service = createGeminiPdfInput({ logger: quiet })
        await service.render([{ role: 'user', text: '준비 warm-up' }])
        for (const chars of [50_000, 200_000]) {
            const blocks = transcript(chars)
            const started = performance.now()
            const result = await service.render(blocks)
            const ms = Math.round(performance.now() - started)
            expect(result.ok).toBe(true)
            console.log(`[gemini-pdf-input] ${chars} chars -> ${result.pages} pages, ${Math.round(result.bytes / 1024)} KB, ${ms} ms`)
            expect(ms).toBeLessThan(20_000)
        }
    })
})

describe('POST /api/gemini/pdf-input', () => {
    const AUTH = 'test-token'
    let server: http.Server
    let base: string

    async function stubAuth(req: any, res: any) {
        if (req.headers['risu-auth'] === AUTH) return true
        res.status(400).send({ error: 'No auth header' })
        return false
    }

    beforeAll(async () => {
        const app = express()
        app.use(express.json({ limit: '100mb' }))
        createGeminiPdfInput({ logger: { info() {}, warn() {}, error() {} } }).registerRoutes(app, { auth: stubAuth })
        server = http.createServer(app)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        base = `http://127.0.0.1:${(server.address() as any).port}`
    })

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve))
    })

    const post = (body: unknown, headers: Record<string, string> = { 'risu-auth': AUTH }) => fetch(`${base}/api/gemini/pdf-input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })

    it('requires the same auth as the other /api routes', async () => {
        const res = await post({ blocks: [{ role: 'user', text: 'hi' }] }, {})
        expect(res.status).toBe(400)
    })

    it('rejects malformed blocks', async () => {
        expect((await post({ blocks: [] })).status).toBe(400)
        const res = await post({ blocks: [{ role: 'tool', text: 'x' }] })
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ ok: false, reason: 'invalid' })
    })

    it.skipIf(!hasFont)('returns the PDF as base64 with its page count', async () => {
        const res = await post({ blocks: [{ role: 'system', text: '규칙: 짧게 답하기' }, { role: 'user', text: 'Hello 안녕' }] })
        expect(res.status).toBe(200)
        const json = await res.json()
        expect(json).toMatchObject({ ok: true, mimeType: 'application/pdf', pages: 1, cached: false })
        const pdf = Buffer.from(json.data, 'base64')
        expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
        expect(json.bytes).toBe(pdf.length)
        const again = await (await post({ blocks: [{ role: 'system', text: '규칙: 짧게 답하기' }, { role: 'user', text: 'Hello 안녕' }] })).json()
        expect(again.cached).toBe(true)
        expect(again.data).toBe(json.data)
    })
})
