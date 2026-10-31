// 에셋 통일 (the user's request, 2026-10-31): a chat switch for a bot played
// with several heroine modules (each one a bot turned into a module). Each
// of them brings its own image tag, its own display regexes that catch every
// tag of that shape, and its own "write images like this" instructions, so
// the AI mixes the shapes and each regex grabs the others' tags: images go
// missing. With the switch on:
//
// - the bot's and the modules' image regexes are skipped (a regex is an image
//   one when its own pattern names an image tag); status panels, text fixes
//   and the rest still run;
// - any image tag the AI writes, in whatever shape (<img="x">, <img cmd=x>,
//   <Aimg anna='x'>, {{img::x}}, ...), is looked up across the bot's and the
//   modules' assets and shown with the official {{img::}} output;
// - the request carries one image rule with every source's names, the lines
//   of the bot's and modules' own text that show an image tag are left out of
//   it, and earlier replies' tags are rewritten to the one shape. The prompt
//   preset is not touched.

export interface AssetSource {
    /** The bot's name, or the module's name without decoration. */
    label: string
    /** Asset names as stored (some keep their file extension). */
    names: readonly string[]
}

// ── Which regexes are image ones ─────────────────────────────────────────

const IMAGE_TAG_IN_PATTERN = /<\s*[a-z]{0,6}(?:i?mg|imag|lmg)|\bimg\s*(?:cmd|src)?\s*=|\{\{\s*(?:raw|asset|emotion|image|img)\s*::/i

/** A regex catches image tags when its own pattern names one. */
export function isImageScript(script: { in?: string }): boolean {
    const source = String(script.in ?? '').replace(/\\[sSdDwW][*+?]?/g, '').replace(/\\/g, '')
    return IMAGE_TAG_IN_PATTERN.test(source)
}

// ── Image tags in a reply ────────────────────────────────────────────────

const TAG = /<\s*([a-z]{0,6}(?:img|imag|lmg))\b([^<>]*?)\/?\s*>|\{\{\s*(img|image|asset)\s*::\s*([^{}]+?)\s*\}\}/gi
const NOT_A_NAME = /^(?:https?:|data:|blob:|\/|\.\/|assets\/|external:|\{\{)/i

function tagValue(attributes: string): string | null {
    // <img=Io.anal beads>: unquoted after a bare "=", spaces and all.
    const bare = /^\s*=\s*([^"'“”\s][^<>]*?)\s*$/.exec(attributes)
    if (bare) return bare[1]
    // An unquoted value runs up to the next attribute (<img cmd=Sumire_acting coy>).
    const values = [...attributes.matchAll(/([a-z-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|[“”]([^“”]*)[“”]|((?:(?!\s+[a-z-]+\s*=)[^"'“”>])+))/gi)]
        .map((m) => ({ attribute: m[1].toLowerCase(), value: (m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim() }))
    const pick = values.find((v) => v.attribute === 'src' || v.attribute === 'cmd') ?? values.at(-1)
    return pick?.value || null
}

/** Replace each image tag of `text` whose name `replace` turns into something. */
export function replaceImageTags(text: string, replace: (name: string, index: number) => string | null): string {
    let index = 0
    return text.replace(TAG, (whole, _tag, attributes, _cbs, cbsName) => {
        const name = cbsName ?? tagValue(attributes ?? '')
        if (!name || NOT_A_NAME.test(name)) return whole
        return replace(name, index++) ?? whole
    })
}

/** Leave out the lines that show an image tag (the sources' own image instructions). */
export function stripImageInstructionLines(text: string | undefined): string | undefined {
    if (!text) return text
    return text.split('\n').filter((line) => {
        TAG.lastIndex = 0
        return !TAG.test(line)
    }).join('\n')
}

// ── Finding a name ───────────────────────────────────────────────────────

const EXTENSION = /\.(?:png|webp|jpe?g|gif|avif|bmp|mp4|webm)$/i

function stem(name: string): string {
    return name.replace(EXTENSION, '')
}

function normalize(name: string): string {
    return stem(name.normalize('NFKC').trim()).toLowerCase().replace(/[\s_.\-]+/g, ' ').trim()
}

function cleanLabel(name: string): string {
    const cleaned = name
        .replace(/\(\s*에셋\s*\)|\[\s*에셋\s*\]/g, '')
        .replace(/모듈|module/gi, '')
        .replace(/[^\p{L}\p{N}&,'.\- ]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
    return cleaned || name.trim()
}

export function sourceLabel(name: string | undefined, fallback: string): string {
    return name ? cleanLabel(name) : fallback
}

/**
 * An asset name read as head + keyword (+ a variant number): the head is
 * what comes before the last "_" or "." (an outfit, a character: "daily",
 * "arin.normal", "Mahiro_Magical"), the keyword what comes after.
 */
interface Entry { source: number, name: string, key: string, head: string, tail: string }

export interface AssetIndex {
    sources: AssetSource[]
    entries: Entry[]
}

const VARIANT_SUFFIX = /[._\- ]\d+$/

function splitName(name: string): { head: string, tail: string } {
    const plain = stem(name.normalize('NFKC').trim()).replace(VARIANT_SUFFIX, '')
    const at = Math.max(plain.lastIndexOf('_'), plain.lastIndexOf('.'))
    return at > 0
        ? { head: normalize(plain.slice(0, at)), tail: normalize(plain.slice(at + 1)) }
        : { head: '', tail: normalize(plain) }
}

export function buildAssetIndex(sources: AssetSource[]): AssetIndex {
    const entries: Entry[] = []
    sources.forEach((source, sourceIndex) => {
        for (const name of source.names) {
            const key = normalize(name)
            if (key) entries.push({ source: sourceIndex, name, key, ...splitName(name) })
        }
    })
    return { sources, entries }
}

function editDistance(a: string, b: string, limit: number): number {
    if (Math.abs(a.length - b.length) > limit) return limit + 1
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
        const current = [i]
        let best = i
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
            best = Math.min(best, current[j])
        }
        if (best > limit) return limit + 1
        previous = current
    }
    return previous[b.length]
}

function seeded<T>(list: T[], seed: string): T {
    let hash = 2166136261
    for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619)
    return list[(hash >>> 0) % list.length]
}

export interface ResolveOptions {
    /** Same seed, same pick among numbered variants (a message drawn again). */
    seed?: string
    /** The head each source used last, for a keyword given without one. */
    lastHead?: Map<number, string>
}

function scopeOf(index: AssetIndex, raw: string): { only: number | null, wanted: string } {
    const colon = raw.indexOf(':')
    if (colon <= 0) return { only: null, wanted: raw }
    const label = normalize(raw.slice(0, colon))
    let found = index.sources.findIndex((source) => normalize(source.label) === label)
    if (found < 0) {
        found = index.sources.findIndex((source) => {
            const own = normalize(source.label)
            return own.length > 0 && label.length > 0 && (own.includes(label) || label.includes(own))
        })
    }
    return found < 0 ? { only: null, wanted: raw } : { only: found, wanted: raw.slice(colon + 1) }
}

/**
 * The asset an AI-written name stands for: the exact name; else the same
 * name with a variant number (one of them); else the keyword, with whatever
 * part of the head was written (the head the source used last, or the one
 * most of its names have); else the nearest name. "Label:name" keeps the
 * search to that source. The bot is searched before the modules.
 */
export function resolveAssetName(index: AssetIndex, raw: string, options: ResolveOptions = {}): { source: number, name: string } | null {
    const { only, wanted } = scopeOf(index, raw.trim())
    const key = normalize(wanted)
    if (!key) return null
    const candidates = only === null ? index.entries : index.entries.filter((entry) => entry.source === only)
    const seed = `${options.seed ?? ''}|${key}`
    const done = (list: Entry[]) => {
        const source = list[0].source
        const chosen = seeded(list.filter((entry) => entry.source === source), seed)
        if (chosen.head) options.lastHead?.set(source, chosen.head)
        return { source: chosen.source, name: chosen.name }
    }

    const exact = candidates.filter((entry) => entry.key === key)
    if (exact.length) return done(exact)
    const variants = candidates.filter((entry) => entry.key.replace(VARIANT_SUFFIX, '') === key)
    if (variants.length) return done(variants)

    // "happy" for daily_happy; "mahiro happy smile" for Mahiro_Magical_happy smile.
    const keyed = candidates.filter((entry) => {
        if (key === entry.tail) return true
        if (!key.endsWith(` ${entry.tail}`)) return false
        const heads = new Set(entry.head.split(' '))
        return key.slice(0, key.length - entry.tail.length - 1).split(' ').every((word) => heads.has(word))
    })
    if (keyed.length) {
        const source = keyed[0].source
        const own = keyed.filter((entry) => entry.source === source)
        const last = options.lastHead?.get(source)
        let head = last && own.some((entry) => entry.head === last) ? last : null
        if (head === null) {
            const counts = new Map<string, number>()
            for (const entry of index.entries) if (entry.source === source) counts.set(entry.head, (counts.get(entry.head) ?? 0) + 1)
            head = own.map((entry) => entry.head).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0]
        }
        return done(own.filter((entry) => entry.head === head))
    }

    const limit = Math.max(1, Math.floor(key.length * 0.25))
    let best: Entry | null = null
    let bestDistance = limit + 1
    for (const entry of candidates) {
        const distance = editDistance(key, entry.key, limit)
        if (distance < bestDistance) {
            best = entry
            bestDistance = distance
        }
    }
    return best ? { source: best.source, name: best.name } : null
}

// ── The one image rule ───────────────────────────────────────────────────

const MAX_WORDS_PER_SOURCE = 220

function describeSource(source: AssetSource): string | null {
    const names = [...new Set(source.names.map(stem))]
    if (names.length === 0) return null
    // Split at the last separator: what comes before is a head (character,
    // outfit), what comes after a keyword; a number at the end is a variant.
    const heads = new Map<string, number>()
    const words = new Set<string>()
    for (const name of names) {
        const plain = name.replace(/[._\- ]\d+$/, '')
        const at = Math.max(plain.lastIndexOf('_'), plain.lastIndexOf('.'))
        if (at > 0) {
            heads.set(plain.slice(0, at + 1), (heads.get(plain.slice(0, at + 1)) ?? 0) + 1)
            words.add(plain.slice(at + 1))
        } else {
            words.add(plain)
        }
    }
    const shared = [...heads].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).map(([head]) => head)
    const list = [...words]
    const shown = list.slice(0, MAX_WORDS_PER_SOURCE)
    const more = list.length - shown.length
    if (shared.length === 0 || shared.length > 16) {
        const plain = names.slice(0, MAX_WORDS_PER_SOURCE)
        return `- ${source.label}: ${plain.join(', ')}${names.length > plain.length ? ` (+${names.length - plain.length} more)` : ''}`
    }
    return `- ${source.label}: ${shared.join(' | ')} + one of: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
}

/** The rule the request carries while the switch is on. */
export function buildAssetGuide(sources: AssetSource[]): string {
    const lines = sources.map(describeSource).filter((line): line is string => !!line)
    if (lines.length === 0) return ''
    return [
        '[Image rule: this replaces every other image instruction in this chat]',
        'To show an image, write <img="Name"> on its own line, with Name made from the lists below (no file extension).',
        'A name is a head (if the list shows heads, such as an outfit or a character) followed by one keyword, e.g. <img="daily_happy">.',
        'If two characters could share a name, put the character first: <img="Label:Name">.',
        ...lines,
    ].join('\n')
}
