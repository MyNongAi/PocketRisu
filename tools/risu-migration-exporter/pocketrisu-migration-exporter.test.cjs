'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')

const pluginModule = { exports: {} }
const pluginSource = fs.readFileSync(path.join(__dirname, 'pocketrisu-migration-exporter.js'), 'utf8')
const downloaded = []
const blobUrls = new Map()
let nextBlobUrl = 1
const mockDocument = {
    body: {
        appendChild() {},
    },
    createElement(tagName) {
        assert.equal(tagName, 'a')
        return {
            href: '',
            download: '',
            style: {},
            click() {
                downloaded.push({ filename: this.download, blob: blobUrls.get(this.href) })
            },
            remove() {},
        }
    },
}
vm.runInNewContext(pluginSource, {
    module: pluginModule,
    exports: pluginModule.exports,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Blob,
    URL: {
        createObjectURL(blob) {
            const id = `blob:test-${nextBlobUrl++}`
            blobUrls.set(id, blob)
            return id
        },
        revokeObjectURL(id) {
            blobUrls.delete(id)
        },
    },
    document: mockDocument,
    crypto: webcrypto,
    console,
    setTimeout(callback) {
        callback()
        return 0
    },
    clearTimeout,
}, { filename: 'pocketrisu-migration-exporter.js' })

const {
    FORMAT,
    MAGIC,
    sanitizeCharacter,
    collectInternalAssetPaths,
    buildCharacterLayout,
    normalizeSource,
    encodeBundleParts,
    decodeBundleBytes,
    exportKind,
} = pluginModule.exports

test('character export removes chats and per-character API secrets', () => {
    const result = sanitizeCharacter({
        chaId: 'c1',
        name: 'Bot',
        chats: [{ message: [{ data: 'large chat' }] }],
        chatFolders: [{ id: 'f1' }],
        chatPage: 7,
        coldstorage: 'cold-key',
        coldStoragedChats: ['chat-1'],
        desc: 'kept',
        oaiTTSConfig: { enabled: true, apiKey: 'secret', model: 'tts-1' },
    })

    assert.equal(result.desc, 'kept')
    assert.equal(result.chats.length, 0)
    assert.equal(result.chatFolders.length, 0)
    assert.equal(result.chatPage, 0)
    assert.equal(result.coldstorage, undefined)
    assert.equal(result.oaiTTSConfig.apiKey, undefined)
    assert.equal(result.oaiTTSConfig.model, 'tts-1')
})

test('secret export is opt-in', () => {
    const result = sanitizeCharacter({
        chaId: 'c1',
        oaiTTSConfig: { apiKey: 'secret' },
    }, { includeSecrets: true })
    assert.equal(result.oaiTTSConfig.apiKey, 'secret')
})

test('asset collector finds structured and embedded flat asset paths only', () => {
    const result = collectInternalAssetPaths({
        image: 'assets/main.png',
        css: `body { background: url("assets/bg.webp") }`,
        remote: 'https://example.test/assets/nope.png',
        misleading: 'notassets/nope.png',
        nested: 'assets/folder/nope.png',
        values: [['emotion', 'assets/emotion.gif']],
    })
    assert.deepEqual(Array.from(result).sort(), [
        'assets/bg.webp',
        'assets/emotion.gif',
        'assets/main.png',
    ])
})

test('character layout preserves source folders for selected IDs', () => {
    const result = buildCharacterLayout([
        'c1',
        { id: 'f1', name: 'Favorites', color: '#fff', imgFile: 'assets/folder.png', data: ['c2', 'missing'] },
    ], ['c1', 'c2'])
    assert.deepEqual(Array.from(result.loose), ['c1'])
    assert.equal(result.folders[0].name, 'Favorites')
    assert.deepEqual(Array.from(result.folders[0].characterIds), ['c2'])
})

test('source presets use stable labels and custom sources are trimmed', () => {
    assert.equal(JSON.stringify(normalizeSource('mobile-web')), JSON.stringify({ type: 'mobile-web', label: '모바일웹리스' }))
    assert.equal(JSON.stringify(normalizeSource('custom', '  태블릿 리스  ')), JSON.stringify({ type: 'custom', label: '태블릿 리스' }))
})

test('binary bundle round-trips metadata and assets', () => {
    const assets = [
        { path: 'assets/a.bin', hash: 'a'.repeat(64), size: 3, data: Uint8Array.from([1, 2, 3]) },
        { path: 'assets/b.bin', hash: 'b'.repeat(64), size: 2, data: Uint8Array.from([4, 5]) },
    ]
    const manifest = {
        format: FORMAT,
        version: 1,
        kind: 'modules',
        assets: assets.map(({ path, hash, size }) => ({ path, hash, size })),
    }
    const parts = encodeBundleParts(manifest, assets)
    const size = parts.reduce((sum, part) => sum + part.byteLength, 0)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
        bytes.set(part, offset)
        offset += part.byteLength
    }
    assert.equal(new TextDecoder().decode(bytes.subarray(0, MAGIC.length)), MAGIC)
    const decoded = decodeBundleBytes(bytes)
    assert.equal(decoded.manifest.kind, 'modules')
    assert.deepEqual(Array.from(decoded.assets[0].data), [1, 2, 3])
    assert.deepEqual(Array.from(decoded.assets[1].data), [4, 5])
})

test('full character export produces a source-labelled chatless bundle', async () => {
    downloaded.length = 0
    const api = {
        async getDatabase(keys) {
            assert.deepEqual(Array.from(keys), ['characters', 'characterOrder'])
            return {
                characters: [{
                    chaId: 'char-1',
                    name: 'Test Bot',
                    image: 'assets/avatar.png',
                    chats: [{ message: [{ data: 'must not escape' }] }],
                    chatPage: 0,
                }],
                characterOrder: ['char-1'],
            }
        },
        async readImage(path) {
            assert.equal(path, 'assets/avatar.png')
            return Uint8Array.from([10, 20, 30])
        },
    }
    const result = await exportKind(api, {
        kind: 'characters',
        sourceType: 'mobile-web',
        sourceInstanceId: 'phone-1',
        chunkSizeMb: 16,
    })

    assert.equal(result.itemCount, 1)
    assert.equal(downloaded.length, 1)
    assert.match(downloaded[0].filename, /^모바일웹리스-bots-001\.prisumigrate$/)
    const decoded = decodeBundleBytes(new Uint8Array(await downloaded[0].blob.arrayBuffer()))
    assert.equal(decoded.manifest.source.label, '모바일웹리스')
    assert.equal(decoded.manifest.source.instanceId, 'phone-1')
    assert.equal(decoded.manifest.data.characters[0].chats.length, 0)
    assert.equal(JSON.stringify(decoded.manifest.data.characters).includes('must not escape'), false)
    assert.equal(decoded.assets[0].path, 'assets/avatar.png')
    assert.equal(decoded.assets[0].size, 3)
    assert.match(decoded.assets[0].hash, /^[a-f0-9]{64}$/)
})

test('full module export stays separate and carries module assets', async () => {
    downloaded.length = 0
    const api = {
        async getDatabase(keys) {
            assert.deepEqual(Array.from(keys), ['modules'])
            return {
                modules: [{
                    id: 'module-1',
                    name: 'Test Module',
                    assets: [['portrait', 'assets/module.webp', 'image/webp']],
                    backgroundEmbedding: `<style>.x{background:url('assets/paper.png')}</style>`,
                }],
            }
        },
        async readImage(path) {
            if (path === 'assets/module.webp') return Uint8Array.from([1, 2])
            if (path === 'assets/paper.png') return Uint8Array.from([3, 4, 5])
            throw new Error(`unexpected asset ${path}`)
        },
    }
    const result = await exportKind(api, {
        kind: 'modules',
        sourceType: 'local',
        sourceInstanceId: 'desktop-1',
        chunkSizeMb: 16,
    })

    assert.equal(result.kind, 'modules')
    assert.equal(downloaded.length, 1)
    assert.match(downloaded[0].filename, /^로컬리스-modules-001\.prisumigrate$/)
    const decoded = decodeBundleBytes(new Uint8Array(await downloaded[0].blob.arrayBuffer()))
    assert.equal(decoded.manifest.data.modules[0].id, 'module-1')
    assert.deepEqual(Array.from(decoded.assets, (asset) => asset.path).sort(), [
        'assets/module.webp',
        'assets/paper.png',
    ])
})
