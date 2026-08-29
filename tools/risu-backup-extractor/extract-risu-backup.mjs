#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { decompressSync } from 'fflate'
import { unpack } from 'msgpackr'

const LEGACY_PREFIX = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0])
const DATABASE_ENTRY = 'database.risudat'
const FORMAT = 'pocketrisu-offline-source-collection'
const FORMAT_VERSION = 1
const BACKWARD_CHUNK_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_SEARCH_BYTES = 4 * 1024 * 1024 * 1024
const embeddedAssetPattern = /(^|[^a-zA-Z0-9_/])assets\/[^\s\x22\x27\x60()<>\\{}\[\],;]+/g

function readExact(fd, length, position) {
    const output = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
        const count = fs.readSync(fd, output, offset, length - offset, position + offset)
        if (count === 0) throw new Error(`Unexpected end of file at byte ${position + offset}`)
        offset += count
    }
    return output
}

function readUint32LE(fd, position) {
    return readExact(fd, 4, position).readUInt32LE(0)
}

export function findTrailingEntry(inputPath, entryName = DATABASE_ENTRY, options = {}) {
    const resolved = path.resolve(inputPath)
    const fd = fs.openSync(resolved, 'r')
    const fileSize = fs.fstatSync(fd).size
    const needle = Buffer.from(entryName, 'utf8')
    const overlap = needle.length + 8
    const chunkBytes = Math.max(1024, options.chunkBytes ?? BACKWARD_CHUNK_BYTES)
    const maxSearchBytes = Math.min(fileSize, options.maxSearchBytes ?? DEFAULT_MAX_SEARCH_BYTES)
    let end = fileSize
    let searched = 0

    try {
        while (end > 0 && searched < maxSearchBytes) {
            const length = Math.min(chunkBytes, end, maxSearchBytes - searched + overlap)
            const start = end - length
            const chunk = readExact(fd, length, start)
            let index = chunk.lastIndexOf(needle)
            while (index >= 0) {
                const nameOffset = start + index
                if (nameOffset >= 4) {
                    const nameLength = readUint32LE(fd, nameOffset - 4)
                    const sizeOffset = nameOffset + needle.length
                    const dataLength = readUint32LE(fd, sizeOffset)
                    const dataOffset = sizeOffset + 4
                    if (nameLength === needle.length && dataOffset + dataLength === fileSize) {
                        return {
                            inputPath: resolved,
                            fileSize,
                            headerOffset: nameOffset - 4,
                            nameOffset,
                            dataOffset,
                            dataLength,
                            endOffset: fileSize,
                        }
                    }
                }
                index = chunk.lastIndexOf(needle, index - 1)
            }
            if (start === 0) break
            const nextEnd = start + overlap
            searched += end - nextEnd
            end = nextEnd
        }
    } finally {
        fs.closeSync(fd)
    }
    throw new Error(`${entryName} was not found within the last ${maxSearchBytes} bytes`)
}

export function decodeLegacyDatabase(entryBytes) {
    const bytes = Buffer.from(entryBytes)
    if (bytes.length < LEGACY_PREFIX.length + 1 || !bytes.subarray(0, LEGACY_PREFIX.length).equals(LEGACY_PREFIX)) {
        throw new Error('The backup database is encrypted or uses an unsupported format')
    }
    const version = bytes[LEGACY_PREFIX.length]
    const payload = bytes.subarray(LEGACY_PREFIX.length + 1)
    if (version === 7) return { database: unpack(payload), version, decompressedBytes: payload.length }
    if (version === 8 || version === 9) {
        const decompressed = decompressSync(payload)
        return { database: unpack(decompressed), version, decompressedBytes: decompressed.length }
    }
    throw new Error(`Unsupported RisuSave version: ${version}`)
}

function isSafeAssetPath(value) {
    if (typeof value !== 'string' || !value.startsWith('assets/') || value.length > 512) return false
    const name = value.slice('assets/'.length)
    return Boolean(name) && name !== '.' && name !== '..' && !/[\/\\\u0000-\u001f\u007f]/.test(name)
}

export function collectAssetPaths(value) {
    const output = new Set()
    const seen = new WeakSet()
    const stack = [value]
    while (stack.length > 0) {
        const item = stack.pop()
        if (typeof item === 'string') {
            if (isSafeAssetPath(item)) output.add(item)
            embeddedAssetPattern.lastIndex = 0
            for (const match of item.matchAll(embeddedAssetPattern)) {
                const token = match[0].slice((match[1] || '').length)
                if (isSafeAssetPath(token)) output.add(token)
            }
            continue
        }
        if (!item || typeof item !== 'object' || ArrayBuffer.isView(item) || item instanceof ArrayBuffer || seen.has(item)) continue
        seen.add(item)
        if (Array.isArray(item)) stack.push(...item)
        else stack.push(...Object.values(item))
    }
    return [...output].sort((left, right) => left.localeCompare(right))
}

function sanitizeCharacter(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    if (input.type === 'group' || input.chaId === '§temp' || input.chaId === '§playground') return null
    const {
        chats: _chats,
        chatFolders: _chatFolders,
        coldstorage: _coldstorage,
        coldStoragedChats: _coldStoragedChats,
        sourceInfo: _sourceInfo,
        ...character
    } = input
    character.chats = []
    character.chatFolders = []
    character.chatPage = 0
    if (character.oaiTTSConfig && typeof character.oaiTTSConfig === 'object') {
        character.oaiTTSConfig = { ...character.oaiTTSConfig }
        delete character.oaiTTSConfig.apiKey
    }
    return character
}

function sanitizeEntity(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const entity = { ...input }
    delete entity.sourceInfo
    return entity
}

export function splitDatabase(database) {
    const characters = (Array.isArray(database?.characters) ? database.characters : [])
        .map(sanitizeCharacter)
        .filter(Boolean)
    const modules = (Array.isArray(database?.modules) ? database.modules : [])
        .map(sanitizeEntity)
        .filter(Boolean)
    const personas = (Array.isArray(database?.personas) ? database.personas : [])
        .map(sanitizeEntity)
        .filter(Boolean)
    return { characters, modules, personas }
}

function safeFilePart(value, fallback) {
    const result = String(value ?? '')
        .normalize('NFKC')
        .replace(/[<>:\x22/\\|?*\u0000-\u001f]/g, '_')
        .replace(/[. ]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 64)
    return result || fallback
}

function entityFileName(entity, index) {
    const number = String(index + 1).padStart(4, '0')
    const id = safeFilePart(entity?.chaId ?? entity?.id ?? entity?.personaId ?? '', 'no-id').slice(0, 18)
    const name = safeFilePart(entity?.name, 'unnamed')
    return `${number}-${id}-${name}.json`
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeKind(tempRoot, kind, entities, context, layout) {
    const kindRoot = path.join(tempRoot, kind)
    const itemsRoot = path.join(kindRoot, 'items')
    fs.mkdirSync(itemsRoot, { recursive: true })
    const items = []
    let entityBytes = 0

    for (let index = 0; index < entities.length; index++) {
        const entity = entities[index]
        const file = entityFileName(entity, index)
        const encoded = `${JSON.stringify(entity)}\n`
        fs.writeFileSync(path.join(itemsRoot, file), encoded, 'utf8')
        entityBytes += Buffer.byteLength(encoded)
        items.push({
            file: `items/${file}`,
            id: entity?.chaId ?? entity?.id ?? entity?.personaId ?? null,
            name: typeof entity?.name === 'string' ? entity.name : '',
        })
    }

    const assetReferences = collectAssetPaths([entities, layout])
    if (layout !== undefined) writeJson(path.join(kindRoot, 'layout.json'), layout)
    writeJson(path.join(kindRoot, 'manifest.json'), {
        format: FORMAT,
        version: FORMAT_VERSION,
        kind,
        sourceLabel: context.sourceLabel,
        sourceId: context.sourceId,
        createdAt: context.createdAt,
        databaseSha256: context.databaseSha256,
        itemCount: entities.length,
        entityBytes,
        assetReferenceCount: assetReferences.length,
        assetReferences,
        assetState: 'not-indexed',
        items,
    })
    return { itemCount: entities.length, entityBytes, assetReferenceCount: assetReferences.length }
}

export function extractBackup(options) {
    const inputPath = path.resolve(options.inputPath)
    const outputPath = path.resolve(options.outputPath)
    const sourceLabel = String(options.sourceLabel || path.basename(inputPath, path.extname(inputPath))).trim() || 'Risu backup'
    if (!fs.statSync(inputPath).isFile()) throw new Error('Input path is not a file')
    if (fs.existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`)

    const entry = findTrailingEntry(inputPath, DATABASE_ENTRY, { maxSearchBytes: options.maxSearchBytes })
    const fd = fs.openSync(inputPath, 'r')
    let entryBytes
    try {
        entryBytes = readExact(fd, entry.dataLength, entry.dataOffset)
    } finally {
        fs.closeSync(fd)
    }
    const databaseSha256 = createHash('sha256').update(entryBytes).digest('hex')
    const decoded = decodeLegacyDatabase(entryBytes)
    const collections = splitDatabase(decoded.database)
    const createdAt = new Date().toISOString()
    const sourceId = databaseSha256.slice(0, 24)
    const tempPath = `${outputPath}.partial-${process.pid}`
    if (fs.existsSync(tempPath)) throw new Error(`Temporary output already exists: ${tempPath}`)
    fs.mkdirSync(tempPath, { recursive: true })

    const context = { sourceLabel, sourceId, createdAt, databaseSha256 }
    try {
        const characters = writeKind(tempPath, 'characters', collections.characters, context, decoded.database.characterOrder ?? [])
        const modules = writeKind(tempPath, 'modules', collections.modules, context, decoded.database.moduleFolders ?? [])
        const personas = writeKind(tempPath, 'personas', collections.personas, context)
        const summary = {
            format: FORMAT,
            version: FORMAT_VERSION,
            mode: 'metadata-and-asset-references',
            sourceLabel,
            sourceId,
            createdAt,
            input: {
                path: inputPath,
                bytes: entry.fileSize,
                modifiedAt: fs.statSync(inputPath).mtime.toISOString(),
            },
            database: {
                entryOffset: entry.dataOffset,
                compressedBytes: entry.dataLength,
                decompressedBytes: decoded.decompressedBytes,
                risuSaveVersion: decoded.version,
                sha256: databaseSha256,
            },
            collections: { characters, modules, personas },
            note: 'Original asset bytes remain in the source .bin. No source data was modified.',
        }
        writeJson(path.join(tempPath, 'summary.json'), summary)
        fs.renameSync(tempPath, outputPath)
        return { outputPath, summary }
    } catch (error) {
        error.message += ` (partial output kept at ${tempPath})`
        throw error
    }
}

function parseArgs(argv) {
    const result = {}
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]
        if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
        const key = arg.slice(2)
        const value = argv[index + 1]
        if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
        result[key] = value
        index++
    }
    if (!result.input) throw new Error('--input is required')
    if (!result.output) throw new Error('--output is required')
    return {
        inputPath: result.input,
        outputPath: result.output,
        sourceLabel: result['source-label'],
        maxSearchBytes: result['max-search-gb'] ? Number(result['max-search-gb']) * 1024 ** 3 : undefined,
    }
}

async function main() {
    try {
        const options = parseArgs(process.argv.slice(2))
        console.log('Risu backup database를 찾는 중…')
        const result = extractBackup(options)
        console.log(JSON.stringify({ outputPath: result.outputPath, ...result.summary.collections }, null, 2))
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await main()
}
