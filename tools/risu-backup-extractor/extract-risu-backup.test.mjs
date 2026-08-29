import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { compressSync } from 'fflate'
import { pack } from 'msgpackr'
import {
    collectAssetPaths,
    decodeLegacyDatabase,
    extractBackup,
    findTrailingEntry,
    splitDatabase,
} from './extract-risu-backup.mjs'

function backupEntry(name, data) {
    const nameBytes = Buffer.from(name)
    const header = Buffer.alloc(8 + nameBytes.length)
    header.writeUInt32LE(nameBytes.length, 0)
    nameBytes.copy(header, 4)
    header.writeUInt32LE(data.length, 4 + nameBytes.length)
    return Buffer.concat([header, data])
}

function legacyDatabase(database) {
    return Buffer.concat([
        Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]),
        Buffer.from(compressSync(pack(database))),
    ])
}

test('asset collection accepts only flat internal asset paths', () => {
    assert.deepEqual(collectAssetPaths({
        image: 'assets/main.png',
        css: 'background:url(\x22assets/bg.webp\x22)',
        remote: 'https://example.test/assets/no.png',
        nested: 'assets/folder/no.png',
    }), ['assets/bg.webp', 'assets/main.png'])
})

test('legacy database decoding and splitting remove chats and source metadata', () => {
    const source = {
        characters: [{ chaId: 'c1', name: 'Bot', image: 'assets/c.png', chats: [{ secret: 'chat' }], sourceInfo: { old: true } }],
        modules: [{ id: 'm1', name: 'Module', assets: [['a', 'assets/m.png']] }],
        personas: [{ id: 'p1', name: 'Persona', icon: 'assets/p.png' }],
    }
    const decoded = decodeLegacyDatabase(legacyDatabase(source))
    const split = splitDatabase(decoded.database)
    assert.equal(split.characters[0].chats.length, 0)
    assert.equal(split.characters[0].sourceInfo, undefined)
    assert.equal(split.modules.length, 1)
    assert.equal(split.personas.length, 1)
})

test('official backup is split into independent item directories and manifests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-backup-extractor-'))
    const input = path.join(root, 'Binary.bin')
    const output = path.join(root, 'output')
    const database = {
        characters: [{ chaId: 'c1', name: 'Bot', image: 'assets/c.png', chats: [{ message: 'excluded' }] }],
        characterOrder: ['c1'],
        modules: [{ id: 'm1', name: 'Module', assets: [['a', 'assets/m.png']] }],
        moduleFolders: [{ id: 'f1', name: 'Folder', data: ['m1'] }],
        personas: [{ id: 'p1', name: 'Persona', icon: 'assets/p.png' }],
    }
    fs.writeFileSync(input, Buffer.concat([
        backupEntry('c.png', Buffer.from([1, 2, 3])),
        backupEntry('m.png', Buffer.from([4, 5])),
        backupEntry('p.png', Buffer.from([6])),
        backupEntry('database.risudat', legacyDatabase(database)),
    ]))

    const entry = findTrailingEntry(input)
    assert.equal(entry.endOffset, fs.statSync(input).size)
    const result = extractBackup({ inputPath: input, outputPath: output, sourceLabel: '테스트 웹리스' })
    assert.equal(result.summary.collections.characters.itemCount, 1)
    assert.equal(result.summary.collections.modules.assetReferenceCount, 1)
    assert.equal(result.summary.collections.personas.itemCount, 1)
    assert.equal(fs.existsSync(path.join(output, 'characters', 'manifest.json')), true)
    const characterFile = fs.readdirSync(path.join(output, 'characters', 'items'))[0]
    const character = JSON.parse(fs.readFileSync(path.join(output, 'characters', 'items', characterFile), 'utf8'))
    assert.equal(character.chats.length, 0)
    assert.equal(JSON.stringify(character).includes('excluded'), false)
})
