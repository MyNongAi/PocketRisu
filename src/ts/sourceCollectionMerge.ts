import type { SourceCollectionKind, SourceImportInfo } from './sourceCollection'
import { recordNewModules } from './process/moduleSort'
import { findHighSimilarityNameGroups } from './sourceCollectionDuplicates'

interface DuplicateCandidateInfo {
    kind: 'character' | 'module'
    key: string
}

export interface SourceMergeFolder {
    name: string
    data: string[]
    color: string
    id: string
    sourceInfo?: SourceImportInfo
    duplicateCandidate?: DuplicateCandidateInfo
}

export interface SourceMergeModuleFolder {
    id: string
    name: string
    moduleIds: string[]
    collapsed?: boolean
    sourceInfo?: SourceImportInfo
    duplicateCandidate?: DuplicateCandidateInfo
}

export interface SourceMergeDatabase {
    characters: Record<string, any>[]
    characterOrder: (string | SourceMergeFolder)[]
    modules: Record<string, any>[]
    enabledModules?: string[]
    moduleActivationHistory?: string[]
    moduleFolders?: SourceMergeModuleFolder[]
    personas: Record<string, any>[]
}

export interface ApplySourceCollectionOptions {
    kind: SourceCollectionKind
    sourceLabel: string
    bundleId: string
    collectionId?: string
    entities: unknown[]
    /** Only mappings from the explicitly related module collection belong here. */
    moduleIdMapping?: ReadonlyMap<string, string>
    importedAt?: number
    createId: () => string
    createBlankCharacter: () => Record<string, any>
}

export interface SourceCollectionMergeResult {
    characters: number
    modules: number
    personas: number
    folderName: string
    moduleIdMap: Map<string, string>
    droppedModuleReferences: number
}

function cloneRecord(value: unknown, kind: SourceCollectionKind, index: number): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid ${kind} entity at index ${index}`)
    }
    const cloned = structuredClone(value as Record<string, any>)
    if (typeof cloned.name !== 'string') throw new Error(`Missing ${kind} entity name at index ${index}`)
    return cloned
}

function createUniqueId(createId: () => string, used: Set<string>): string {
    for (let attempt = 0; attempt < 100; attempt++) {
        const id = createId()
        if (typeof id !== 'string' || !id || used.has(id)) continue
        used.add(id)
        return id
    }
    throw new Error('Could not allocate a unique id for imported collection')
}

export function sourceCollectionFolderName(sourceLabel: string): string {
    return `[출처] ${sourceLabel.trim()}`
}

function duplicateCandidateFolderName(
    label: string,
    totalMatches: number,
    sourceLabels: readonly string[],
): string {
    const sources = [...new Set(sourceLabels.filter(Boolean))].join(' · ')
    return `[중복 후보] ${label} · ${totalMatches}개${sources ? ` · ${sources}` : ''}`
}

/**
 * Imported duplicates are moved out of source folders into visible review
 * folders. Non-imported user items can be a match but are never moved.
 */
function organizeCharacterDuplicateCandidates(db: SourceMergeDatabase, createId: () => string): void {
    const groups = findHighSimilarityNameGroups(db.characters)
        .map((group) => ({
            ...group,
            imported: group.members.filter((character) => typeof character?.sourceInfo?.label === 'string'),
        }))
        .filter((group) => group.imported.length > 0)
    const candidateIds = new Set(groups.flatMap((group) => group.imported.map((character) => character.chaId)))
    const oldFolders = new Map(
        db.characterOrder
            .filter((entry): entry is SourceMergeFolder => typeof entry !== 'string' && entry.duplicateCandidate?.kind === 'character')
            .map((folder) => [folder.duplicateCandidate!.key, folder]),
    )
    const usedIds = new Set([
        ...db.characters.map((character) => character.chaId),
        ...db.characterOrder.flatMap((entry) => typeof entry === 'string' ? [entry] : [entry.id]),
    ].filter((id): id is string => typeof id === 'string' && !!id))
    const baseOrder: (string | SourceMergeFolder)[] = []
    for (const entry of db.characterOrder) {
        if (typeof entry === 'string') {
            if (!candidateIds.has(entry)) baseOrder.push(entry)
            continue
        }
        if (entry.duplicateCandidate?.kind === 'character') continue
        baseOrder.push({ ...entry, data: entry.data.filter((id) => !candidateIds.has(id)) })
    }
    const duplicateFolders = groups.map((group) => {
        const existing = oldFolders.get(group.key)
        const labels = group.members.map((member) => member?.sourceInfo?.label ?? '')
        return {
            id: existing?.id ?? createUniqueId(createId, usedIds),
            name: duplicateCandidateFolderName(group.label, group.members.length, labels),
            data: [...new Set(group.imported.map((character) => character.chaId))],
            color: existing?.color ?? 'yellow',
            duplicateCandidate: { kind: 'character', key: group.key } as const,
        }
    })
    db.characterOrder = [...duplicateFolders, ...baseOrder]
}

function organizeModuleDuplicateCandidates(db: SourceMergeDatabase, createId: () => string): void {
    const groups = findHighSimilarityNameGroups(db.modules)
        .map((group) => ({
            ...group,
            imported: group.members.filter((module) => typeof module?.sourceInfo?.label === 'string'),
        }))
        .filter((group) => group.imported.length > 0)
    const candidateIds = new Set(groups.flatMap((group) => group.imported.map((module) => module.id)))
    const oldFolders = new Map(
        (db.moduleFolders ?? [])
            .filter((folder) => folder.duplicateCandidate?.kind === 'module')
            .map((folder) => [folder.duplicateCandidate!.key, folder]),
    )
    const usedIds = new Set([
        ...db.modules.map((module) => module.id),
        ...(db.moduleFolders ?? []).map((folder) => folder.id),
    ].filter((id): id is string => typeof id === 'string' && !!id))
    const baseFolders = (db.moduleFolders ?? [])
        .filter((folder) => folder.duplicateCandidate?.kind !== 'module')
        .map((folder) => ({ ...folder, moduleIds: folder.moduleIds.filter((id) => !candidateIds.has(id)) }))
    const duplicateFolders = groups.map((group) => {
        const existing = oldFolders.get(group.key)
        const labels = group.members.map((member) => member?.sourceInfo?.label ?? '')
        return {
            id: existing?.id ?? createUniqueId(createId, usedIds),
            name: duplicateCandidateFolderName(group.label, group.members.length, labels),
            moduleIds: [...new Set(group.imported.map((module) => module.id))],
            collapsed: existing?.collapsed ?? false,
            duplicateCandidate: { kind: 'module', key: group.key } as const,
        }
    })
    db.moduleFolders = [...duplicateFolders, ...baseFolders]
}

function remapModuleReferenceList(
    value: unknown,
    mapping: ReadonlyMap<string, string>,
): { value: string[], dropped: number } {
    if (!Array.isArray(value)) return { value: [], dropped: value === undefined ? 0 : 1 }
    const remapped: string[] = []
    const seen = new Set<string>()
    let dropped = 0
    for (const sourceId of value) {
        if (typeof sourceId !== 'string') {
            dropped += 1
            continue
        }
        const targetId = mapping.get(sourceId)
        if (!targetId) {
            dropped += 1
            continue
        }
        if (!seen.has(targetId)) {
            seen.add(targetId)
            remapped.push(targetId)
        }
    }
    return { value: remapped, dropped }
}

function sourceModuleIds(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id))]
}

/**
 * Reconnect characters imported before their module bundle. Pending ids live
 * only in provenance metadata and are never exposed to the runtime module
 * loader, so a coincidentally equal target id cannot activate unrelated code.
 */
export function reconcileSourceCollectionModuleReferences(
    db: Pick<SourceMergeDatabase, 'characters'>,
    collectionId: string,
    mapping: ReadonlyMap<string, string>,
): number {
    let restored = 0
    for (const character of db.characters) {
        const info = character?.sourceInfo as SourceImportInfo | undefined
        if (info?.collectionId !== collectionId || !Array.isArray(info.originalModuleIds)) continue
        const remapped = remapModuleReferenceList(info.originalModuleIds, mapping)
        character.modules = remapped.value
        restored += remapped.value.length
    }
    return restored
}

export function applySourceCollectionEntities(
    db: SourceMergeDatabase,
    options: ApplySourceCollectionOptions,
): SourceCollectionMergeResult {
    const entities = options.entities.map((value, index) => cloneRecord(value, options.kind, index))
    const folderName = sourceCollectionFolderName(options.sourceLabel)
    const sourceInfo: SourceImportInfo = {
        label: options.sourceLabel.trim(),
        bundleId: options.bundleId,
        importedAt: options.importedAt ?? Date.now(),
        collectionId: options.collectionId,
    }
    const result: SourceCollectionMergeResult = {
        characters: 0,
        modules: 0,
        personas: 0,
        folderName,
        moduleIdMap: new Map(),
        droppedModuleReferences: 0,
    }

    if (options.kind === 'characters') {
        const usedIds = new Set([
            ...db.characters.map((character) => character.chaId),
            ...db.characterOrder.flatMap((entry) => typeof entry === 'string' ? [entry] : [entry.id]),
        ].filter((id): id is string => typeof id === 'string' && !!id))
        const ids: string[] = []
        const characters = entities.map((entity) => {
            const blank = options.createBlankCharacter()
            const id = createUniqueId(options.createId, usedIds)
            const originalModuleIds = sourceModuleIds(entity.modules)
            if (Object.hasOwn(entity, 'modules')) {
                const remapped = remapModuleReferenceList(entity.modules, options.moduleIdMapping ?? new Map())
                entity.modules = remapped.value
                result.droppedModuleReferences += remapped.dropped
            }
            ids.push(id)
            return {
                ...blank,
                ...entity,
                type: 'character',
                chaId: id,
                chats: blank.chats,
                chatFolders: [],
                chatPage: 0,
                trashTime: undefined,
                sourceInfo: {
                    ...sourceInfo,
                    ...(Object.hasOwn(entity, 'modules') ? { originalModuleIds } : {}),
                },
            }
        })
        db.characters.push(...characters)
        let folder = db.characterOrder.find(
            (entry): entry is SourceMergeFolder => typeof entry !== 'string' && entry.sourceInfo?.label === sourceInfo.label,
        )
        if (!folder) {
            folder = {
                id: createUniqueId(options.createId, usedIds),
                name: folderName,
                data: [],
                color: '',
                sourceInfo: { ...sourceInfo },
            }
            db.characterOrder.unshift(folder)
        }
        folder.data.push(...ids)
        organizeCharacterDuplicateCandidates(db, options.createId)
        result.characters = characters.length
    } else if (options.kind === 'modules') {
        const usedIds = new Set([
            ...db.modules.map((module) => module.id),
            ...(db.moduleFolders ?? []).map((folder) => folder.id),
        ].filter((id): id is string => typeof id === 'string' && !!id))
        const sourceIds = new Set<string>()
        const modules = entities.map((entity, index) => {
            const originalId = entity.id
            if (typeof originalId !== 'string' || !originalId) {
                throw new Error(`Missing modules entity id at index ${index}`)
            }
            if (sourceIds.has(originalId)) throw new Error(`Duplicate module id in collection: ${originalId}`)
            sourceIds.add(originalId)
            const id = createUniqueId(options.createId, usedIds)
            result.moduleIdMap.set(originalId, id)
            return {
                description: '',
                ...entity,
                id,
                sourceInfo: { ...sourceInfo, originalId },
            }
        })
        db.modules.push(...modules)
        db.moduleActivationHistory = recordNewModules(
            db.moduleActivationHistory,
            [db.enabledModules],
            modules.map((module) => module.id),
        )
        db.moduleFolders ??= []
        let folder = db.moduleFolders.find((entry) => entry.sourceInfo?.label === sourceInfo.label)
        if (!folder) {
            folder = {
                id: createUniqueId(options.createId, usedIds),
                name: folderName,
                moduleIds: [],
                collapsed: false,
                sourceInfo: { ...sourceInfo },
            }
            db.moduleFolders.push(folder)
        }
        folder.moduleIds.push(...modules.map((module) => module.id))
        organizeModuleDuplicateCandidates(db, options.createId)
        result.modules = modules.length
    } else {
        const usedIds = new Set(db.personas.map((persona) => persona.id).filter(
            (id): id is string => typeof id === 'string' && !!id,
        ))
        const personas = entities.map((entity) => ({
            icon: '',
            personaPrompt: '',
            note: '',
            ...entity,
            id: createUniqueId(options.createId, usedIds),
            sourceInfo: { ...sourceInfo },
        }))
        db.personas.push(...personas)
        result.personas = personas.length
    }

    return result
}
