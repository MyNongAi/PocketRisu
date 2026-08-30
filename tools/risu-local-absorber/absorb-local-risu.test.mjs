import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
    buildImportAssetHealth,
    collectAssetPaths,
    mergeSourceCollections,
    organizeImportedMissingAssetFolders,
    planAndCopyAssets,
    prepareSourceDatabase,
    rewriteAssetPathsInPlace,
} from './absorb-local-risu.mjs'

test('existing content-addressed files without a surviving receipt are indexed, not falsely verified', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-absorber-'))
    try {
        const hash = 'a'.repeat(64)
        const externalRoot = path.join(root, 'store')
        const externalPath = path.join(externalRoot, hash.slice(0, 2), hash)
        fs.mkdirSync(path.dirname(externalPath), { recursive: true })
        fs.writeFileSync(externalPath, 'already copied by an earlier verified migration')
        const result = planAndCopyAssets({
            references: [`assets/${hash}.png`],
            sourceRoot: path.join(root, 'empty-source'),
            providerId: 'main-assets',
            externalRoot,
            externalHashes: new Set([hash]),
            verifiedExternalEntries: new Map(),
            kvGet: () => null,
            kvSize: () => null,
            targetAssetKeys: new Set(),
            manifestStore: { findByInternalKeySync: () => null, getSync: () => null },
            importId: 'test-import',
            execute: true,
        })
        assert.equal(result.indexedExternal, 1)
        assert.equal(result.manifestValues[0].value.status, 'indexed')
        assert.equal(result.manifestValues[0].value.size, 0)
        assert.equal(result.manifestValues[0].value.sizeKnown, false)
        assert.equal('lastVerifiedAt' in result.manifestValues[0].value, false)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('embedded and structured asset paths are collected and rewritten', () => {
    const value = {
        image: 'assets/a.png',
        css: 'x{background:url(\x22assets/b.webp\x22)}',
        remote: 'https://example.test/assets/no.png',
    }
    assert.deepEqual(collectAssetPaths(value), ['assets/a.png', 'assets/b.webp'])
    const changes = rewriteAssetPathsInPlace(value, new Map([
        ['assets/a.png', `external://main-assets/${'a'.repeat(64)}`],
        ['assets/b.webp', `external://main-assets/${'b'.repeat(64)}`],
    ]))
    assert.equal(changes, 2)
    assert.match(value.image, /^external:\/\/main-assets\//)
    assert.match(value.css, /external:\/\/main-assets\//)
    assert.equal(value.remote, 'https://example.test/assets/no.png')
})

test('missing imported assets are marked and collected in top folders', () => {
    let nextId = 0
    const target = {
        characters: [],
        characterOrder: [],
        modules: [],
        moduleFolders: [],
        personas: [],
    }
    const source = prepareSourceDatabase({
        characters: [
            { chaId: 'broken-char', name: 'Broken', image: 'assets/missing.png', chats: [] },
            { chaId: 'safe-char', name: 'Safe', image: 'assets/safe.png', chats: [] },
        ],
        characterOrder: ['broken-char', 'safe-char'],
        modules: [{ id: 'broken-module', name: 'Broken module', assets: [['x', 'assets/missing-module.png']] }],
        moduleFolders: [],
        personas: [],
    })
    const health = buildImportAssetHealth(source, ['assets/missing.png', 'assets/missing-module.png'])
    const merge = mergeSourceCollections(target, source, {
        sourceLabel: '모바일웹리스',
        importId: 'import-broken',
        collectionId: 'collection-broken',
        importedAt: 123,
        assetHealth: health,
        createId: () => `new-${++nextId}`,
    })
    const organized = organizeImportedMissingAssetFolders(target, merge, health, {
        sourceLabel: '모바일웹리스',
        importId: 'import-broken',
        collectionId: 'collection-broken',
        importedAt: 123,
    })

    assert.deepEqual(organized, { characters: 1, modules: 1 })
    assert.equal(target.characters[0].sourceInfo.missingAssetCount, 1)
    assert.equal(target.characters[1].sourceInfo.missingAssetCount, 0)
    assert.equal(target.characterOrder[0].name, '[에셋 누락] 모바일웹리스')
    assert.deepEqual(target.characterOrder[0].data, [merge.characterIds[0]])
    assert.equal(target.moduleFolders[0].name, '[에셋 누락] 모바일웹리스')
    assert.deepEqual(target.moduleFolders[0].moduleIds, [merge.moduleIds[0]])
})

test('source preparation drops chats but keeps duplicate entities', () => {
    const source = prepareSourceDatabase({
        characters: [
            { chaId: 'a', name: 'Same', chats: [{ secret: true }] },
            { chaId: 'b', name: 'Same', chats: [{ secret: true }] },
        ],
        modules: [{ id: 'm', name: 'Module' }],
        personas: [{ id: 'p', name: 'Persona' }],
    })
    assert.equal(source.characters.length, 2)
    assert.equal(source.characters[0].chats.length, 0)
})

test('merge appends every duplicate with fresh ids and source folders', () => {
    let nextId = 0
    const target = {
        characters: [{ chaId: 'existing', name: 'Same' }],
        characterOrder: ['existing'],
        modules: [{ id: 'existing-module', name: 'Module' }],
        moduleFolders: [],
        personas: [{ id: 'existing-persona', name: 'Persona' }],
    }
    const source = prepareSourceDatabase({
        characters: [
            { chaId: 'a', name: 'Same', chats: [] },
            { chaId: 'b', name: 'Same', chats: [] },
        ],
        characterOrder: ['a', 'b'],
        modules: [{ id: 'm', name: 'Module' }],
        personas: [{ id: 'p', name: 'Persona' }],
    })
    const result = mergeSourceCollections(target, source, {
        sourceLabel: '로컬리스',
        importId: 'import-1',
        createId: () => `new-${++nextId}`,
    })
    assert.equal(target.characters.length, 3)
    assert.equal(target.characters.filter((value) => value.name === 'Same').length, 3)
    assert.equal(target.modules.length, 2)
    assert.equal(target.personas.length, 2)
    assert.equal(new Set(result.characterIds).size, 2)
    assert.equal(target.characterOrder[0].name, '[출처] 로컬리스')
    assert.equal(target.moduleFolders[0].name, '[출처] 로컬리스')
})
