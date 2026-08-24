import { v4 } from 'uuid'
import { tick } from 'svelte'
import { alertError, alertWait, notifySuccess } from './alert'
import { createBlankChar } from './characters'
import { checkCharOrder, requestImmediateSave, saveAsset } from './globalApi.svelte'
import { refreshModules } from './process/modules'
import { safeStructuredClone } from './polyfill'
import {
    decodeAndVerifyCollectionAsset,
    parseSourceCollectionPart,
    rewriteSourceCollectionAssets,
    safeCollectionAssetFileName,
    sourceCollectionHeader,
    SOURCE_COLLECTION_MAX_PART_BYTES,
    validateSourceCollectionAssetCoverage,
    validateSourceCollectionHeaders,
    type SourceCollectionHeader,
    type SourceCollectionPart,
} from './sourceCollection'
import { applySourceCollectionEntities, type SourceCollectionMergeResult } from './sourceCollectionMerge'
import { getDatabase } from './storage/database.svelte'

interface IndexedCollectionPart {
    file: File
    header: SourceCollectionHeader
    entities: unknown[]
    assetMetadata: { path: string, size: number, sha256: string }[]
}

export interface SourceCollectionImportSummary {
    bundles: number
    characters: number
    modules: number
    personas: number
    assets: number
}

async function parseFile(file: File): Promise<SourceCollectionPart> {
    if (file.size > SOURCE_COLLECTION_MAX_PART_BYTES) {
        throw new Error(`${file.name} exceeds the 32 MB mobile-safe collection part limit`)
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(await file.text())
    } catch {
        throw new Error(`${file.name} is not a valid collection part`)
    }
    return parseSourceCollectionPart(parsed)
}

async function indexFiles(files: readonly File[]): Promise<Map<string, IndexedCollectionPart[]>> {
    const groups = new Map<string, IndexedCollectionPart[]>()
    for (let index = 0; index < files.length; index++) {
        alertWait(`컬렉션 검사 중… (${index + 1}/${files.length})`)
        const parsed = await parseFile(files[index])
        const part: IndexedCollectionPart = {
            file: files[index],
            header: sourceCollectionHeader(parsed),
            entities: parsed.entities,
            assetMetadata: parsed.assets.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
        }
        const list = groups.get(parsed.bundleId) ?? []
        list.push(part)
        groups.set(parsed.bundleId, list)
    }

    for (const list of groups.values()) {
        const sortedHeaders = validateSourceCollectionHeaders(list.map((part) => part.header))
        const byIndex = new Map(list.map((part) => [part.header.partIndex, part]))
        list.splice(0, list.length, ...sortedHeaders.map((header) => byIndex.get(header.partIndex)!))
        const assetMetadata = new Map<string, string>()
        for (const part of list) {
            for (const asset of part.assetMetadata) {
                const signature = `${asset.size}:${asset.sha256}`
                const previous = assetMetadata.get(asset.path)
                if (previous && previous !== signature) {
                    throw new Error(`Conflicting copies of ${asset.path} exist in one collection`)
                }
                assetMetadata.set(asset.path, signature)
            }
        }
        validateSourceCollectionAssetCoverage(
            list.map((part) => part.entities),
            assetMetadata.keys(),
        )
    }
    return groups
}

export async function importSourceCollectionFiles(files: readonly File[]): Promise<SourceCollectionImportSummary> {
    if (files.length === 0) throw new Error('No collection parts were selected')
    const groups = await indexFiles(files)
    const prepared: {
        header: SourceCollectionHeader
        entities: unknown[]
    }[] = []
    let savedAssets = 0

    // Assets are staged first. A failure can leave harmless unreferenced,
    // content-addressed blobs, but never half-attaches entities to missing data.
    for (const parts of groups.values()) {
        const mapping = new Map<string, string>()
        const seenHashes = new Map<string, string>()
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            alertWait(`${parts[0].header.sourceLabel} 에셋 검증·저장 중… (${partIndex + 1}/${parts.length})`)
            const parsed = await parseFile(parts[partIndex].file)
            for (const asset of parsed.assets) {
                const previousHash = seenHashes.get(asset.path)
                if (previousHash === asset.sha256) continue
                const bytes = await decodeAndVerifyCollectionAsset(asset)
                const fileName = safeCollectionAssetFileName(asset.path)
                const savedPath = await saveAsset(bytes, '', fileName)
                mapping.set(asset.path, savedPath)
                seenHashes.set(asset.path, asset.sha256)
                savedAssets += 1
            }
        }
        const entities = rewriteSourceCollectionAssets(
            parts.flatMap((part) => part.entities),
            mapping,
        )
        for (let index = 0; index < entities.length; index++) {
            const entity = entities[index]
            if (!entity || typeof entity !== 'object' || Array.isArray(entity) || typeof (entity as any).name !== 'string') {
                throw new Error(`Invalid ${parts[0].header.kind} entity at index ${index}`)
            }
        }
        // Do not retain both the parsed source graph and rewritten graph while
        // later bundles are processed on a memory-constrained browser.
        for (const part of parts) part.entities = []
        prepared.push({ header: parts[0].header, entities })
    }

    const db = getDatabase()
    const summary: SourceCollectionImportSummary = {
        bundles: prepared.length,
        characters: 0,
        modules: 0,
        personas: 0,
        assets: savedAssets,
    }
    // Only the five shallow collection arrays need rollback snapshots. Existing
    // giant characters/chats/modules are not deep-cloned.
    const rollback = {
        characters: [...db.characters],
        characterOrder: safeStructuredClone(db.characterOrder),
        modules: [...db.modules],
        moduleFolders: safeStructuredClone(db.moduleFolders ?? []),
        hadModuleFolders: db.moduleFolders !== undefined,
        personas: [...db.personas],
    }
    try {
        for (const group of prepared) {
            const merged: SourceCollectionMergeResult = applySourceCollectionEntities(db, {
                kind: group.header.kind,
                sourceLabel: group.header.sourceLabel,
                bundleId: group.header.bundleId,
                importedAt: Date.now(),
                entities: group.entities,
                createId: v4,
                createBlankCharacter: createBlankChar,
            })
            summary.characters += merged.characters
            summary.modules += merged.modules
            summary.personas += merged.personas
        }

        if (summary.characters > 0) checkCharOrder()
        if (summary.modules > 0) refreshModules()
        // Let the granular character/module/root trackers observe the appended
        // arrays before forcing their pending patch to disk.
        await tick()
        await requestImmediateSave()
    } catch (error) {
        db.characters = rollback.characters
        db.characterOrder = rollback.characterOrder
        db.modules = rollback.modules
        if (rollback.hadModuleFolders) db.moduleFolders = rollback.moduleFolders
        else delete db.moduleFolders
        db.personas = rollback.personas
        if (summary.modules > 0) refreshModules()
        throw error
    }
    return summary
}

export async function selectAndImportSourceCollections(): Promise<void> {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.risu-characters,.risu-modules,.risu-personas,.json'
    input.onchange = async () => {
        const files = [...(input.files ?? [])]
        input.remove()
        if (files.length === 0) return
        try {
            const summary = await importSourceCollectionFiles(files)
            notifySuccess(
                `출처 묶음 ${summary.bundles}개 병합 완료 · 봇 ${summary.characters} · 모듈 ${summary.modules} · 페르소나 ${summary.personas} · 에셋 ${summary.assets}`,
            )
        } catch (error) {
            console.error(error)
            alertError(error)
        }
    }
    input.click()
}
