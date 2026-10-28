// What an AI image says about how it was made (the user's request,
// 2026-10-20): drop a NovelAI image on the illustration settings and its
// prompt, negative prompt and settings become a "프리셋 X" lorebook folder
// (Positive, Negative, NAI entries since 2026-10-28), taken whole for the user
// to trim (illustration.ts reads it back).
//
// Where the data lives:
// - PNG text chunks: NovelAI writes Description (the prompt) and Comment (a
//   JSON of everything); Stable Diffusion WebUI writes "parameters".
// - NovelAI's "stealth" copy in the alpha channel's lowest bits, read column
//   by column, which survives sites that drop the text chunks:
//   "stealth_pnginfo" or "stealth_pngcomp" (gzip), a 32-bit length in bits,
//   then a JSON with the same keys as the text chunks.
// - EXIF (JPEG, WebP): UserComment or ImageDescription.
import { gunzipSync, strFromU8, unzlibSync } from 'fflate'
import type { NaiParams, PresetSections } from './illustration'
import { naiModelFromSource } from './naiOptions'

export interface ImageGenMeta {
    source: 'novelai' | 'webui'
    prompt: string
    negative: string
    characters: { positive: string, negative: string }[]
    params: NaiParams
    model?: string
    size?: { width: number, height: number }
}

const utf8 = new TextDecoder('utf-8')
const latin1 = new TextDecoder('latin1')

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export function isPng(bytes: Uint8Array): boolean {
    return PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

const u32 = (bytes: Uint8Array, at: number) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0

/** tEXt, zTXt and iTXt chunks of a PNG, by keyword. */
export function readPngText(bytes: Uint8Array): Record<string, string> {
    const texts: Record<string, string> = {}
    if (!isPng(bytes)) return texts
    let at = 8
    while (at + 12 <= bytes.length) {
        const length = u32(bytes, at)
        const type = latin1.decode(bytes.subarray(at + 4, at + 8))
        const data = bytes.subarray(at + 8, at + 8 + length)
        at += 12 + length
        if (type === 'IEND') break
        try {
            const nul = data.indexOf(0)
            if (nul < 0) continue
            const keyword = latin1.decode(data.subarray(0, nul))
            if (type === 'tEXt') {
                // Spec says Latin-1; NovelAI and WebUI write UTF-8.
                texts[keyword] = utf8.decode(data.subarray(nul + 1))
            } else if (type === 'zTXt') {
                texts[keyword] = utf8.decode(unzlibSync(data.subarray(nul + 2)))
            } else if (type === 'iTXt') {
                const compressed = data[nul + 1] === 1
                let rest = nul + 3
                rest = data.indexOf(0, rest) + 1 // language tag
                rest = data.indexOf(0, rest) + 1 // translated keyword
                const body = data.subarray(rest)
                texts[keyword] = utf8.decode(compressed ? unzlibSync(body) : body)
            }
        } catch {
            // A broken chunk is skipped; the others may still tell.
        }
    }
    return texts
}

/**
 * NovelAI's stealth data in the alpha channel's lowest bits (column-major),
 * or null. `rgba` is ImageData.data (4 bytes per pixel, row-major).
 */
export function readStealthInfo(rgba: ArrayLike<number>, width: number, height: number): string | null {
    const total = width * height
    if (total < 15 * 8 + 32) return null
    let position = 0
    const nextBit = () => {
        if (position >= total) return -1
        const x = Math.floor(position / height)
        const y = position % height
        position++
        return rgba[(y * width + x) * 4 + 3] & 1
    }
    const readBytes = (count: number): Uint8Array | null => {
        const out = new Uint8Array(count)
        for (let i = 0; i < count; i++) {
            let value = 0
            for (let b = 0; b < 8; b++) {
                const bit = nextBit()
                if (bit < 0) return null
                value = (value << 1) | bit
            }
            out[i] = value
        }
        return out
    }
    const signature = readBytes(15)
    if (!signature) return null
    const name = latin1.decode(signature)
    if (name !== 'stealth_pnginfo' && name !== 'stealth_pngcomp') return null
    let bits = 0
    for (let i = 0; i < 32; i++) {
        const bit = nextBit()
        if (bit < 0) return null
        bits = bits * 2 + bit
    }
    if (bits <= 0 || bits % 8 !== 0 || position + bits > total) return null
    const data = readBytes(bits / 8)
    if (!data) return null
    try {
        return name === 'stealth_pngcomp' ? strFromU8(gunzipSync(data)) : utf8.decode(data)
    } catch {
        return null
    }
}

/** Text fields of the EXIF block of a JPEG or WebP (UserComment, ImageDescription). */
export function readExifText(bytes: Uint8Array): string[] {
    const tiff = findTiff(bytes)
    if (!tiff) return []
    return readTiffTexts(tiff)
}

function findTiff(bytes: Uint8Array): Uint8Array | null {
    const exifHeader = (at: number) => latin1.decode(bytes.subarray(at, at + 6)) === 'Exif\0\0'
    // JPEG: APP1 segment.
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        let at = 2
        while (at + 4 <= bytes.length && bytes[at] === 0xff) {
            const marker = bytes[at + 1]
            const length = (bytes[at + 2] << 8) | bytes[at + 3]
            if (marker === 0xe1 && exifHeader(at + 4)) return bytes.subarray(at + 10, at + 2 + length)
            if (marker === 0xda) break
            at += 2 + length
        }
        return null
    }
    // WebP: RIFF chunk "EXIF".
    if (latin1.decode(bytes.subarray(0, 4)) === 'RIFF' && latin1.decode(bytes.subarray(8, 12)) === 'WEBP') {
        let at = 12
        while (at + 8 <= bytes.length) {
            const type = latin1.decode(bytes.subarray(at, at + 4))
            const size = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24)
            if (type === 'EXIF') {
                const start = at + 8
                return exifHeader(start) ? bytes.subarray(start + 6, start + size) : bytes.subarray(start, start + size)
            }
            at += 8 + size + (size % 2)
        }
    }
    return null
}

function readTiffTexts(tiff: Uint8Array): string[] {
    const little = tiff[0] === 0x49
    const u16 = (at: number) => little ? tiff[at] | (tiff[at + 1] << 8) : (tiff[at] << 8) | tiff[at + 1]
    const u32le = (at: number) => little
        ? (tiff[at] | (tiff[at + 1] << 8) | (tiff[at + 2] << 16) | (tiff[at + 3] << 24)) >>> 0
        : ((tiff[at] << 24) | (tiff[at + 1] << 16) | (tiff[at + 2] << 8) | tiff[at + 3]) >>> 0
    const texts: string[] = []
    const readIfd = (offset: number, depth: number) => {
        if (depth > 2 || offset + 2 > tiff.length) return
        const count = u16(offset)
        for (let i = 0; i < count; i++) {
            const entry = offset + 2 + i * 12
            if (entry + 12 > tiff.length) return
            const tag = u16(entry)
            const n = u32le(entry + 4)
            const valueAt = n > 4 ? u32le(entry + 8) : entry + 8
            if (tag === 0x8769) readIfd(u32le(entry + 8), depth + 1)
            else if (tag === 0x010e && valueAt + n <= tiff.length) texts.push(utf8.decode(tiff.subarray(valueAt, valueAt + n)).replace(/\0+$/, ''))
            else if (tag === 0x9286 && valueAt + n <= tiff.length) texts.push(decodeUserComment(tiff.subarray(valueAt, valueAt + n), little))
        }
    }
    if (tiff.length < 8) return texts
    readIfd(u32le(4), 0)
    return texts.filter((text) => text.trim())
}

function decodeUserComment(data: Uint8Array, little: boolean): string {
    const code = latin1.decode(data.subarray(0, 8))
    const body = data.subarray(8)
    if (code.startsWith('UNICODE')) {
        // Mostly big-endian UTF-16 whatever the TIFF order; guess from the bytes.
        const be = body.length > 1 && body[0] === 0 && body[1] !== 0
        return new TextDecoder(be || !little ? 'utf-16be' : 'utf-16le').decode(body).replace(/\0+$/, '')
    }
    return utf8.decode(code.startsWith('ASCII') || code === '\0\0\0\0\0\0\0\0' ? body : data).replace(/\0+$/, '')
}

const numberOf = (value: unknown) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
}

/** NovelAI's "Comment" JSON (or a stealth JSON holding it). */
function fromNovelAI(comment: Record<string, any>, extra: Record<string, string>): ImageGenMeta | null {
    const prompt = typeof comment.prompt === 'string' ? comment.prompt
        : typeof comment.v4_prompt?.caption?.base_caption === 'string' ? comment.v4_prompt.caption.base_caption
        : extra.Description ?? ''
    if (!prompt.trim()) return null
    const chars = Array.isArray(comment.v4_prompt?.caption?.char_captions) ? comment.v4_prompt.caption.char_captions : []
    const charNegatives = Array.isArray(comment.v4_negative_prompt?.caption?.char_captions) ? comment.v4_negative_prompt.caption.char_captions : []
    const params: NaiParams = {}
    const steps = numberOf(comment.steps); if (steps !== undefined) params.steps = steps
    const scale = numberOf(comment.scale); if (scale !== undefined) params.scale = scale
    if (typeof comment.sampler === 'string') params.sampler = comment.sampler
    const rescale = numberOf(comment.cfg_rescale); if (rescale !== undefined) params.cfg_rescale = rescale
    if (typeof comment.noise_schedule === 'string') params.noise_schedule = comment.noise_schedule
    if (typeof comment.sm === 'boolean') params.sm = comment.sm
    if (typeof comment.sm_dyn === 'boolean') params.sm_dyn = comment.sm_dyn
    if (comment.skip_cfg_above_sigma != null) params.variety = true
    const seed = numberOf(comment.seed); if (seed !== undefined) params.seed = seed
    const width = numberOf(comment.width)
    const height = numberOf(comment.height)
    return {
        source: 'novelai',
        prompt: prompt.trim(),
        negative: String(comment.uc ?? comment.negative_prompt ?? comment.v4_negative_prompt?.caption?.base_caption ?? '').trim(),
        characters: chars.map((c: any, i: number) => ({
            positive: String(c?.char_caption ?? '').trim(),
            negative: String(charNegatives[i]?.char_caption ?? '').trim(),
        })).filter((c: { positive: string }) => c.positive),
        params,
        ...(extra.Source ? { model: extra.Source } : {}),
        ...(width && height ? { size: { width, height } } : {}),
    }
}

/** Stable Diffusion WebUI's "parameters" text. */
export function parseWebuiParameters(text: string): ImageGenMeta | null {
    const lines = (text ?? '').split('\n')
    const settingsIndex = lines.findIndex((line) => /^Steps:\s*\d+/.test(line.trim()))
    const body = (settingsIndex >= 0 ? lines.slice(0, settingsIndex) : lines).join('\n')
    const negativeAt = body.indexOf('Negative prompt:')
    const prompt = (negativeAt >= 0 ? body.slice(0, negativeAt) : body).trim()
    if (!prompt) return null
    const negative = negativeAt >= 0 ? body.slice(negativeAt + 'Negative prompt:'.length).trim() : ''
    const params: NaiParams = {}
    let size: ImageGenMeta['size']
    if (settingsIndex >= 0) {
        for (const part of lines[settingsIndex].split(/,\s*(?=[A-Za-z][\w ]*:)/)) {
            const [key, ...rest] = part.split(':')
            const value = rest.join(':').trim()
            switch (key.trim().toLowerCase()) {
                case 'steps': params.steps = numberOf(value); break
                case 'sampler': params.sampler = value; break
                case 'cfg scale': params.scale = numberOf(value); break
                case 'seed': params.seed = numberOf(value); break
                case 'schedule type': params.noise_schedule = value; break
                case 'size': {
                    const match = /^(\d+)x(\d+)$/.exec(value)
                    if (match) size = { width: Number(match[1]), height: Number(match[2]) }
                    break
                }
            }
        }
    }
    for (const key of Object.keys(params) as (keyof NaiParams)[]) if (params[key] === undefined) delete params[key]
    return { source: 'webui', prompt, negative, characters: [], params, ...(size ? { size } : {}) }
}

/** Read the generation data out of the text fields an image carries. */
export function metaFromTexts(texts: Record<string, string>): ImageGenMeta | null {
    if (texts.Comment) {
        try {
            const meta = fromNovelAI(JSON.parse(texts.Comment), texts)
            if (meta) return meta
        } catch {
            // not JSON: try the others
        }
    }
    if (texts.parameters) {
        const meta = parseWebuiParameters(texts.parameters)
        if (meta) return meta
    }
    for (const value of Object.values(texts)) {
        const text = (value ?? '').trim()
        if (text.startsWith('{')) {
            try {
                const json = JSON.parse(text)
                if (json && typeof json === 'object') {
                    // A stealth JSON holds the text chunks; Comment inside is a JSON string.
                    if (typeof json.Comment === 'string') {
                        const inner = metaFromTexts(Object.fromEntries(Object.entries(json).map(([k, v]) => [k, String(v ?? '')])))
                        if (inner) return inner
                    }
                    const meta = fromNovelAI(json, {})
                    if (meta) return meta
                }
            } catch {
                // keep looking
            }
        } else if (/Negative prompt:|(^|\n)Steps:\s*\d+/.test(text)) {
            const meta = parseWebuiParameters(text)
            if (meta) return meta
        }
    }
    if (texts.Description?.trim()) {
        return { source: 'novelai', prompt: texts.Description.trim(), negative: '', characters: [], params: {} }
    }
    return null
}

/**
 * A "프리셋 X" folder's entries from an image: everything it said, for the
 * user to trim to the style. Notes are comments of the NAI entry (2026-10-28,
 * one entry per section); the model comes from Source when it says which.
 */
export function presetSectionsFromMeta(meta: ImageGenMeta, label: string): PresetSections {
    const lines: string[] = [
        `# 이미지에서 가져온 프리셋: ${label}${meta.model ? ` (${meta.model})` : ''}`,
        '# Positive 항목에는 그 그림의 프롬프트가 전부 들어 있어요. 장면 태그는 지우고 그림체(작가·품질 태그)만 남기세요.',
        '# {prompt} 를 넣으면 장면 태그가 그 자리에, 없으면 맨 앞에 붙습니다.',
    ]
    meta.characters.forEach((c, i) => {
        lines.push(`# 인물 ${i + 1} (참고): ${c.positive}${c.negative ? ` / 부정: ${c.negative}` : ''}`)
    })
    if (meta.size) lines.push(`# 원래 크기: ${meta.size.width}×${meta.size.height} (크기는 삽화 설정의 비율을 따릅니다)`)
    const p = meta.params
    if (meta.source === 'webui') lines.push('# Stable Diffusion WebUI 값이라 NovelAI 이름과 다를 수 있어요(샘플러 등).')
    const model = meta.source === 'novelai' ? naiModelFromSource(meta.model) : undefined
    if (model?.sure) lines.push(`model: ${model.model}`)
    else if (model) lines.push(`# model: ${model.model}   (Source에 Full/Curated 표시가 없어 Full로 짐작했어요. 맞으면 # 를 지우세요)`)
    if (p.steps !== undefined) lines.push(`steps: ${p.steps}`)
    if (p.scale !== undefined) lines.push(`scale: ${p.scale}`)
    if (p.sampler) lines.push(`${meta.source === 'webui' ? '# ' : ''}sampler: ${p.sampler}`)
    if (p.cfg_rescale !== undefined) lines.push(`cfg_rescale: ${p.cfg_rescale}`)
    if (p.noise_schedule) lines.push(`${meta.source === 'webui' ? '# ' : ''}noise_schedule: ${p.noise_schedule}`)
    if (p.sm !== undefined) lines.push(`smea: ${p.sm}`)
    if (p.sm_dyn !== undefined) lines.push(`dyn: ${p.sm_dyn}`)
    if (p.variety) lines.push('variety: true')
    if (p.seed !== undefined) lines.push(`# seed: ${p.seed}   (# 를 지우면 매번 같은 시드로 그립니다)`)
    return { positive: meta.prompt, negative: meta.negative, nai: lines.join('\n') }
}

/** A preset name from a file name: its base, trimmed. */
export function presetNameFromFile(fileName: string): string {
    const base = (fileName ?? '').replace(/\.[a-z0-9]+$/i, '').trim()
    return base.slice(0, 40) || '이미지'
}

/** A dropped image file: its text chunks or EXIF first, then the stealth copy. */
export async function readImageGenMeta(file: Blob): Promise<ImageGenMeta | null> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const texts = isPng(bytes)
        ? readPngText(bytes)
        : Object.fromEntries(readExifText(bytes).map((text, index) => [`exif${index}`, text]))
    const meta = metaFromTexts(texts)
    if (meta) return meta
    try {
        const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return null
        context.drawImage(bitmap, 0, 0)
        bitmap.close()
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        const stealth = readStealthInfo(pixels, canvas.width, canvas.height)
        return stealth ? metaFromTexts({ stealth }) : null
    } catch {
        return null
    }
}
