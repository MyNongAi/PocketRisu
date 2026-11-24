import { describe, expect, it } from 'vitest'
import { addAssetName, assetPrefix, collapseAlternativeAssetMacros, findAssetName, normalizedAssetKey, type AssetNameIndex } from './assetNameMatch'

function distance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
        const current = [i]
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
        }
        previous = current
    }
    return previous[b.length]
}

describe('asset names', () => {
    it('normalizes quotes, extensions, case and separators', () => {
        for (const name of ['"Narin.surprised"', "'NARIN_surprised.webp'", '“Narin-surprised.PNG”', 'Narin surprised']) {
            expect(normalizedAssetKey(name)).toBe('narinsurprised')
        }
        expect(normalizedAssetKey('  Io.proud.mp4  ')).toBe('ioproud')
    })

    it('extracts a character prefix only when a dot or underscore follows it', () => {
        expect(assetPrefix('Narin.surprised')).toBe('narin')
        expect(assetPrefix('"Io.proud"')).toBe('io')
        expect(assetPrefix('0_smug.webp')).toBe('0')
        expect(assetPrefix('angry.png')).toBeNull()
    })

    it('keeps the first normalized asset in owner order', () => {
        const index: AssetNameIndex<string> = { normalized: new Map(), prefixes: new Set() }
        addAssetName(index, 'Io.proud.webp', 'first-module')
        addAssetName(index, 'Io_proud.png', 'later-module')
        expect(index.normalized.get(normalizedAssetKey('"IO.proud"'))).toBe('first-module')
    })

    it('searches exact, then all normalized names, then guarded bot fuzzy names', () => {
        const bot = ['Baek.surprised.webp', 'Baek.excited.webp', 'Baek.shocked.webp', 'Elf.proud.webp']
        const modules = ['Narin.surprised.webp', 'Io.proud.webp']
        const exact = new Map<string, string>()
        const index: AssetNameIndex<string> = { normalized: new Map(), prefixes: new Set() }
        for (const name of [...bot, ...modules]) {
            exact.set(name.toLowerCase(), name)
            addAssetName(index, name, name)
        }
        const fuzzyCandidates = bot.map((name) => ({ name, value: name }))
        const find = (name: string) => findAssetName(name, exact, index, fuzzyCandidates, 4, distance)
        expect(find('"Narin.surprised"')).toBe('Narin.surprised.webp')
        expect(find('"Baek.excited"')).toBe('Baek.excited.webp')
        expect(find('"Io.proud"')).toBe('Io.proud.webp')
        expect(find('"Narin.shocked"')).toBeUndefined()
        expect(find('Baek.exited')).toBe('Baek.excited.webp')
        expect(find('Baek.surprised.webp')).toBe('Baek.surprised.webp')

        // Exact names beat normalized names even when the latter came first.
        const conflictIndex: AssetNameIndex<string> = {
            normalized: new Map([['baeksurprised', 'other-normalized-file']]),
            prefixes: new Set(['baek']),
        }
        expect(findAssetName('Baek.surprised.webp', exact, conflictIndex, fuzzyCandidates, 4, distance))
            .toBe('Baek.surprised.webp')
    })
})

describe('collapseAlternativeAssetMacros', () => {
    it('keeps the first exact alternative, or the first spelling when neither is exact', () => {
        const data = '{{raw::a.webp}}{{raw::a}}'
        expect(collapseAlternativeAssetMacros(data, (name) => name === 'a')).toBe('{{raw::a}}')
        expect(collapseAlternativeAssetMacros(data, (name) => name === 'a.webp')).toBe('{{raw::a.webp}}')
        expect(collapseAlternativeAssetMacros(data, () => false)).toBe('{{raw::a.webp}}')
    })

    it('keeps the surrounding attribute text', () => {
        const data = '<img src="{{raw::Neon_x1.webp}}{{raw::Neon_x1}}" alt="">'
        expect(collapseAlternativeAssetMacros(data, (name) => name === 'neon_x1')).toBe('<img src="{{raw::Neon_x1}}" alt="">')
    })

    it('keeps the chosen macro type in a mixed raw and path run', () => {
        const data = '{{path::a}}{{raw::a.png}}'
        expect(collapseAlternativeAssetMacros(data, (name) => name === 'a.png')).toBe('{{raw::a.png}}')
        expect(collapseAlternativeAssetMacros(data, (name) => name === 'a')).toBe('{{path::a}}')
    })

    it('leaves different assets and separated macros unchanged', () => {
        for (const data of [
            '{{raw::a}}{{raw::b}}',
            '{{raw::a.webp}} {{raw::a}}',
            '{{raw::a.webp}}x{{raw::a}}',
        ]) {
            expect(collapseAlternativeAssetMacros(data, () => true)).toBe(data)
        }
    })

    it('selects the first exact name in a run of three spellings', () => {
        const data = '{{raw::a.webp}}{{raw::a.png}}{{raw::a}}'
        expect(collapseAlternativeAssetMacros(data, (name) => name === 'a.png' || name === 'a')).toBe('{{raw::a.png}}')
    })

    it('leaves other macro types unchanged', () => {
        const data = '{{img::a.webp}}{{img::a}}'
        expect(collapseAlternativeAssetMacros(data, () => true)).toBe(data)
    })

    it('passes lower-cased names to the exact lookup', () => {
        const names: string[] = []
        expect(collapseAlternativeAssetMacros('{{raw::A.WEBP}}{{raw::A}}', (name) => {
            names.push(name)
            return name === 'a'
        })).toBe('{{raw::A}}')
        expect(names).toEqual(['a.webp', 'a'])
    })
})
