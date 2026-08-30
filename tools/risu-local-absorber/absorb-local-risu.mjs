#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { decodeLegacyDatabase, findTrailingEntry } from '../risu-backup-extractor/extract-risu-backup.mjs'

const DB_KEY = 'database/database.bin'
const FORMAT_VERSION = 1
const embeddedAssetPattern = /(^|[^a-zA-Z0-9_/])(assets\/[^\s\x22\x27\x60()<>\\{}\[\],;]+)/g

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
                if (isSafeAssetPath(match[2])) output.add(match[2])
            }
            continue
        }
        if (!item || typeof item !== 'object' || seen.has(item) || Buffer.isBuffer(item) || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) continue
        seen.add(item)
        if (Array.isArray(item)) stack.push(...item)
        else stack.push(...Object.values(item))
    }
    return [...output].sort((left, right) => left.localeCompare(right))
}

export function rewriteAssetPathsInPlace(value, mapping) {
    const seen = new WeakSet()
    let changes = 0
    const rewriteString = (input) => {
        if (isSafeAssetPath(input) && mapping.has(input)) {
            changes++
            return mapping.get(input)
        }
        embeddedAssetPattern.lastIndex = 0
        return input.replace(embeddedAssetPattern, (whole, prefix, token) => {
            if (!isSafeAssetPath(token) || !mapping.has(token)) return whole
            changes++
            return `${prefix}${mapping.get(token)}`
        })
    }
    const visit = (current) => {
        if (!current || typeof current !== 'object' || seen.has(current) || Buffer.isBuffer(current) || ArrayBuffer.isView(current) || current instanceof ArrayBuffer) return
        seen.add(current)
        for (const key of Object.keys(current)) {
            const child = current[key]
            if (typeof child === 'string') current[key] = rewriteString(child)
            else visit(child)
        }
    }
    visit(value)
    return changes
}

function stripSourceCharacter(character) {
    if (!character || typeof character !== 'object' || Array.isArray(character)) return null
    if (character.type === 'group' || character.chaId === '§temp' || character.chaId === '§playground') return null
    const {
        chats: _chats,
        chatFolders: _chatFolders,
        coldstorage: _coldstorage,
        coldStoragedChats: _coldStoragedChats,
        sourceInfo: _sourceInfo,
        ...copy
    } = character
    copy.chats = []
    copy.chatFolders = []
    copy.chatPage = 0
    copy.type = 'character'
    if (copy.oaiTTSConfig && typeof copy.oaiTTSConfig === 'object') {
        copy.oaiTTSConfig = { ...copy.oaiTTSConfig }
        delete copy.oaiTTSConfig.apiKey
    }
    return copy
}

function stripSourceEntity(entity) {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return null
    const copy = { ...entity }
    delete copy.sourceInfo
    return copy
}

export function prepareSourceDatabase(database) {
    return {
        characters: (Array.isArray(database?.characters) ? database.characters : []).map(stripSourceCharacter).filter(Boolean),
        characterOrder: Array.isArray(database?.characterOrder) ? database.characterOrder : [],
        modules: (Array.isArray(database?.modules) ? database.modules : []).map(stripSourceEntity).filter(Boolean),
        moduleFolders: Array.isArray(database?.moduleFolders) ? database.moduleFolders : [],
        personas: (Array.isArray(database?.personas) ? database.personas : []).map(stripSourceEntity).filter(Boolean),
        enabledModules: Array.isArray(database?.enabledModules) ? database.enabledModules : [],
    }
}

function uniqueId(usedIds, createId) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const value = createId()
        if (typeof value !== 'string' || !value || usedIds.has(value)) continue
        usedIds.add(value)
        return value
    }
    throw new Error('Could not allocate a unique import id')
}

function uniqueFolderName(existingNames, desired) {
    if (!existingNames.has(desired)) {
        existingNames.add(desired)
        return desired
    }
    for (let suffix = 2; suffix < 10_000; suffix++) {
        const candidate = `${desired} (${suffix})`
        if (!existingNames.has(candidate)) {
            existingNames.add(candidate)
            return candidate
        }
    }
    throw new Error(`Could not allocate a unique folder name for ${desired}`)
}

export function mergeSourceCollections(target, source, options = {}) {
    const createId = options.createId ?? randomUUID
    const importedAt = options.importedAt ?? Date.now()
    const sourceLabel = String(options.sourceLabel || '로컬리스').trim() || '로컬리스'
    const importId = options.importId || createId()
    const collectionId = options.collectionId || importId
    target.characters ??= []
    target.characterOrder ??= []
    target.modules ??= []
    target.personas ??= []
    target.moduleFolders ??= []

    const usedIds = new Set([
        ...target.characters.map((value) => value?.chaId),
        ...target.modules.map((value) => value?.id),
        ...target.personas.map((value) => value?.id),
        ...target.characterOrder.flatMap((value) => typeof value === 'string' ? [] : [value?.id]),
        ...target.moduleFolders.map((value) => value?.id),
    ].filter((value) => typeof value === 'string' && value))
    const baseInfo = { label: sourceLabel, bundleId: importId, collectionId, importedAt }

    const moduleIdMap = new Map()
    const importedModules = []
    for (let moduleIndex = 0; moduleIndex < source.modules.length; moduleIndex++) {
        const module = source.modules[moduleIndex]
        const originalId = module.id
        const id = uniqueId(usedIds, createId)
        if (typeof originalId === 'string' && originalId) moduleIdMap.set(originalId, id)
        importedModules.push({
            description: '',
            ...module,
            id,
            sourceInfo: {
                ...baseInfo,
                originalId: typeof originalId === 'string' ? originalId : null,
                ...(options.assetHealth?.modules?.[moduleIndex] ?? {}),
            },
        })
    }
    target.modules.push(...importedModules)
    const newModuleIds = importedModules.map((value) => value.id)
    target.moduleActivationHistory = [
        ...newModuleIds,
        ...(Array.isArray(target.moduleActivationHistory) ? target.moduleActivationHistory : []).filter((id) => !newModuleIds.includes(id)),
    ]

    const characterIdMap = new Map()
    const importedCharacters = []
    for (let characterIndex = 0; characterIndex < source.characters.length; characterIndex++) {
        const character = source.characters[characterIndex]
        const originalId = character.chaId
        const id = uniqueId(usedIds, createId)
        if (typeof originalId === 'string' && originalId) characterIdMap.set(originalId, id)
        const originalModuleIds = Array.isArray(character.modules)
            ? character.modules.filter((value) => typeof value === 'string')
            : []
        const modules = originalModuleIds.map((value) => moduleIdMap.get(value)).filter(Boolean)
        importedCharacters.push({
            ...character,
            type: 'character',
            chaId: id,
            chats: [],
            chatFolders: [],
            chatPage: 0,
            trashTime: undefined,
            ...(Object.hasOwn(character, 'modules') ? { modules } : {}),
            sourceInfo: {
                ...baseInfo,
                originalId,
                originalModuleIds,
                ...(options.assetHealth?.characters?.[characterIndex] ?? {}),
            },
        })
    }
    target.characters.push(...importedCharacters)

    const importedPersonas = source.personas.map((persona, personaIndex) => {
        const originalId = persona.id
        return {
            icon: '',
            personaPrompt: '',
            note: '',
            ...persona,
            id: uniqueId(usedIds, createId),
            sourceInfo: {
                ...baseInfo,
                originalId,
                ...(options.assetHealth?.personas?.[personaIndex] ?? {}),
            },
        }
    })
    target.personas.push(...importedPersonas)

    const characterFolderNames = new Set(target.characterOrder
        .filter((value) => value && typeof value === 'object')
        .map((value) => value.name))
    const importedCharacterFolders = []
    const assignedCharacters = new Set()
    const looseCharacterIds = []
    for (const entry of source.characterOrder) {
        if (typeof entry === 'string') {
            const mapped = characterIdMap.get(entry)
            if (mapped) {
                assignedCharacters.add(mapped)
                looseCharacterIds.push(mapped)
            }
            continue
        }
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.data)) continue
        const data = entry.data.map((value) => characterIdMap.get(value)).filter(Boolean)
        if (data.length === 0) continue
        for (const id of data) assignedCharacters.add(id)
        importedCharacterFolders.push({
            ...entry,
            id: uniqueId(usedIds, createId),
            name: uniqueFolderName(characterFolderNames, `[${sourceLabel}] ${entry.name || '폴더'}`),
            data,
            sourceInfo: { ...baseInfo, originalId: entry.id ?? null },
        })
    }
    for (const character of importedCharacters) {
        if (!assignedCharacters.has(character.chaId)) looseCharacterIds.push(character.chaId)
    }
    if (looseCharacterIds.length > 0) {
        importedCharacterFolders.unshift({
            id: uniqueId(usedIds, createId),
            name: uniqueFolderName(characterFolderNames, `[출처] ${sourceLabel}`),
            data: [...new Set(looseCharacterIds)],
            color: '',
            sourceInfo: { ...baseInfo },
        })
    }
    target.characterOrder.unshift(...importedCharacterFolders)

    const moduleFolderNames = new Set(target.moduleFolders.map((value) => value?.name))
    const assignedModules = new Set()
    const importedModuleFolders = []
    for (const folder of source.moduleFolders) {
        if (!folder || typeof folder !== 'object') continue
        const sourceIds = Array.isArray(folder.moduleIds) ? folder.moduleIds : Array.isArray(folder.data) ? folder.data : []
        const moduleIds = sourceIds.map((value) => moduleIdMap.get(value)).filter(Boolean)
        if (moduleIds.length === 0) continue
        for (const id of moduleIds) assignedModules.add(id)
        importedModuleFolders.push({
            id: uniqueId(usedIds, createId),
            name: uniqueFolderName(moduleFolderNames, `[${sourceLabel}] ${folder.name || '폴더'}`),
            moduleIds,
            collapsed: false,
            sourceInfo: { ...baseInfo, originalId: folder.id ?? null },
        })
    }
    const looseModuleIds = newModuleIds.filter((id) => !assignedModules.has(id))
    if (looseModuleIds.length > 0) {
        importedModuleFolders.unshift({
            id: uniqueId(usedIds, createId),
            name: uniqueFolderName(moduleFolderNames, `[출처] ${sourceLabel}`),
            moduleIds: looseModuleIds,
            collapsed: false,
            sourceInfo: { ...baseInfo },
        })
    }
    target.moduleFolders.unshift(...importedModuleFolders)

    return {
        importId,
        collectionId,
        characterIds: importedCharacters.map((value) => value.chaId),
        moduleIds: newModuleIds,
        personaIds: importedPersonas.map((value) => value.id),
        characterFolders: importedCharacterFolders.length,
        moduleFolders: importedModuleFolders.length,
    }
}

function assetHealthForEntities(entities, unresolved) {
    return entities.map((entity) => {
        const references = collectAssetPaths(entity)
        return {
            assetReferenceCount: references.length,
            missingAssetCount: references.filter((reference) => unresolved.has(reference)).length,
        }
    })
}

export function buildImportAssetHealth(source, unresolvedReferences) {
    const unresolved = new Set(unresolvedReferences)
    return {
        characters: assetHealthForEntities(source.characters, unresolved),
        modules: assetHealthForEntities(source.modules, unresolved),
        personas: assetHealthForEntities(source.personas, unresolved),
    }
}

export function organizeImportedMissingAssetFolders(target, merge, assetHealth, options = {}) {
    const missingCharacterIds = new Set(merge.characterIds.filter((_, index) => assetHealth.characters[index]?.missingAssetCount > 0))
    const missingModuleIds = new Set(merge.moduleIds.filter((_, index) => assetHealth.modules[index]?.missingAssetCount > 0))
    const sourceLabel = String(options.sourceLabel || '가져온 데이터').trim() || '가져온 데이터'
    const baseInfo = {
        label: sourceLabel,
        bundleId: options.importId || merge.importId,
        collectionId: options.collectionId || merge.collectionId,
        importedAt: options.importedAt ?? Date.now(),
    }

    if (missingCharacterIds.size > 0) {
        target.characterOrder = target.characterOrder.flatMap((entry) => {
            if (typeof entry === 'string') return missingCharacterIds.has(entry) ? [] : [entry]
            if (!entry || typeof entry !== 'object' || !Array.isArray(entry.data)) return [entry]
            const data = entry.data.filter((id) => !missingCharacterIds.has(id))
            if (data.length === 0 && entry.sourceInfo?.bundleId === baseInfo.bundleId) return []
            return [{ ...entry, data }]
        })
        const names = new Set(target.characterOrder.filter((entry) => entry && typeof entry === 'object').map((entry) => entry.name))
        target.characterOrder.unshift({
            id: randomUUID(),
            name: uniqueFolderName(names, `[에셋 누락] ${sourceLabel}`),
            data: [...missingCharacterIds],
            color: 'red',
            sourceInfo: {
                ...baseInfo,
                missingAssetCount: assetHealth.characters.reduce((sum, value) => sum + (value.missingAssetCount || 0), 0),
            },
        })
    }

    if (missingModuleIds.size > 0) {
        target.moduleFolders = target.moduleFolders.flatMap((folder) => {
            if (!folder || typeof folder !== 'object') return [folder]
            const moduleIds = (Array.isArray(folder.moduleIds) ? folder.moduleIds : []).filter((id) => !missingModuleIds.has(id))
            if (moduleIds.length === 0 && folder.sourceInfo?.bundleId === baseInfo.bundleId) return []
            return [{ ...folder, moduleIds }]
        })
        const names = new Set(target.moduleFolders.map((folder) => folder?.name))
        target.moduleFolders.unshift({
            id: randomUUID(),
            name: uniqueFolderName(names, `[에셋 누락] ${sourceLabel}`),
            moduleIds: [...missingModuleIds],
            collapsed: false,
            sourceInfo: {
                ...baseInfo,
                missingAssetCount: assetHealth.modules.reduce((sum, value) => sum + (value.missingAssetCount || 0), 0),
            },
        })
    }

    return {
        characters: missingCharacterIds.size,
        modules: missingModuleIds.size,
    }
}

function hashBuffer(value) {
    return createHash('sha256').update(value).digest('hex')
}

function hashFile(filePath) {
    const hash = createHash('sha256')
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
    let bytes = 0
    try {
        while (true) {
            const count = fs.readSync(fd, buffer, 0, buffer.length, null)
            if (count === 0) break
            bytes += count
            hash.update(buffer.subarray(0, count))
        }
    } finally {
        fs.closeSync(fd)
    }
    return { hash: hash.digest('hex'), size: bytes }
}

function readBackupDatabaseEntry(inputPath) {
    const entry = findTrailingEntry(inputPath)
    const fd = fs.openSync(inputPath, 'r')
    try {
        const bytes = Buffer.allocUnsafe(entry.dataLength)
        let offset = 0
        while (offset < bytes.length) {
            const count = fs.readSync(fd, bytes, offset, bytes.length - offset, entry.dataOffset + offset)
            if (count === 0) throw new Error(`Unexpected end of backup at byte ${entry.dataOffset + offset}`)
            offset += count
        }
        return { entry, bytes }
    } finally {
        fs.closeSync(fd)
    }
}

function externalFilePath(root, hash) {
    return path.join(root, hash.slice(0, 2), hash)
}

function listExternalHashes(root) {
    const hashes = new Set()
    if (!fs.existsSync(root)) return hashes
    for (const prefix of fs.readdirSync(root, { withFileTypes: true })) {
        if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/i.test(prefix.name)) continue
        const directory = path.join(root, prefix.name)
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isFile() && /^[a-f0-9]{64}$/i.test(entry.name)) hashes.add(entry.name.toLowerCase())
        }
    }
    return hashes
}

function processIsRunning(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return error?.code === 'EPERM'
    }
}

function acquireOfflineImportLock(targetRoot, details = {}) {
    const lockPath = path.join(targetRoot, 'save', '.offline-import.lock')
    const token = randomUUID()
    if (fs.existsSync(lockPath)) {
        let existing = null
        try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')) } catch { /* malformed means stale */ }
        if (processIsRunning(Number(existing?.pid))) {
            throw new Error(`PocketRisu offline import is already active as PID ${existing.pid}`)
        }
        fs.unlinkSync(lockPath)
    }
    fs.writeFileSync(lockPath, JSON.stringify({
        version: 1,
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        ...details,
    }, null, 2), { encoding: 'utf8', flag: 'wx' })
    return () => {
        try {
            const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
            if (current?.token === token) fs.unlinkSync(lockPath)
        } catch { /* another process already cleared or replaced it */ }
    }
}

function mimeFromBytes(bytes, originalPath) {
    if (bytes?.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (bytes?.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
    if (bytes?.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (bytes?.length >= 6 && bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
    const extension = path.extname(originalPath).toLowerCase()
    return extension === '.webm' ? 'video/webm' : 'application/octet-stream'
}

function readPrefix(filePath, length = 16) {
    const fd = fs.openSync(filePath, 'r')
    try {
        const buffer = Buffer.alloc(length)
        const count = fs.readSync(fd, buffer, 0, length, 0)
        return buffer.subarray(0, count)
    } finally {
        fs.closeSync(fd)
    }
}

function ensureExternalFileFromFile(sourcePath, externalRoot, hash, size, createdFiles) {
    const destination = externalFilePath(externalRoot, hash)
    if (fs.existsSync(destination)) {
        const info = fs.statSync(destination)
        if (!info.isFile() || info.size !== size) throw new Error(`External asset collision: ${destination}`)
        return destination
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`
    fs.copyFileSync(sourcePath, temp, fs.constants.COPYFILE_EXCL)
    const verification = hashFile(temp)
    if (verification.hash !== hash || verification.size !== size) throw new Error(`Copied asset verification failed: ${sourcePath}`)
    fs.renameSync(temp, destination)
    createdFiles.push(destination)
    return destination
}

function ensureExternalFileFromBuffer(value, externalRoot, hash, createdFiles) {
    const destination = externalFilePath(externalRoot, hash)
    if (fs.existsSync(destination)) {
        const info = fs.statSync(destination)
        if (!info.isFile() || info.size !== value.length) throw new Error(`External asset collision: ${destination}`)
        return destination
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`
    fs.writeFileSync(temp, value, { flag: 'wx' })
    if (hashFile(temp).hash !== hash) throw new Error(`Buffered asset verification failed: ${destination}`)
    fs.renameSync(temp, destination)
    createdFiles.push(destination)
    return destination
}

function resolveProviderRoot(targetRoot, config, providerId) {
    if (config?.enabled === false) throw new Error('External assets are disabled in the target PocketRisu')
    const provider = config?.providers?.[providerId]
    if (!provider || provider.type !== 'filesystem' || typeof provider.root !== 'string') {
        throw new Error(`Filesystem provider is not configured: ${providerId}`)
    }
    return path.isAbsolute(provider.root) ? path.resolve(provider.root) : path.resolve(targetRoot, provider.root)
}

function planAndCopyAssets(options) {
    const {
        references, sourceRoot, providerId, externalRoot, externalHashes, verifiedExternalEntries,
        kvGet, kvSize, targetAssetKeys,
        manifestStore, importId, execute, progress,
    } = options
    const mapping = new Map()
    const entriesByUri = new Map()
    const unresolved = []
    const createdFiles = []
    let sourceFiles = 0
    let recoveredFromExternal = 0
    let reusedVerifiedExternal = 0
    let recoveredFromTarget = 0
    let totalSourceBytes = 0

    for (let index = 0; index < references.length; index++) {
        const reference = references[index]
        if (index === 0 || (index + 1) % 500 === 0 || index === references.length - 1) progress?.(index + 1, references.length, reference)
        const sourcePath = path.join(sourceRoot, ...reference.split('/'))
        let hash
        let size
        let mimeType
        if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
            const result = hashFile(sourcePath)
            hash = result.hash
            size = result.size
            mimeType = mimeFromBytes(readPrefix(sourcePath), reference)
            sourceFiles++
            totalSourceBytes += size
            if (execute) ensureExternalFileFromFile(sourcePath, externalRoot, hash, size, createdFiles)
        } else {
            const expectedHash = /^assets\/([a-f0-9]{64})(?:\.[A-Za-z0-9._~-]+)?$/i.exec(reference)?.[1]?.toLowerCase()
            if (expectedHash) {
                const expectedPath = externalFilePath(externalRoot, expectedHash)
                const knownExternal = externalHashes?.has(expectedHash)
                if (knownExternal) {
                    const verifiedEntry = verifiedExternalEntries?.get(expectedHash)
                    const canReuseVerification = Boolean(
                        verifiedEntry
                        && verifiedEntry.providerId === providerId
                        && verifiedEntry.status === 'verified'
                        && verifiedEntry.hash === expectedHash
                        && Number.isSafeInteger(verifiedEntry.size)
                        && verifiedEntry.size >= 0
                    )
                    const verified = execute && !canReuseVerification
                        ? hashFile(expectedPath)
                        : { hash: expectedHash, size: canReuseVerification ? verifiedEntry.size : 0 }
                    if (!execute || verified.hash === expectedHash) {
                        hash = expectedHash
                        size = verified.size
                        mimeType = canReuseVerification
                            ? (verifiedEntry.mimeType || mimeFromBytes(null, reference))
                            : (execute ? mimeFromBytes(readPrefix(expectedPath), reference) : mimeFromBytes(null, reference))
                        recoveredFromExternal++
                        if (canReuseVerification) reusedVerifiedExternal++
                    }
                }
            }
            if (!hash && !expectedHash) {
                const existingManifest = manifestStore.findByInternalKeySync(reference)
                if (existingManifest?.uri) {
                    mapping.set(reference, existingManifest.uri)
                    continue
                }
            }
            if (!hash) {
                const mayExistInTarget = !targetAssetKeys || targetAssetKeys.has(reference)
                if (mayExistInTarget) {
                    if (!execute && expectedHash) {
                        const storedSize = kvSize(reference)
                        if (Number.isSafeInteger(storedSize) && storedSize >= 0) {
                            hash = expectedHash
                            size = storedSize
                            mimeType = mimeFromBytes(null, reference)
                            recoveredFromTarget++
                        }
                    } else {
                        const targetValue = kvGet(reference)
                        if (targetValue) {
                            const value = Buffer.from(targetValue)
                            hash = hashBuffer(value)
                            size = value.length
                            mimeType = mimeFromBytes(value.subarray(0, 16), reference)
                            if (execute) ensureExternalFileFromBuffer(value, externalRoot, hash, createdFiles)
                            recoveredFromTarget++
                        }
                    }
                }
            }
        }
        if (!hash) {
            unresolved.push(reference)
            continue
        }
        const uri = `external://${providerId}/${hash}`
        mapping.set(reference, uri)
        const old = verifiedExternalEntries?.get(hash) || manifestStore.getSync(uri) || {}
        const now = new Date().toISOString()
        entriesByUri.set(uri, {
            uri,
            value: {
                ...old,
                uri,
                providerId,
                hash,
                size,
                mimeType: mimeType || old.mimeType || 'application/octet-stream',
                assetName: old.assetName || path.basename(reference),
                status: 'verified',
                createdAt: old.createdAt || now,
                lastVerifiedAt: now,
                migrationIds: [...new Set([...(Array.isArray(old.migrationIds) ? old.migrationIds : []), importId])],
            },
        })
    }
    return {
        mapping,
        manifestValues: [...entriesByUri.values()],
        unresolved,
        createdFiles,
        sourceFiles,
        recoveredFromExternal,
        reusedVerifiedExternal,
        recoveredFromTarget,
        totalSourceBytes,
    }
}

function parseArgs(argv) {
    const values = { execute: false }
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]
        if (arg === '--execute') {
            values.execute = true
            continue
        }
        if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
        const key = arg.slice(2)
        const value = argv[++index]
        if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
        values[key] = value
    }
    if (Boolean(values['source-root']) === Boolean(values['source-backup'])) {
        throw new Error('Specify exactly one of --source-root or --source-backup')
    }
    if (!values['target-root']) throw new Error('--target-root is required')
    return {
        sourceRoot: values['source-root'] ? path.resolve(values['source-root']) : null,
        sourceBackup: values['source-backup'] ? path.resolve(values['source-backup']) : null,
        targetRoot: path.resolve(values['target-root']),
        sourceLabel: values['source-label'] || (values['source-backup'] ? '백업리스' : '로컬리스'),
        providerId: values['provider-id'],
        execute: values.execute,
    }
}

export async function absorbLocalRisu(options) {
    const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : null
    const sourceBackup = options.sourceBackup ? path.resolve(options.sourceBackup) : null
    if (Boolean(sourceRoot) === Boolean(sourceBackup)) {
        throw new Error('Specify exactly one sourceRoot or sourceBackup')
    }
    const targetRoot = path.resolve(options.targetRoot)
    const sourceDbPath = sourceRoot ? path.join(sourceRoot, 'database', 'database.bin') : sourceBackup
    const targetDbPath = path.join(targetRoot, 'save', 'risuai.db')
    if (!fs.statSync(sourceDbPath).isFile()) throw new Error(`Source database not found: ${sourceDbPath}`)
    if (!fs.statSync(targetDbPath).isFile()) throw new Error(`Target database not found: ${targetDbPath}`)

    const backupEntry = sourceBackup ? readBackupDatabaseEntry(sourceBackup) : null
    const sourceBytes = backupEntry?.bytes ?? fs.readFileSync(sourceDbPath)
    const sourceDatabaseHash = hashBuffer(sourceBytes)
    const importId = `${sourceBackup ? 'backup' : 'local'}-${sourceDatabaseHash.slice(0, 16)}-${Date.now().toString(36)}`
    const originalCwd = process.cwd()
    let releaseOfflineImportLock = () => {}
    let dbApi = null
    try {
        if (options.execute) {
            releaseOfflineImportLock = acquireOfflineImportLock(targetRoot, {
                importId,
                sourceDatabaseHash,
                sourceKind: sourceBackup ? 'backup' : 'local',
            })
        }
        process.chdir(targetRoot)
        const targetRequire = createRequire(path.join(targetRoot, 'package.json'))
        dbApi = targetRequire('./server/node/db.cjs')
        const { decodeRisuSave, encodeRisuSaveLegacy } = targetRequire('./server/node/utils.cjs')
        const { createSqliteManifestStore } = targetRequire('./server/node/external-asset-manifest-store.cjs')
        const manifestStore = createSqliteManifestStore({ db: dbApi.db })

        const hasRunTable = Boolean(dbApi.db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_absorb_runs'",
        ).get())
        const previous = hasRunTable
            ? dbApi.db.prepare('SELECT import_id, created_at, receipt_json FROM local_absorb_runs WHERE source_hash = ?').get(sourceDatabaseHash)
            : null
        if (previous) {
            const currentRaw = dbApi.kvGet(DB_KEY)
            const currentDb = currentRaw ? await decodeRisuSave(currentRaw) : null
            const retained = {
                characters: (currentDb?.characters ?? []).filter((value) => value?.sourceInfo?.bundleId === previous.import_id).length,
                modules: (currentDb?.modules ?? []).filter((value) => value?.sourceInfo?.bundleId === previous.import_id).length,
                personas: (currentDb?.personas ?? []).filter((value) => value?.sourceInfo?.bundleId === previous.import_id).length,
            }
            const retainedTotal = retained.characters + retained.modules + retained.personas
            if (retainedTotal > 0) {
                throw new Error(
                    `This exact source was already absorbed as ${previous.import_id} at ${previous.created_at}: ${JSON.stringify(retained)}`,
                )
            }
            // A stale browser/server can overwrite the just-published DB while
            // leaving the transaction journal intact. No imported provenance
            // remains in the live DB, so it is safe to re-apply the source.
        }
        if (options.execute && !hasRunTable) {
            dbApi.db.exec(`
                CREATE TABLE local_absorb_runs (
                    source_hash TEXT PRIMARY KEY,
                    import_id TEXT NOT NULL,
                    source_label TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    receipt_json TEXT NOT NULL
                )
            `)
        }

        const readSourceRemote = async (name) => {
            if (!sourceRoot) return null
            const remotePath = path.join(sourceRoot, 'remotes', `${name}.local.bin`)
            return fs.existsSync(remotePath) ? fs.readFileSync(remotePath) : null
        }
        const sourceDecoded = sourceBackup
            ? decodeLegacyDatabase(sourceBytes).database
            : await decodeRisuSave(sourceBytes, { resolveRemote: readSourceRemote })
        const source = prepareSourceDatabase(sourceDecoded)
        const sourceGraph = {
            characters: source.characters,
            characterOrder: source.characterOrder,
            modules: source.modules,
            moduleFolders: source.moduleFolders,
            personas: source.personas,
        }
        const references = collectAssetPaths(sourceGraph)

        const configPath = path.join(targetRoot, 'save', 'external-assets', 'config.json')
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        const providerId = options.providerId || config.activeProvider
        const externalRoot = resolveProviderRoot(targetRoot, config, providerId)
        const targetAssetKeys = new Set(dbApi.kvList('assets/'))
        const externalHashes = listExternalHashes(externalRoot)
        const verifiedExternalEntries = new Map(
            manifestStore.listSync()
                .filter((entry) => entry?.providerId === providerId && typeof entry?.hash === 'string')
                .map((entry) => [entry.hash, entry]),
        )
        const assetPlan = planAndCopyAssets({
            references,
            sourceRoot: sourceRoot ?? path.dirname(sourceBackup),
            providerId,
            externalRoot,
            externalHashes,
            verifiedExternalEntries,
            kvGet: dbApi.kvGet,
            kvSize: dbApi.kvSize,
            targetAssetKeys,
            manifestStore,
            importId,
            execute: options.execute,
            progress: options.progress,
        })
        const assetHealth = buildImportAssetHealth(source, assetPlan.unresolved)
        const missingEntities = {
            characters: assetHealth.characters.filter((value) => value.missingAssetCount > 0).length,
            modules: assetHealth.modules.filter((value) => value.missingAssetCount > 0).length,
            personas: assetHealth.personas.filter((value) => value.missingAssetCount > 0).length,
        }
        if (!options.execute) {
            return {
                mode: 'dry-run',
                sourceDatabaseHash,
                source: { characters: source.characters.length, modules: source.modules.length, personas: source.personas.length },
                assetPlan: {
                    references: references.length,
                    sourceFiles: assetPlan.sourceFiles,
                    recoveredFromExternal: assetPlan.recoveredFromExternal,
                    reusedVerifiedExternal: assetPlan.reusedVerifiedExternal,
                    recoveredFromTarget: assetPlan.recoveredFromTarget,
                    unresolved: assetPlan.unresolved.length,
                    bytes: assetPlan.totalSourceBytes,
                    missingEntities,
                },
                targetRoot,
                externalRoot,
                sourceKind: sourceBackup ? 'backup' : 'local',
            }
        }

        const rewritten = rewriteAssetPathsInPlace(sourceGraph, assetPlan.mapping)
        const targetRaw = dbApi.kvGet(DB_KEY)
        if (!targetRaw) throw new Error('PocketRisu database/database.bin is missing')
        const targetDecoded = await decodeRisuSave(targetRaw, {
            resolveRemote: async (name) => dbApi.kvGet(`remotes/${name}.local.bin`),
        })
        const before = {
            characters: targetDecoded.characters?.length ?? 0,
            modules: targetDecoded.modules?.length ?? 0,
            personas: targetDecoded.personas?.length ?? 0,
        }
        const mergeImportedAt = Date.now()
        const collectionId = sourceDatabaseHash.slice(0, 24)
        const merge = mergeSourceCollections(targetDecoded, source, {
            sourceLabel: options.sourceLabel,
            importId,
            collectionId,
            importedAt: mergeImportedAt,
            assetHealth,
        })
        const missingFolders = organizeImportedMissingAssetFolders(targetDecoded, merge, assetHealth, {
            sourceLabel: options.sourceLabel,
            importId,
            collectionId,
            importedAt: mergeImportedAt,
        })
        const expected = {
            characters: before.characters + source.characters.length,
            modules: before.modules + source.modules.length,
            personas: before.personas + source.personas.length,
        }
        const encoded = Buffer.from(encodeRisuSaveLegacy(targetDecoded))
        const decodedCheck = await decodeRisuSave(encoded)
        const actual = {
            characters: decodedCheck.characters?.length ?? 0,
            modules: decodedCheck.modules?.length ?? 0,
            personas: decodedCheck.personas?.length ?? 0,
        }
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`Pre-publish count verification failed: ${JSON.stringify({ expected, actual })}`)
        }
        const importedCharacters = decodedCheck.characters.filter((value) => value?.sourceInfo?.bundleId === importId).length
        const importedModules = decodedCheck.modules.filter((value) => value?.sourceInfo?.bundleId === importId).length
        const importedPersonas = decodedCheck.personas.filter((value) => value?.sourceInfo?.bundleId === importId).length
        if (importedCharacters !== source.characters.length || importedModules !== source.modules.length || importedPersonas !== source.personas.length) {
            throw new Error('Pre-publish provenance verification failed')
        }

        const timestamp = Date.now()
        const snapshotKey = `migration-backup/pre-local-absorb-${timestamp}.bin`
        const manifestBackupKey = `migration-backup/pre-local-absorb-manifest-${timestamp}.json`
        const createdAt = new Date().toISOString()
        const receipt = {
            version: FORMAT_VERSION,
            importId,
            sourceLabel: options.sourceLabel,
            sourceDatabaseHash,
            sourceRoot,
            sourceBackup,
            sourceKind: sourceBackup ? 'backup' : 'local',
            targetRoot,
            externalRoot,
            createdAt,
            before,
            expected,
            source: { characters: source.characters.length, modules: source.modules.length, personas: source.personas.length },
            assets: {
                references: references.length,
                mapped: assetPlan.mapping.size,
                unresolved: assetPlan.unresolved,
                sourceFiles: assetPlan.sourceFiles,
                recoveredFromExternal: assetPlan.recoveredFromExternal,
                reusedVerifiedExternal: assetPlan.reusedVerifiedExternal,
                recoveredFromTarget: assetPlan.recoveredFromTarget,
                totalSourceBytes: assetPlan.totalSourceBytes,
                createdExternalFiles: assetPlan.createdFiles.length,
                rewrittenOccurrences: rewritten,
                missingEntities,
            },
            merge: {
                characters: merge.characterIds.length,
                modules: merge.moduleIds.length,
                personas: merge.personaIds.length,
                characterFolders: merge.characterFolders,
                moduleFolders: merge.moduleFolders,
                missingFolders,
            },
            snapshotKey,
            manifestBackupKey,
        }
        const manifestBackup = manifestStore.exportBufferSync()
        dbApi.db.transaction(() => {
            dbApi.kvCopyValue(DB_KEY, snapshotKey)
            dbApi.kvSet(manifestBackupKey, manifestBackup)
            dbApi.kvSet(DB_KEY, encoded)
            manifestStore.upsertManyValuesSync(assetPlan.manifestValues, { returnEntries: false })
            dbApi.db.prepare(`
                INSERT INTO local_absorb_runs (source_hash, import_id, source_label, created_at, receipt_json)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(source_hash) DO UPDATE SET
                    import_id = excluded.import_id,
                    source_label = excluded.source_label,
                    created_at = excluded.created_at,
                    receipt_json = excluded.receipt_json
            `).run(sourceDatabaseHash, importId, options.sourceLabel, createdAt, JSON.stringify(receipt))
        })()
        dbApi.checkpointWal('TRUNCATE')

        const finalDecoded = await decodeRisuSave(dbApi.kvGet(DB_KEY))
        const finalCounts = {
            characters: finalDecoded.characters?.length ?? 0,
            modules: finalDecoded.modules?.length ?? 0,
            personas: finalDecoded.personas?.length ?? 0,
        }
        if (JSON.stringify(finalCounts) !== JSON.stringify(expected)) {
            dbApi.db.transaction(() => {
                dbApi.kvCopyValue(snapshotKey, DB_KEY)
                manifestStore.replaceManifestSync(JSON.parse(manifestBackup.toString('utf8')))
                dbApi.db.prepare('DELETE FROM local_absorb_runs WHERE source_hash = ?').run(sourceDatabaseHash)
            })()
            throw new Error(`Post-publish verification failed; database snapshot was restored: ${JSON.stringify(finalCounts)}`)
        }

        const journalRoot = path.join(targetRoot, 'backups', 'migration-journals')
        fs.mkdirSync(journalRoot, { recursive: true })
        const journalPath = path.join(journalRoot, `${importId}.json`)
        fs.writeFileSync(journalPath, `${JSON.stringify({ ...receipt, finalCounts }, null, 2)}\n`, 'utf8')
        return { mode: 'executed', ...receipt, finalCounts, journalPath }
    } finally {
        dbApi?.db?.close()
        process.chdir(originalCwd)
        releaseOfflineImportLock()
    }
}

async function main() {
    try {
        const options = parseArgs(process.argv.slice(2))
        const result = await absorbLocalRisu({
            ...options,
            progress: (current, total, asset) => console.log(`에셋 검증 ${current}/${total}: ${asset}`),
        })
        console.log(JSON.stringify(result, null, 2))
    } catch (error) {
        console.error(error instanceof Error ? error.stack || error.message : String(error))
        process.exitCode = 1
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
