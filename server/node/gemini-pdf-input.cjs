'use strict';

// Gemini PDF input (GEMINI-PDF-INPUT): renders the long context of a native
// Gemini request into ONE text-layer PDF.
//
// Why: Gemini bills each PDF page as 258 IMAGE-modality tokens, and Gemini 3
// models receive the PDF's embedded text layer without a token charge
// (https://ai.google.dev/gemini-api/docs/document-processing). A dense page of
// transcript therefore costs far fewer prompt tokens than the same text sent
// as plain parts.
//
// Split of work: the client (src/ts/process/request/geminiPdfInput.ts) decides
// WHAT goes into the PDF (role-labelled blocks of everything before the last
// user turn), calls POST /api/gemini/pdf-input, and splices the PDF into the
// request. This module only renders. It lives on the server so a phone never
// downloads a CJK font and the client bundle carries no PDF writer.
//
// The PDF holds real, extractable text: pdfkit embeds a font subset with a
// ToUnicode CMap. Characters the primary (Korean-capable) font lacks, such as
// emoji, are routed per grapheme cluster to an outline fallback font, so every
// glyph maps back to its own characters. A character no font covers becomes
// U+FFFD rather than an unmapped .notdef glyph.

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

// Bump when the layout changes so cached PDFs of the old layout are not reused.
const PDF_RENDER_VERSION = 1;
// Google's documented limits are 50MB / 1000 pages; stay clearly below them.
const MAX_PDF_BYTES = 45 * 1024 * 1024;
const MAX_PDF_PAGES = 900;
// ~900 dense pages hold about 5M characters; anything larger cannot fit, so it
// is refused before any layout work.
const MAX_INPUT_CHARS = 6 * 1024 * 1024;
const MAX_BLOCKS = 50000;
// Retries and rerolls resend the same context; a few recent PDFs cover them.
const CACHE_MAX_ENTRIES = 8;
const CACHE_MAX_BYTES = 128 * 1024 * 1024;

// A4, 10pt, 0.5in margins.
const FONT_SIZE = 10;
const PAGE_MARGIN = 36;
const LINE_GAP = 0;
const BLOCK_GAP_LINES = 0.6;
const LABEL_COLOR = '#555555';
const TEXT_COLOR = '#000000';
// Fixed metadata date: pdfkit derives the file ID from it, so identical input
// renders byte-identical output (cache-friendly for retries and for Gemini's
// prefix matching on the unchanged leading pages).
const FIXED_CREATION_DATE = new Date(Date.UTC(2000, 0, 1));

const ROLE_LABELS = Object.freeze({
    system: '[System]',
    user: '[User]',
    assistant: '[Assistant]',
});

const REPLACEMENT_CHAR = '\uFFFD';

// Fallback-font runs are laid out without ligatures. fontkit records only the
// first component's code points on a multi-step ligature glyph (a ZWJ family
// emoji or a keycap came back as one glyph mapped to U+1F468 alone), and pdfkit
// builds the ToUnicode CMap from those code points. Unligated, each glyph maps
// to its own character, so the text layer keeps the whole sequence.
// fontkit writes into the feature object it receives, so each call gets a copy.
const NO_LIGATURES = { ccmp: false, liga: false, clig: false, calt: false, rlig: false, dlig: false };

const LINUX_PRIMARY_FONTS = [
    // Debian / Ubuntu (fonts-noto-cjk)
    { file: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', postscriptName: 'NotoSansCJKkr-Regular' },
    // Arch (noto-fonts-cjk)
    { file: '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', postscriptName: 'NotoSansCJKkr-Regular' },
    // Fedora (google-noto-sans-cjk-fonts)
    { file: '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc', postscriptName: 'NotoSansCJKkr-Regular' },
    { file: '/usr/share/fonts/google-noto-sans-cjk-fonts/NotoSansCJK-Regular.ttc', postscriptName: 'NotoSansCJKkr-Regular' },
    { file: '/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf' },
    { file: '/usr/share/fonts/noto-cjk/NotoSansCJKkr-Regular.otf' },
    { file: '/usr/share/fonts/truetype/noto/NotoSansKR-Regular.ttf' },
    { file: '/usr/share/fonts/noto/NotoSansKR-Regular.ttf' },
    { file: '/usr/share/fonts/truetype/nanum/NanumGothic.ttf' },
    { file: '/usr/share/fonts/nanum/NanumGothic.ttf' },
    { file: '/usr/share/fonts/naver-nanum/NanumGothic.ttf' },
];

const LINUX_FALLBACK_FONTS = [
    '/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf',
    '/usr/share/fonts/noto/NotoEmoji-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/ancient-scripts/Symbola_hint.ttf',
];

class PdfLimitError extends Error {
    constructor(kind, value) {
        super(`PDF would exceed the ${kind} limit (${value})`);
        this.name = 'PdfLimitError';
        this.kind = kind;
        this.value = value;
    }
}

// pdfkit is loaded on first use so the server boots without paying for it.
// fontkit is pdfkit's own dependency; resolving it from pdfkit's directory
// works under pnpm's strict layout and hands pdfkit font objects it accepts.
let pdfLibs = null;
function loadPdfLibs() {
    if (!pdfLibs) {
        const PDFDocument = require('pdfkit');
        const fontkit = require(require.resolve('fontkit', { paths: [path.dirname(require.resolve('pdfkit'))] }));
        pdfLibs = { PDFDocument, fontkit };
    }
    return pdfLibs;
}

// --- font discovery ---------------------------------------------------------

function parseFontSpec(spec) {
    // "path" or "path#PostScriptName" (the name picks a face in a .ttc).
    const hash = spec.lastIndexOf('#');
    if (hash > 0 && !/[\\/]/.test(spec.slice(hash + 1))) {
        return { file: spec.slice(0, hash), postscriptName: spec.slice(hash + 1) };
    }
    return { file: spec };
}

function windowsFontDirs(env, platform) {
    const winDir = env.WINDIR || env.SystemRoot || (platform === 'win32' ? 'C:\\Windows' : '');
    const dirs = [];
    if (winDir) dirs.push(path.join(winDir, 'Fonts'));
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
    return dirs;
}

function isVariableFontFileName(name) {
    return /(^|[-_ .])VF([-_ .]|$)|Variable|\[/i.test(name);
}

function listNotoSansKrFiles(dir) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter((name) => /^NotoSansKR.*\.(ttf|otf)$/i.test(name) && !isVariableFontFileName(name))
        // Regular weight first, then a stable order.
        .sort((a, b) => Number(!/Regular/i.test(a)) - Number(!/Regular/i.test(b)) || a.localeCompare(b))
        .map((name) => path.join(dir, name));
}

function primaryFontCandidates(env = process.env, platform = process.platform) {
    const out = [];
    const override = typeof env.POCKETRISU_PDF_FONT === 'string' ? env.POCKETRISU_PDF_FONT.trim() : '';
    if (override) out.push({ ...parseFontSpec(override), source: 'env' });
    const winDirs = windowsFontDirs(env, platform);
    if (winDirs.length > 0) {
        out.push({ file: path.join(winDirs[0], 'malgun.ttf'), source: 'windows' });
        for (const dir of winDirs) {
            for (const file of listNotoSansKrFiles(dir)) out.push({ file, source: 'windows' });
        }
    }
    out.push({ file: '/system/fonts/NotoSansCJK-Regular.ttc', postscriptName: 'NotoSansCJKkr-Regular', source: 'android' });
    for (const entry of LINUX_PRIMARY_FONTS) out.push({ ...entry, source: 'linux' });
    out.push({ file: '/System/Library/Fonts/AppleSDGothicNeo.ttc', source: 'macos' });
    return out;
}

function fallbackFontCandidates(env = process.env, platform = process.platform) {
    const out = [];
    const override = typeof env.POCKETRISU_PDF_FALLBACK_FONTS === 'string' ? env.POCKETRISU_PDF_FALLBACK_FONTS : '';
    for (const spec of override.split(path.delimiter).map((s) => s.trim()).filter(Boolean)) {
        out.push({ ...parseFontSpec(spec), source: 'env' });
    }
    const winDirs = windowsFontDirs(env, platform);
    if (winDirs.length > 0) {
        out.push({ file: path.join(winDirs[0], 'seguiemj.ttf'), source: 'windows' });
        out.push({ file: path.join(winDirs[0], 'seguisym.ttf'), source: 'windows' });
    }
    // Android's NotoColorEmoji is bitmap-only (CBDT), which pdfkit cannot
    // embed; the symbol subsets still carry outlines.
    out.push({ file: '/system/fonts/NotoSansSymbols-Regular-Subsetted.ttf', source: 'android' });
    out.push({ file: '/system/fonts/NotoSansSymbols-Regular-Subsetted2.ttf', source: 'android' });
    for (const file of LINUX_FALLBACK_FONTS) out.push({ file, source: 'linux' });
    return out;
}

function hasHangul(font) {
    return font.hasGlyphForCodePoint(0xAC00) && font.hasGlyphForCodePoint(0x41);
}

function pickCollectionFace(faces, postscriptName, requireHangul) {
    if (postscriptName) {
        const named = faces.find((face) => face.postscriptName === postscriptName);
        if (named) return named;
    }
    const usable = requireHangul ? faces.filter(hasHangul) : faces;
    return usable.find((face) => /KR|Korean/i.test(face.postscriptName || '')) || usable[0] || null;
}

// Opens one candidate and returns { font, file, name } or null. Rejected:
// missing files, parse failures, bitmap-only fonts (CBDT/sbix: nothing pdfkit
// can embed), CFF2 and variable fonts (pdfkit embeds only the default
// instance, which for NotoSansKR-VF is the Thin weight), and — for the primary
// font — fonts without Hangul.
function openFontCandidate(candidate, { requireHangul }) {
    const { fontkit } = loadPdfLibs();
    let buffer;
    try {
        if (!fs.statSync(candidate.file).isFile()) return null;
        buffer = fs.readFileSync(candidate.file);
    } catch {
        return null;
    }
    let font;
    try {
        font = fontkit.create(buffer);
    } catch {
        return null;
    }
    if (font && Array.isArray(font.fonts)) {
        font = pickCollectionFace(font.fonts, candidate.postscriptName, requireHangul);
    }
    if (!font || typeof font.layout !== 'function' || typeof font.hasGlyphForCodePoint !== 'function') return null;
    const tables = (font.directory && font.directory.tables) || {};
    if (!tables.glyf && !tables['CFF ']) return null;
    if (tables.fvar) return null;
    if (requireHangul && !hasHangul(font)) return null;
    // Colour fonts (COLR/CPAL, e.g. Segoe UI Emoji) make fontkit hand out
    // layer glyphs that its TrueType subsetter cannot encode. Dropping the
    // colour tables from this parsed instance falls back to the base
    // (monochrome) outlines; the font file itself is untouched.
    if (tables.COLR || tables.CPAL) {
        delete tables.COLR;
        delete tables.CPAL;
    }
    return { font, file: candidate.file, name: font.postscriptName || path.basename(candidate.file) };
}

// Primary font + outline fallbacks, or null when no Korean-capable font exists
// (the feature then reports itself unavailable).
function resolveFontSet(opts = {}) {
    const env = opts.env || process.env;
    const platform = opts.platform || process.platform;
    const primaryList = opts.primaryCandidates || primaryFontCandidates(env, platform);
    let primary = null;
    for (const candidate of primaryList) {
        primary = openFontCandidate(candidate, { requireHangul: true });
        if (primary) break;
    }
    if (!primary) return null;
    const fonts = [primary];
    const seen = new Set([path.resolve(primary.file)]);
    for (const candidate of opts.fallbackCandidates || fallbackFontCandidates(env, platform)) {
        const resolved = path.resolve(candidate.file);
        if (seen.has(resolved)) continue;
        const fallback = openFontCandidate(candidate, { requireHangul: false });
        if (fallback) {
            seen.add(resolved);
            fonts.push(fallback);
        }
    }
    return {
        fonts,
        id: fonts.map((f) => `${f.file}#${f.name}`).join('|'),
        label: fonts.map((f) => path.basename(f.file)).join(' + '),
    };
}

// --- text preparation -------------------------------------------------------

// Tabs become spaces (CJK fonts rarely carry a tab glyph); other control
// characters have no visible form and would only become .notdef glyphs.
function sanitizeText(text) {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/\t/g, '    ')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
}

// Invisible format characters. When no font has a glyph for one, it is dropped
// instead of becoming a replacement character.
function isDefaultIgnorable(cp) {
    return cp === 0x00AD || cp === 0x034F || cp === 0x061C || cp === 0x115F || cp === 0x1160
        || (cp >= 0x17B4 && cp <= 0x17B5) || (cp >= 0x180B && cp <= 0x180F)
        || (cp >= 0x200B && cp <= 0x200F) || (cp >= 0x202A && cp <= 0x202E)
        || (cp >= 0x2060 && cp <= 0x206F) || cp === 0x3164
        || (cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0xFEFF || cp === 0xFFA0
        || (cp >= 0xFFF0 && cp <= 0xFFF8) || (cp >= 0x1BCA0 && cp <= 0x1BCA3)
        || (cp >= 0x1D173 && cp <= 0x1D17A) || (cp >= 0xE0000 && cp <= 0xE0FFF);
}

const graphemeSegmenter = typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function* graphemes(text) {
    if (graphemeSegmenter) {
        for (const { segment } of graphemeSegmenter.segment(text)) yield segment;
    } else {
        yield* text;
    }
}

// Per-render helper that assigns each character to a font index.
function createFontRouter(fonts) {
    const firstCover = new Map();
    const coverIndex = (cp) => {
        let idx = firstCover.get(cp);
        if (idx === undefined) {
            idx = fonts.findIndex((f) => f.font.hasGlyphForCodePoint(cp));
            firstCover.set(cp, idx);
        }
        return idx;
    };
    const replacementFont = Math.max(0, coverIndex(REPLACEMENT_CHAR.codePointAt(0)));
    const replacement = coverIndex(REPLACEMENT_CHAR.codePointAt(0)) >= 0 ? REPLACEMENT_CHAR : '?';
    const stats = { replaced: 0 };

    // One line (no '\n') → runs of { font, text }. Fast path: the whole line
    // is covered by the primary font, the usual case for Korean/English text.
    function splitRuns(line) {
        let primaryOnly = true;
        for (const ch of line) {
            if (coverIndex(ch.codePointAt(0)) !== 0) {
                primaryOnly = false;
                break;
            }
        }
        if (primaryOnly) return [{ font: 0, text: line }];

        const runs = [];
        const push = (font, text) => {
            const last = runs[runs.length - 1];
            if (last && last.font === font) last.text += text;
            else runs.push({ font, text });
        };
        for (const cluster of graphemes(line)) {
            const cps = Array.from(cluster, (ch) => ch.codePointAt(0));
            // Keep a whole cluster (ZWJ sequence, keycap, flag, skin tone) in
            // one font so the font can shape it and its ToUnicode entry keeps
            // every code point.
            const whole = fonts.findIndex((f) => cps.every((cp) => f.font.hasGlyphForCodePoint(cp)));
            if (whole >= 0) {
                push(whole, cluster);
                continue;
            }
            for (const cp of cps) {
                const idx = coverIndex(cp);
                if (idx >= 0) push(idx, String.fromCodePoint(cp));
                else if (!isDefaultIgnorable(cp)) {
                    stats.replaced += 1;
                    push(replacementFont, replacement);
                }
            }
        }
        return runs;
    }
    return { splitRuns, stats };
}

// --- rendering --------------------------------------------------------------

async function renderTranscriptPdf(blocks, fontSet, limits = {}) {
    const { PDFDocument } = loadPdfLibs();
    const maxPages = limits.maxPages ?? MAX_PDF_PAGES;
    const maxBytes = limits.maxBytes ?? MAX_PDF_BYTES;

    const doc = new PDFDocument({
        size: 'A4',
        margin: PAGE_MARGIN,
        font: null,
        compress: true,
        info: {
            Title: 'Conversation transcript',
            Creator: 'PocketRisu',
            Producer: 'PocketRisu',
            CreationDate: FIXED_CREATION_DATE,
        },
    });
    const chunks = [];
    let bytes = 0;
    let pages = 1;
    doc.on('data', (chunk) => {
        chunks.push(chunk);
        bytes += chunk.length;
    });
    const ended = new Promise((resolve, reject) => {
        doc.on('end', resolve);
        doc.on('error', reject);
    });
    // Thrown from inside doc.text(); aborts the layout early instead of
    // rendering hundreds of pages that will be discarded anyway.
    doc.on('pageAdded', () => {
        pages += 1;
        if (pages > maxPages) throw new PdfLimitError('page', pages);
        if (bytes > maxBytes) throw new PdfLimitError('size', bytes);
    });

    fontSet.fonts.forEach((entry, index) => doc.registerFont(`pr-${index}`, entry.font));
    const router = createFontRouter(fontSet.fonts);
    const textOptions = { width: doc.page.width - PAGE_MARGIN * 2, lineGap: LINE_GAP };

    for (const block of blocks) {
        doc.font('pr-0').fontSize(FONT_SIZE).fillColor(LABEL_COLOR).text(ROLE_LABELS[block.role], textOptions);
        doc.fillColor(TEXT_COLOR);
        // One text() call per line: a font switch inside a line uses
        // `continued`, and a continued fragment must never end in '\n'
        // (pdfkit would resume the next fragment on the finished line).
        for (const line of sanitizeText(block.text).split('\n')) {
            if (line.length === 0) {
                doc.font('pr-0').moveDown(1);
                continue;
            }
            const runs = router.splitRuns(line);
            for (let i = 0; i < runs.length; i++) {
                const run = runs[i];
                doc.font(`pr-${run.font}`).text(run.text, {
                    ...textOptions,
                    continued: i < runs.length - 1,
                    ...(run.font === 0 ? {} : { features: { ...NO_LIGATURES } }),
                });
            }
        }
        doc.font('pr-0').moveDown(BLOCK_GAP_LINES);
    }
    doc.end();
    await ended;
    const pdf = Buffer.concat(chunks);
    if (pdf.length > maxBytes) throw new PdfLimitError('size', pdf.length);
    return { pdf, pages, bytes: pdf.length, replacedChars: router.stats.replaced };
}

// --- input validation and cache --------------------------------------------

function validateBlocks(raw, maxInputChars) {
    if (!Array.isArray(raw) || raw.length === 0) return { error: 'blocks must be a non-empty array' };
    if (raw.length > MAX_BLOCKS) return { tooLarge: true };
    const blocks = [];
    let chars = 0;
    for (const item of raw) {
        const role = item && typeof item === 'object' ? item.role : undefined;
        const text = item && typeof item === 'object' ? item.text : undefined;
        if (!Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)) return { error: `unknown role: ${String(role)}` };
        if (typeof text !== 'string') return { error: 'block text must be a string' };
        chars += text.length;
        if (chars > maxInputChars) return { tooLarge: true };
        blocks.push({ role, text });
    }
    return { blocks, chars };
}

function createLruCache({ maxEntries, maxBytes }) {
    const map = new Map();
    let totalBytes = 0;
    return {
        get(key) {
            const hit = map.get(key);
            if (!hit) return undefined;
            map.delete(key);
            map.set(key, hit);
            return hit.value;
        },
        set(key, value, size) {
            const old = map.get(key);
            if (old) {
                totalBytes -= old.size;
                map.delete(key);
            }
            if (size > maxBytes) return;
            map.set(key, { value, size });
            totalBytes += size;
            while (map.size > maxEntries || totalBytes > maxBytes) {
                const oldestKey = map.keys().next().value;
                totalBytes -= map.get(oldestKey).size;
                map.delete(oldestKey);
            }
        },
        clear() {
            map.clear();
            totalBytes = 0;
        },
        get size() {
            return map.size;
        },
    };
}

function cacheKey(fontSet, blocks) {
    return nodeCrypto.createHash('sha256')
        .update(JSON.stringify([PDF_RENDER_VERSION, fontSet.id, blocks]))
        .digest('hex');
}

// --- service ------------------------------------------------------------------

function createGeminiPdfInput(opts = {}) {
    const logger = opts.logger || console;
    const limits = {
        maxPages: opts.maxPages ?? MAX_PDF_PAGES,
        maxBytes: opts.maxBytes ?? MAX_PDF_BYTES,
        maxInputChars: opts.maxInputChars ?? MAX_INPUT_CHARS,
    };
    const cache = createLruCache({
        maxEntries: opts.cacheMaxEntries ?? CACHE_MAX_ENTRIES,
        maxBytes: opts.cacheMaxBytes ?? CACHE_MAX_BYTES,
    });

    // undefined = not looked up yet; null = no usable font (feature unavailable).
    let fontSet;
    function getFontSet() {
        if (fontSet === undefined) {
            fontSet = resolveFontSet({
                env: opts.env,
                platform: opts.platform,
                primaryCandidates: opts.primaryCandidates,
                fallbackCandidates: opts.fallbackCandidates,
            });
            if (fontSet) logger.info(`[GeminiPdfInput] PDF font: ${fontSet.label}`);
            else logger.warn('[GeminiPdfInput] No Korean-capable font found; Gemini PDF input is unavailable. Set POCKETRISU_PDF_FONT to a .ttf/.otf/.ttc file.');
        }
        return fontSet;
    }

    function status() {
        const set = getFontSet();
        return set
            ? { available: true, font: path.basename(set.fonts[0].file), fallbacks: set.fonts.slice(1).map((f) => path.basename(f.file)) }
            : { available: false };
    }

    // Resolves to { ok: true, pdf, pages, bytes, cached, replacedChars } or
    // { ok: false, reason, httpStatus, message? }. reason: invalid | too-large
    // | no-font. Unexpected render errors reject.
    async function render(rawBlocks) {
        const checked = validateBlocks(rawBlocks, limits.maxInputChars);
        if (checked.error) return { ok: false, reason: 'invalid', httpStatus: 400, message: checked.error };
        if (checked.tooLarge) return { ok: false, reason: 'too-large', httpStatus: 413, message: 'input too large' };
        const set = getFontSet();
        if (!set) return { ok: false, reason: 'no-font', httpStatus: 503, message: 'no usable font on the server' };

        const key = cacheKey(set, checked.blocks);
        const hit = cache.get(key);
        if (hit) return { ok: true, ...hit, cached: true };
        try {
            const result = await renderTranscriptPdf(checked.blocks, set, limits);
            cache.set(key, result, result.bytes);
            return { ok: true, ...result, cached: false };
        } catch (err) {
            if (err instanceof PdfLimitError) {
                return { ok: false, reason: 'too-large', httpStatus: 413, message: err.message };
            }
            throw err;
        }
    }

    // Express wiring. `auth(req, res)` behaves like server.cjs checkProxyAuth:
    // it sends its own error response and returns false on failure.
    function registerRoutes(app, { auth }) {
        app.post('/api/gemini/pdf-input', async (req, res) => {
            if (!await auth(req, res)) return;
            const started = Date.now();
            try {
                const result = await render(req.body && req.body.blocks);
                if (!result.ok) {
                    res.status(result.httpStatus).send({ ok: false, reason: result.reason, error: result.message });
                    return;
                }
                res.send({
                    ok: true,
                    mimeType: 'application/pdf',
                    data: result.pdf.toString('base64'),
                    pages: result.pages,
                    bytes: result.bytes,
                    cached: result.cached,
                    replacedChars: result.replacedChars,
                    renderMs: Date.now() - started,
                });
            } catch (err) {
                logger.error('[GeminiPdfInput] PDF render failed', err);
                res.status(500).send({ ok: false, reason: 'render-failed', error: String((err && err.message) || err) });
            }
        });
    }

    return {
        render,
        status,
        registerRoutes,
        clearCache: () => cache.clear(),
        get cacheSize() {
            return cache.size;
        },
    };
}

module.exports = {
    createGeminiPdfInput,
    renderTranscriptPdf,
    resolveFontSet,
    primaryFontCandidates,
    fallbackFontCandidates,
    sanitizeText,
    createLruCache,
    PdfLimitError,
    ROLE_LABELS,
    MAX_PDF_BYTES,
    MAX_PDF_PAGES,
    MAX_INPUT_CHARS,
    PDF_RENDER_VERSION,
};
