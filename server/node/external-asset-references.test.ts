import { describe, expect, it } from 'vitest'
import pkg from './external-asset-references.cjs'

const {
    collectAssetReferences,
    collectAssetReferenceSummary,
    collectEmbeddedInternalAssetNames,
    collectExternalAssetReferences,
    collectMalformedExternalAssetReferences,
    isInternalAssetPath,
    rewriteAssetReferences,
    rewriteAssetReferencesInPlace,
    rewriteExternalAssetReferences,
} = pkg as {
    collectAssetReferences: (db: unknown) => Array<{
        ownerType: string
        ownerId: string
        field: string
        path: string
        value: string
    }>
    collectAssetReferenceSummary: (db: unknown) => { references: number, uniquePaths: Set<string> }
    collectEmbeddedInternalAssetNames: (db: unknown) => Set<string>
    isInternalAssetPath: (value: unknown) => boolean
    rewriteAssetReferences: (db: unknown, mapping: Map<string, string> | Record<string, string>) => any
    rewriteAssetReferencesInPlace: (db: any, mapping: Map<string, string> | Record<string, string>) => {
        database: any
        changes: number
    }
    collectExternalAssetReferences: (db: unknown) => Array<{ value: string }>
    collectMalformedExternalAssetReferences: (db: unknown) => Array<{ value: string }>
    rewriteExternalAssetReferences: (db: unknown, mapping: Map<string, string> | Record<string, string>) => any
}

describe('large migration reference traversal', () => {
    it('matches the detailed collector without allocating occurrence paths', () => {
        const db = fixture()
        const detailed = collectAssetReferences(db)
        const summary = collectAssetReferenceSummary(db)

        expect(summary.references).toBe(detailed.length)
        expect(summary.uniquePaths).toEqual(new Set(detailed.map((reference) => reference.value)))
    })

    it('rewrites a detached snapshot in place and reports occurrence count', () => {
        const db = fixture()
        const before = collectAssetReferenceSummary(db)
        const mapping = new Map([...before.uniquePaths].map((value, index) => [
            value,
            `external://local/${String(index).padStart(64, 'a').slice(-64)}`,
        ]))

        const result = rewriteAssetReferencesInPlace(db, mapping)
        expect(result.database).toBe(db)
        expect(result.changes).toBe(before.references)
        expect(collectAssetReferenceSummary(db).references).toBe(0)
    })
})

function fixture() {
    return {
        userIcon: 'assets/persona-selected.webp',
        characters: [
            {
                chaId: 'char-a',
                image: 'assets/shared.webp',
                emotionImages: [
                    ['happy', 'assets/happy.png'],
                    ['same-as-thumbnail', 'assets/shared.webp'],
                    ['already-external', 'external://disk/external-hash'],
                    ['remote', 'https://example.com/remote.png'],
                    ['malformed'],
                ],
                additionalAssets: [
                    ['background', 'assets/background.jpg', 'jpg'],
                    null,
                ],
                vits: {
                    id: 'voice-a',
                    files: {
                        'model.onnx': 'assets/model.onnx',
                        'config.json': 'assets/config.json',
                        remote: 'https://example.com/model.bin',
                    },
                },
                ccAssets: [
                    { type: 'audio', uri: 'assets/voice.wav', name: 'voice', ext: 'wav' },
                    { type: 'image', uri: 'external://disk/cc-image', name: 'image', ext: 'png' },
                    null,
                ],
                gptSoVitsConfig: {
                    ref_audio_data: {
                        fileName: 'reference.wav',
                        assetId: 'assets/reference.wav',
                    },
                },
            },
            null,
        ],
        modules: [
            {
                id: 'module-a',
                assets: [
                    ['portrait', 'assets/portrait.png', 'png'],
                    ['duplicate', 'assets/shared.webp', 'webp'],
                    ['external', 'external://http/already-there', 'png'],
                    ['malformed'],
                ],
                icon: 'assets/module-icon.webp',
                backgroundEmbedding: 'assets/module-background.css',
            },
            {
                id: 'module-html',
                backgroundEmbedding: '<style>.chat { background: url(assets/not-a-direct-reference.png); }</style>',
            },
        ],
        personas: [
            {
                id: 'persona-a',
                icon: 'assets/persona-a.webp',
                embeddedModule: {
                    id: 'embedded-a',
                    assets: [['embedded', 'assets/embedded.png', 'png']],
                    icon: 'assets/embedded-icon.webp',
                },
            },
        ],
        unrelated: {
            image: 'assets/do-not-walk-arbitrary-fields.png',
        },
    }
}

describe('collectAssetReferences', () => {
    it('collects every supported character and module occurrence without deduplicating', () => {
        const references = collectAssetReferences(fixture())

        expect(references.map((reference) => reference.path)).toEqual([
            '/userIcon',
            '/characters/0/image',
            '/characters/0/emotionImages/0/1',
            '/characters/0/emotionImages/1/1',
            '/characters/0/additionalAssets/0/1',
            '/characters/0/vits/files/model.onnx',
            '/characters/0/vits/files/config.json',
            '/characters/0/ccAssets/0/uri',
            '/characters/0/gptSoVitsConfig/ref_audio_data/assetId',
            '/modules/0/assets/0/1',
            '/modules/0/assets/1/1',
            '/modules/0/icon',
            '/modules/0/backgroundEmbedding',
            '/personas/0/icon',
            '/personas/0/embeddedModule/assets/0/1',
            '/personas/0/embeddedModule/icon',
        ])
        expect(references.filter((reference) => reference.value === 'assets/shared.webp')).toHaveLength(3)
        expect(references.find((reference) => reference.field === 'vits.files')).toMatchObject({
            ownerType: 'character',
            ownerId: 'char-a',
        })
        expect(references.find((reference) => reference.path.includes('embeddedModule'))).toMatchObject({
            ownerType: 'module',
            ownerId: 'embedded-a',
        })
    })

    it('skips external URLs, non-assets paths, inline HTML, and arbitrary fields', () => {
        const values = collectAssetReferences(fixture()).map((reference) => reference.value)

        expect(values.some((value) => value.startsWith('external://'))).toBe(false)
        expect(values.some((value) => value.startsWith('https://'))).toBe(false)
        expect(values).not.toContain('assets/not-a-direct-reference.png')
        expect(values).not.toContain('assets/do-not-walk-arbitrary-fields.png')
        expect(isInternalAssetPath('assets/file.png')).toBe(true)
        expect(isInternalAssetPath('assets/')).toBe(false)
        expect(isInternalAssetPath('external://disk/file')).toBe(false)
    })

    it('returns an empty list for absent or unsupported top-level structures', () => {
        expect(collectAssetReferences(null)).toEqual([])
        expect(collectAssetReferences({ characters: 'invalid', modules: 42 })).toEqual([])
    })
})

describe('rewriteAssetReferences', () => {
    it('rewrites all duplicate occurrences from a Map without mutating the source', () => {
        const source = fixture()
        const before = structuredClone(source)
        const rewritten = rewriteAssetReferences(
            source,
            new Map([
                ['assets/shared.webp', 'external://disk/hash-shared'],
                ['assets/happy.png', 'external://disk/hash-happy'],
                ['assets/model.onnx', 'external://disk/hash-model'],
                ['assets/portrait.png', 'external://disk/hash-portrait'],
                ['assets/module-icon.webp', 'external://disk/hash-module-icon'],
                ['assets/module-background.css', 'external://disk/hash-module-background'],
                ['assets/embedded.png', 'external://disk/hash-embedded'],
            ]),
        )

        expect(source).toEqual(before)
        expect(rewritten).not.toBe(source)
        expect(rewritten.characters).not.toBe(source.characters)
        expect(rewritten.characters[0].image).toBe('external://disk/hash-shared')
        expect(rewritten.characters[0].emotionImages[1][1]).toBe('external://disk/hash-shared')
        expect(rewritten.modules[0].assets[1][1]).toBe('external://disk/hash-shared')
        expect(rewritten.characters[0].emotionImages[0][1]).toBe('external://disk/hash-happy')
        expect(rewritten.characters[0].vits.files['model.onnx']).toBe('external://disk/hash-model')
        expect(rewritten.modules[0].assets[0][1]).toBe('external://disk/hash-portrait')
        expect(rewritten.modules[0].icon).toBe('external://disk/hash-module-icon')
        expect(rewritten.modules[0].backgroundEmbedding).toBe('external://disk/hash-module-background')
        expect(rewritten.personas[0].embeddedModule.assets[0][1]).toBe('external://disk/hash-embedded')
        expect(rewritten.characters[0].additionalAssets[0][1]).toBe('assets/background.jpg')
        expect(rewritten.characters[0].emotionImages[2][1]).toBe('external://disk/external-hash')
        expect(rewritten.characters[0].gptSoVitsConfig.ref_audio_data.assetId).toBe('assets/reference.wav')
    })

    it('reports malformed external references separately from canonical URIs', () => {
        const malformed = collectMalformedExternalAssetReferences(fixture()).map((reference) => reference.value)
        expect(malformed).toContain('external://disk/external-hash')
        expect(malformed).toContain('external://disk/cc-image')
        expect(malformed).not.toContain(`external://local/${'a'.repeat(64)}`)
    })

    it('collects and safely rewrites legacy and per-persona icons', () => {
        const source = fixture()
        const rewritten = rewriteAssetReferences(source, new Map([
            ['assets/persona-selected.webp', `external://local/${'c'.repeat(64)}`],
            ['assets/persona-a.webp', `external://local/${'d'.repeat(64)}`],
        ]))

        expect(rewritten.userIcon).toBe(`external://local/${'c'.repeat(64)}`)
        expect(rewritten.personas[0].icon).toBe(`external://local/${'d'.repeat(64)}`)
        expect(source.userIcon).toBe('assets/persona-selected.webp')
        expect(source.personas[0].icon).toBe('assets/persona-a.webp')
    })

    it('rewrites the GPT-SoVITS reference audio asset without mutating the source', () => {
        const source = fixture()
        const replacement = `external://local/${'b'.repeat(64)}`
        const rewritten = rewriteAssetReferences(source, {
            'assets/reference.wav': replacement,
        })

        expect(rewritten.characters[0].gptSoVitsConfig.ref_audio_data.assetId).toBe(replacement)
        expect(source.characters[0].gptSoVitsConfig.ref_audio_data.assetId).toBe('assets/reference.wav')
    })

    it('accepts a plain mapping and ignores non-string or empty replacements', () => {
        const source = fixture()
        const rewritten = rewriteAssetReferences(source, {
            'assets/background.jpg': 'external://http/hash-background',
            'assets/config.json': '' as never,
            'assets/voice.wav': 123 as never,
        })

        expect(rewritten.characters[0].additionalAssets[0][1]).toBe('external://http/hash-background')
        expect(rewritten.characters[0].vits.files['config.json']).toBe('assets/config.json')
        expect(rewritten.characters[0].ccAssets[0].uri).toBe('assets/voice.wav')
        expect(source.characters[0].additionalAssets[0][1]).toBe('assets/background.jpg')
    })

    it('can clone cyclic decoded data while preserving the input', () => {
        const source: any = fixture()
        source.self = source
        const rewritten = rewriteAssetReferences(source, {
            'assets/shared.webp': 'external://disk/hash-shared',
        })

        expect(rewritten.self).toBe(rewritten)
        expect(source.self).toBe(source)
        expect(source.characters[0].image).toBe('assets/shared.webp')
        expect(rewritten.characters[0].image).toBe('external://disk/hash-shared')
    })
})

describe('upstream external reference materialization', () => {
    it('collects and rewrites canonical external references without mutating input', () => {
        const hash = 'a'.repeat(64)
        const uri = `external://local/${hash}`
        const db = {
            characters: [{
                chaId: 'c1',
                image: uri,
                emotionImages: [],
                additionalAssets: [],
                gptSoVitsConfig: { ref_audio_data: { fileName: 'voice.wav', assetId: uri } },
            }],
            modules: [{ id: 'm1', assets: [['x', uri, 'png']] }],
        }

        expect(collectExternalAssetReferences(db).map((ref) => ref.value)).toEqual([uri, uri, uri])
        const internal = `assets/external-${hash}.png`
        const rewritten = rewriteExternalAssetReferences(db, new Map([[uri, internal]]))
        expect(rewritten.characters[0].image).toBe(internal)
        expect(rewritten.modules[0].assets[0][1]).toBe(internal)
        expect(rewritten.characters[0].gptSoVitsConfig.ref_audio_data.assetId).toBe(internal)
        expect(db.characters[0].image).toBe(uri)
    })
})

describe('collectEmbeddedInternalAssetNames', () => {
    it('finds exact asset tokens in HTML, CSS, background embedding, and plugin strings', () => {
        const cyclic: any = {
            backgroundEmbedding: '<style>.chat{background:url("assets/chat-bg.webp")}</style>',
            html: '<img src=assets/portrait.png><audio src="assets/voice.ogg?cache=1">',
            plugins: [{
                script: "const icon = 'assets/plugin-icon.svg'; const again = `assets/chat-bg.webp`;",
            }],
            direct: 'assets/direct.bin',
            map: new Map([['asset', 'assets/from-map.dat']]),
            set: new Set(['assets/from-set.dat']),
        }
        cyclic.self = cyclic

        expect([...collectEmbeddedInternalAssetNames(cyclic)].sort()).toEqual([
            'chat-bg.webp',
            'direct.bin',
            'from-map.dat',
            'from-set.dat',
            'plugin-icon.svg',
            'portrait.png',
            'voice.ogg',
        ])
    })

    it('does not turn partial names, remote paths, nested paths, or malformed tokens into basenames', () => {
        const names = collectEmbeddedInternalAssetNames({
            strings: [
                'notassets/local.png',
                'some-assets/local.png',
                '/assets/server-public.png',
                'https://cdn.example/assets/remote.png',
                'external://provider/assets/not-a-hash.png',
                'assets/nested/file.png',
                'assets/',
                'assets/.hidden',
                'user@assets/mail-domain.png',
                '.assets/css-selector.png',
                'assets/similar.png.backup',
            ],
        })

        expect(names).toEqual(new Set(['similar.png.backup']))
        expect(names.has('local.png')).toBe(false)
        expect(names.has('remote.png')).toBe(false)
        expect(names.has('nested')).toBe(false)
        expect(names.has('similar.png')).toBe(false)
    })

    it('does not invoke accessors while walking decoded data', () => {
        const db = { direct: 'assets/kept.png' }
        Object.defineProperty(db, 'dangerous', {
            enumerable: true,
            get() {
                throw new Error('must not run')
            },
        })

        expect(collectEmbeddedInternalAssetNames(db)).toEqual(new Set(['kept.png']))
    })
})
