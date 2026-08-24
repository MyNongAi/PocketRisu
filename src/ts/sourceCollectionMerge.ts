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
    entities: unknown[]
    importedAt?: number
    createId: () => string
    createBlankCharacter: () => Record<string, any>
}

export interface SourceCollectionMergeResult {
    characters: number
    modules: number
    personas: number
    folderName: string
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
    }
    const result: SourceCollectionMergeResult = { characters: 0, modules: 0, personas: 0, folderName }

    if (options.kind === 'characters') {
        const usedIds = new Set([
            ...db.characters.map((character) => character.chaId),
            ...db.characterOrder.flatMap((entry) => typeof entry === 'string' ? [entry] : [entry.id]),
        ].filter((id): id is string => typeof id === 'string' && !!id))
        const ids: string[] = []
        const characters = entities.map((entity) => {
            const blank = options.createBlankCharacter()
            const id = createUniqueId(options.createId, usedIds)
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
                sourceInfo: { ...sourceInfo },
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
        const modules = entities.map((entity) => ({
            description: '',
            ...entity,
            id: createUniqueId(options.createId, usedIds),
            sourceInfo: { ...sourceInfo },
        }))
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
