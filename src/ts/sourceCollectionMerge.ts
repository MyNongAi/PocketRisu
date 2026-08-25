import type { SourceCollectionKind, SourceImportInfo } from './sourceCollection'

export interface SourceMergeFolder {
    name: string
    data: string[]
    color: string
    id: string
    sourceInfo?: SourceImportInfo
}

export interface SourceMergeModuleFolder {
    id: string
    name: string
    moduleIds: string[]
    collapsed?: boolean
    sourceInfo?: SourceImportInfo
}

export interface SourceMergeDatabase {
    characters: Record<string, any>[]
    characterOrder: (string | SourceMergeFolder)[]
    modules: Record<string, any>[]
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
