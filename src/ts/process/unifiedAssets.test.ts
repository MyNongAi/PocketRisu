import { describe, expect, it } from 'vitest'
import {
    buildAssetGuide,
    buildAssetIndex,
    isImageScript,
    replaceImageTags,
    resolveAssetName,
    sourceLabel,
    stripImageInstructionLines,
} from './unifiedAssets'

describe('which regexes are image ones', () => {
    it('knows a regex that catches an image tag, whatever its shape', () => {
        for (const pattern of [
            '<img="(.*?)">',
            '<\\s*imgs*=\\s*[”"](.*?)[”"]\\s*>',
            '<img cmd=(.*?)>',
            '<img cmd="((?:arin|yerin)\\.[^"]+)">',
            "<Aimg anna='(anna_[^\"]+)'>",
            '<Nimg="normal\\_(.+?)">',
            '<img src="(.*?)">',
            '<imag',
            '{{img::(.*?)}}',
        ]) expect(isImageScript({ in: pattern }), pattern).toBe(true)
    })

    it('leaves status panels, text fixes and placeholders alone', () => {
        for (const pattern of [
            '\\[Date:\\s*(.*?)\\s*\\|\\s*Time:\\s*(.*?)\\]',
            '{border}',
            '아타시',
            '<l',
            '(.*?)통',
            '\\{\\s*["“]Outfit["”]\\s*:\\s*["“]Daily["”]\\s*\\}',
        ]) expect(isImageScript({ in: pattern }), pattern).toBe(false)
    })
})

describe('image tags in a reply', () => {
    const names = (text: string) => {
        const found: string[] = []
        replaceImageTags(text, (name) => { found.push(name); return null })
        return found
    }

    it('reads the name out of every shape', () => {
        expect(names([
            '<img="happy smile">',
            '<img=Io.anal beads>',
            '<img cmd="arin normal happy">',
            '<img cmd=Sumire_acting coy>',
            "<Aimg anna='anna_smile'>",
            '<Nimg="normal_cry">',
            '<img ycmd="maid.full nelson cum.1">',
            '<img src="Madoka_jealous">',
            '{{img::kaoru_happy}}',
        ].join('\n'))).toEqual([
            'happy smile', 'Io.anal beads', 'arin normal happy', 'Sumire_acting coy', 'anna_smile',
            'normal_cry', 'maid.full nelson cum.1', 'Madoka_jealous', 'kaoru_happy',
        ])
    })

    it('leaves real pictures, built tags and plain text alone', () => {
        expect(names('<img src="https://x.test/a.png"> <img src="{{raw::a}}"> <imgur> hi <li>')).toEqual([])
    })

    it('keeps a tag it cannot place as it was', () => {
        expect(replaceImageTags('a <img="x"> b', () => null)).toBe('a <img="x"> b')
        expect(replaceImageTags('a <img="x"> b', (name) => `[${name}]`)).toBe('a [x] b')
    })

    it('leaves out the lines that show an image tag', () => {
        const text = 'She is shy.\n- Format: <img="Emotion">\n- e.g. <img="happy smile">, <img="sad">\nLikes cats.'
        expect(stripImageInstructionLines(text)).toBe('She is shy.\nLikes cats.')
        expect(stripImageInstructionLines(undefined)).toBe(undefined)
    })
})

describe('finding the asset a name stands for', () => {
    const sources = [
        { label: 'Jiyu', names: ['daily_worried', 'daily_happy smile', 'daily_shy', 'maid_worried', 'nude_Missionary position'] },
        { label: sourceLabel('❤️ Aoi Kaoru', 'm'), names: ['kaoru_happy', 'kaoru_crash'] },
        { label: sourceLabel('오오카오유 유즈카', 'm'), names: ['happy.1.webp', 'happy.2.webp'] },
        { label: sourceLabel('Mahiro', 'm'), names: ['Mahiro_Magical_happy smile', 'Mahiro_uniform_embarrassed'] },
        { label: sourceLabel('스미레 모듈', 'm'), names: ['Sumire_acting coy.png'] },
    ]
    const index = buildAssetIndex(sources)
    const find = (raw: string, lastHead?: Map<number, string>) => resolveAssetName(index, raw, { lastHead })?.name ?? null

    it('takes the exact name, ignoring case, separators and the file extension', () => {
        expect(find('daily_worried')).toBe('daily_worried')
        expect(find('Sumire acting coy')).toBe('Sumire_acting coy.png')
        expect(find('Mahiro.uniform.embarrassed')).toBe('Mahiro_uniform_embarrassed')
    })

    it('finds a keyword without its head: the head used last, else the most common one', () => {
        const lastHead = new Map<number, string>()
        expect(find('worried', lastHead)).toBe('daily_worried')
        expect(find('maid_worried', lastHead)).toBe('maid_worried')
        expect(find('worried', lastHead)).toBe('maid_worried')
    })

    it('keeps to the source a label names, and fills in a middle part left out', () => {
        expect(find('Kaoru:happy')).toBe('kaoru_happy')
        expect(find('Mahiro_happy smile')).toBe('Mahiro_Magical_happy smile')
    })

    it('picks one numbered variant, the same one for the same seed', () => {
        const first = resolveAssetName(index, 'happy', { seed: 'm3:0' })?.name
        expect(['happy.1.webp', 'happy.2.webp']).toContain(first)
        expect(resolveAssetName(index, 'happy', { seed: 'm3:0' })?.name).toBe(first)
    })

    it('takes the nearest name for a slip, and nothing for a stranger', () => {
        expect(find('kaoru_hapy')).toBe('kaoru_happy')
        expect(find('zzzz')).toBe(null)
    })
})

describe('the one image rule', () => {
    it('lists every source with its heads and keywords', () => {
        const guide = buildAssetGuide([
            { label: 'Jiyu', names: ['daily_worried', 'daily_shy', 'daily_sad', 'maid_worried', 'maid_shy', 'maid_sad'] },
            { label: 'Kaoru', names: ['kaoru_happy', 'kaoru_sad', 'kaoru_crash'] },
            { label: 'Empty', names: [] },
        ])
        expect(guide).toContain('<img="Name">')
        expect(guide).toContain('- Jiyu: daily_ | maid_ + one of: worried, shy, sad')
        expect(guide).toContain('- Kaoru: kaoru_ + one of: happy, sad, crash')
        expect(guide).not.toContain('Empty')
        expect(buildAssetGuide([])).toBe('')
    })

    it('names a module without its decoration', () => {
        expect(sourceLabel('(에셋) Arin&Yerin 예린, 아린', 'm')).toBe('Arin&Yerin 예린, 아린')
        expect(sourceLabel('❤️ ❤️ Anna', 'm')).toBe('Anna')
        expect(sourceLabel('스미레 모듈', 'm')).toBe('스미레')
    })
})
