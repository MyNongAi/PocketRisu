import { describe, expect, it } from 'vitest'
import { gzipSync, strToU8, zlibSync } from 'fflate'
import { isPng, metaFromTexts, parseWebuiParameters, presetNameFromFile, presetSectionsFromMeta, readExifText, readPngText, readStealthInfo } from './imageMeta'
import { lorebookPresets } from './illustration'
import { presetLorebookFolder } from './illustrationModule'

/** The preset a folder made from these sections reads back as. */
const readBack = (name: string, sections: ReturnType<typeof presetSectionsFromMeta>) =>
    lorebookPresets([{ label: 'm', entries: presetLorebookFolder(name, sections, 'F') }])[0]

const enc = new TextEncoder()
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

function chunk(type: string, data: Uint8Array): number[] {
    return [...u32be(data.length), ...enc.encode(type), ...data, 0, 0, 0, 0]
}
function png(chunks: number[][]): Uint8Array {
    return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', new Uint8Array(13)), ...chunks.flat(), ...chunk('IEND', new Uint8Array(0))])
}
const tEXt = (key: string, text: string) => chunk('tEXt', new Uint8Array([...enc.encode(key), 0, ...enc.encode(text)]))

const naiComment = {
    prompt: '1girl, silver hair, artist:kat, best quality',
    uc: 'lowres, bad hands',
    steps: 28, scale: 5.5, sampler: 'k_euler_ancestral', cfg_rescale: 0.2, noise_schedule: 'karras',
    sm: false, sm_dyn: false, seed: 123456, width: 832, height: 1216, skip_cfg_above_sigma: 19.3,
    v4_prompt: { caption: { base_caption: 'ignored when prompt is there', char_captions: [{ char_caption: 'girl, red eyes', centers: [{ x: 0.5, y: 0.5 }] }] } },
    v4_negative_prompt: { caption: { base_caption: 'lowres', char_captions: [{ char_caption: 'hat', centers: [] }] } },
}

describe('reading how an image was made', () => {
    it('reads NovelAI text chunks: prompt, negative, characters and settings', () => {
        const bytes = png([tEXt('Description', naiComment.prompt), tEXt('Software', 'NovelAI'), tEXt('Source', 'NovelAI Diffusion V4.5'), tEXt('Comment', JSON.stringify(naiComment))])
        expect(isPng(bytes)).toBe(true)
        const texts = readPngText(bytes)
        expect(texts.Software).toBe('NovelAI')
        expect(metaFromTexts(texts)).toEqual({
            source: 'novelai',
            prompt: '1girl, silver hair, artist:kat, best quality',
            negative: 'lowres, bad hands',
            characters: [{ positive: 'girl, red eyes', negative: 'hat' }],
            params: { steps: 28, scale: 5.5, sampler: 'k_euler_ancestral', cfg_rescale: 0.2, noise_schedule: 'karras', sm: false, sm_dyn: false, variety: true, seed: 123456 },
            model: 'NovelAI Diffusion V4.5',
            size: { width: 832, height: 1216 },
        })
    })

    it('reads a compressed iTXt chunk', () => {
        const body = zlibSync(strToU8('a cat, sitting\nNegative prompt: blurry\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 9, Size: 512x768'))
        const itxt = chunk('iTXt', new Uint8Array([...enc.encode('parameters'), 0, 1, 0, 0, 0, ...body]))
        const meta = metaFromTexts(readPngText(png([itxt])))
        expect(meta).toMatchObject({ source: 'webui', prompt: 'a cat, sitting', negative: 'blurry', params: { steps: 20, sampler: 'Euler a', scale: 7, seed: 9 }, size: { width: 512, height: 768 } })
    })

    it('reads the stealth copy in the alpha channel (gzip, column by column)', () => {
        const width = 64, height = 64
        const rgba = new Uint8Array(width * height * 4).fill(254)
        const payload = gzipSync(strToU8(JSON.stringify({ Description: naiComment.prompt, Comment: JSON.stringify(naiComment) })))
        const bits: number[] = []
        const pushByte = (b: number) => { for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1) }
        for (const c of 'stealth_pngcomp') pushByte(c.charCodeAt(0))
        const n = payload.length * 8
        for (let i = 31; i >= 0; i--) bits.push(Math.floor(n / 2 ** i) % 2)
        payload.forEach(pushByte)
        bits.forEach((bit, i) => {
            const x = Math.floor(i / height), y = i % height
            rgba[(y * width + x) * 4 + 3] = 254 | bit
        })
        const text = readStealthInfo(rgba, width, height)
        expect(text).not.toBeNull()
        expect(metaFromTexts({ stealth: text! })?.prompt).toBe(naiComment.prompt)
        // a plain image has none
        expect(readStealthInfo(new Uint8Array(width * height * 4).fill(255), width, height)).toBeNull()
    })

    it('reads EXIF UserComment from a JPEG', () => {
        const text = 'a dog\nNegative prompt: text\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 6, Seed: 1'
        const comment = [...enc.encode('ASCII\0\0\0'), ...enc.encode(text)]
        // little-endian TIFF: IFD0 has one entry (ExifIFD pointer), which has one entry (UserComment)
        const le16 = (n: number) => [n & 255, n >> 8]
        const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
        const ifd0At = 8, exifAt = ifd0At + 2 + 12 + 4, dataAt = exifAt + 2 + 12 + 4
        const tiff = [
            0x49, 0x49, 42, 0, ...le32(ifd0At),
            ...le16(1), ...le16(0x8769), ...le16(4), ...le32(1), ...le32(exifAt), ...le32(0),
            ...le16(1), ...le16(0x9286), ...le16(7), ...le32(comment.length), ...le32(dataAt), ...le32(0),
            ...comment,
        ]
        const app1 = [...enc.encode('Exif\0\0'), ...tiff]
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1, 0xff, 0xda, 0, 2])
        const texts = readExifText(jpeg)
        expect(texts).toEqual([text])
        expect(metaFromTexts({ exif0: texts[0] })).toMatchObject({ source: 'webui', prompt: 'a dog', negative: 'text', params: { steps: 30, scale: 6, seed: 1 } })
    })

    it('says nothing for an image without generation data', () => {
        expect(metaFromTexts(readPngText(png([tEXt('Software', 'Paint')])))).toBeNull()
        expect(parseWebuiParameters('')).toBeNull()
    })
})

describe('a preset from an image', () => {
    it('keeps everything for the user to trim, and reads back as a preset with its NovelAI values', () => {
        const meta = metaFromTexts({ Comment: JSON.stringify(naiComment), Source: 'NovelAI Diffusion V4.5' })!
        const sections = presetSectionsFromMeta(meta, 'sample.png')
        expect(sections.nai).toContain('# 인물 1 (참고): girl, red eyes / 부정: hat')
        expect(sections.nai).toContain('# seed: 123456')
        // "V4.5" alone does not say Full or Curated: the guess stays commented.
        expect(sections.nai).toContain('# model: nai-diffusion-4-5-full')
        expect(readBack(presetNameFromFile('sample.png'), sections)).toEqual({
            name: 'sample',
            positive: '1girl, silver hair, artist:kat, best quality',
            negative: 'lowres, bad hands',
            nai: { steps: 28, scale: 5.5, sampler: 'k_euler_ancestral', cfg_rescale: 0.2, noise_schedule: 'karras', sm: false, sm_dyn: false, variety: true },
            source: 'm',
        })
    })

    it('takes the model when Source says which', () => {
        const curated = metaFromTexts({ Comment: JSON.stringify(naiComment), Source: 'NovelAI Diffusion V4.5 Curated 1A2B3C4D' })!
        expect(readBack('c', presetSectionsFromMeta(curated, 'c.png')).nai?.model).toBe('nai-diffusion-4-5-curated')
        const full = metaFromTexts({ Comment: JSON.stringify(naiComment), Source: 'NovelAI Diffusion V5 Full' })!
        expect(readBack('f', presetSectionsFromMeta(full, 'f.png')).nai?.model).toBe('nai-diffusion-5-full')
        const older = metaFromTexts({ Comment: JSON.stringify(naiComment), Source: 'Stable Diffusion XL C1E1DE52' })!
        expect(presetSectionsFromMeta(older, 'o.png').nai).not.toContain('model:')
    })

    it('leaves WebUI sampler names commented (NovelAI names differ)', () => {
        const meta = parseWebuiParameters('a cat\nSteps: 20, Sampler: Euler a, CFG scale: 7')!
        const preset = readBack('웹', presetSectionsFromMeta(meta, 'x.png'))
        expect(preset.nai).toEqual({ steps: 20, scale: 7 })
        expect(presetNameFromFile('my style.final.webp')).toBe('my style.final')
    })
})
