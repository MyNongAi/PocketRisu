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
import {
    applySourceCollectionEntities,
    reconcileSourceCollectionModuleReferences,
    type SourceCollectionMergeResult,
} from './sourceCollectionMerge'
import { getDatabase } from './storage/database.svelte'

interface IndexedCollectionPart {
    file: File
    header: SourceCollectionHeader
    entities: unknown[]
    assetMetadata: { path: string, size: number, sha256: string }[]
    omittedAssetMetadata: { path: string, size: number, reason: 'too-large' | 'read-failed' }[]
}

export interface SourceCollectionImportSummary {
    bundles: number
    characters: number
    modules: number
    personas: number
    assets: number
    omittedAssets: number
    droppedModuleReferences: number
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
            omittedAssetMetadata: parsed.omittedAssets,
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
                const signature = `supplied:${asset.size}:${asset.sha256}`
                const previous = assetMetadata.get(asset.path)
                if (previous && previous !== signature) {
                    throw new Error(`Conflicting copies of ${asset.path} exist in one collection`)
                }
                assetMetadata.set(asset.path, signature)
            }
            for (const asset of part.omittedAssetMetadata) {
                const signature = `omitted:${asset.size}:${asset.reason}`
                const previous = assetMetadata.get(asset.path)
                if (previous && previous !== signature) {
                    throw new Error(`Conflicting supplied/omitted copies of ${asset.path} exist in one collection`)
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
    let omittedAssets = 0

    // Assets are staged first. A failure can leave harmless unreferenced,
    // content-addressed blobs, but never half-attaches entities to missing data.
    for (const parts of groups.values()) {
        const mapping = new Map<string, string>()
        const seenHashes = new Map<string, string>()
        const seenOmissions = new Set<string>()
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            alertWait(`${parts[0].header.sourceLabel} 에셋 검증·저장 중… (${partIndex + 1}/${parts.length})`)
            const parsed = await parseFile(parts[partIndex].file)
            for (const omitted of parsed.omittedAssets) {
                if (seenOmissions.has(omitted.path)) continue
                // Never leave a source asset id behind: it could coincidentally
                // resolve to an unrelated target asset. The exact omission stays
                // recorded in the collection JSON for later recovery.
                mapping.set(omitted.path, '')
                seenOmissions.add(omitted.path)
                omittedAssets += 1
            }
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
        omittedAssets,
        droppedModuleReferences: 0,
    }
    // Only the five shallow collection arrays need rollback snapshots. Existing
    // giant characters/chats/modules are not deep-cloned.
    const rollback = {
        characters: [...db.characters],
        characterOrder: safeStructuredClone(db.characterOrder),
        modules: [...db.modules],
        moduleActivationHistory: [...(db.moduleActivationHistory ?? [])],
        hadModuleActivationHistory: db.moduleActivationHistory !== undefined,
        moduleFolders: safeStructuredClone(db.moduleFolders ?? []),
        hadModuleFolders: db.moduleFolders !== undefined,
        personas: [...db.personas],
    }
    const moduleReferenceRollback = new Map<Record<string, any>, { hadModules: boolean, modules: unknown }>()
    try {
        type ScopedModuleMap = { mapping: Map<string, string>, ambiguous: Set<string> }
        const scopedModuleMaps = new Map<string, ScopedModuleMap>()
        const changedModuleScopes = new Set<string>()
        const addModuleMapping = (scope: ScopedModuleMap, sourceId: string, targetId: string) => {
            if (scope.ambiguous.has(sourceId)) return
            if (scope.mapping.has(sourceId)) {
                scope.mapping.delete(sourceId)
                scope.ambiguous.add(sourceId)
                return
            }
            scope.mapping.set(sourceId, targetId)
        }
        for (const module of db.modules) {
            const info = module?.sourceInfo
            if (
                typeof info?.collectionId !== 'string' ||
                typeof info?.originalId !== 'string' ||
                typeof module?.id !== 'string'
            ) continue
            let scope = scopedModuleMaps.get(info.collectionId)
            if (!scope) {
                scope = { mapping: new Map(), ambiguous: new Set() }
                scopedModuleMaps.set(info.collectionId, scope)
            }
            addModuleMapping(scope, info.originalId, module.id)
        }

        // Modules must receive their fresh ids before related characters are
        // attached, regardless of the user's file-picker ordering.
        const orderedGroups = prepared.map((group, index) => ({ group, index }))
            .sort((left, right) => {
                const priority = (kind: SourceCollectionHeader['kind']) => kind === 'modules' ? 0 : kind === 'characters' ? 1 : 2
                return priority(left.group.header.kind) - priority(right.group.header.kind) || left.index - right.index
            })

        for (const { group } of orderedGroups) {
            const collectionId = group.header.collectionId
            const relatedModules = collectionId ? scopedModuleMaps.get(collectionId)?.mapping : undefined
            const merged: SourceCollectionMergeResult = applySourceCollectionEntities(db, {
                kind: group.header.kind,
                sourceLabel: group.header.sourceLabel,
                bundleId: group.header.bundleId,
                collectionId,
                importedAt: Date.now(),
                entities: group.entities,
                moduleIdMapping: relatedModules,
                createId: v4,
                createBlankCharacter: createBlankChar,
            })
            summary.characters += merged.characters
            summary.modules += merged.modules
            summary.personas += merged.personas
            summary.droppedModuleReferences += merged.droppedModuleReferences
            if (group.header.kind === 'modules' && collectionId) {
                let scope = scopedModuleMaps.get(collectionId)
                if (!scope) {
                    scope = { mapping: new Map(), ambiguous: new Set() }
                    scopedModuleMaps.set(collectionId, scope)
                }
                for (const [sourceId, targetId] of merged.moduleIdMap) {
                    addModuleMapping(scope, sourceId, targetId)
                }
                changedModuleScopes.add(collectionId)
            }
        }

        // Also repairs characters from an earlier, character-only import. If a
        // source id became ambiguous, this pass clears the formerly resolved
        // live id again instead of leaving a possibly wrong module attached.
        for (const collectionId of changedModuleScopes) {
            const scope = scopedModuleMaps.get(collectionId)
            if (!scope) continue
            for (const character of db.characters) {
                if (character?.sourceInfo?.collectionId !== collectionId || moduleReferenceRollback.has(character)) continue
                moduleReferenceRollback.set(character, {
                    hadModules: Object.hasOwn(character, 'modules'),
                    modules: character.modules,
                })
            }
            reconcileSourceCollectionModuleReferences(db, collectionId, scope.mapping)
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
        if (rollback.hadModuleActivationHistory) db.moduleActivationHistory = rollback.moduleActivationHistory
        else delete db.moduleActivationHistory
        if (rollback.hadModuleFolders) db.moduleFolders = rollback.moduleFolders
        else delete db.moduleFolders
        db.personas = rollback.personas
        for (const [character, previous] of moduleReferenceRollback) {
            if (previous.hadModules) character.modules = previous.modules
            else delete character.modules
        }
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
                `출처 묶음 ${summary.bundles}개 병합 완료 · 봇 ${summary.characters} · 모듈 ${summary.modules} · 페르소나 ${summary.personas} · 에셋 ${summary.assets} · 에셋 누락 ${summary.omittedAssets} · 모듈 연결 제외 ${summary.droppedModuleReferences}`,
            )
        } catch (error) {
            console.error(error)
            alertError(error)
        }
    }
    input.click()
}
