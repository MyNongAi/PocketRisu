import { v4 } from 'uuid'
import {
    duplicateNameSimilarity,
    findHighSimilarityNameGroups,
    normalizeDuplicateName,
} from '../sourceCollectionDuplicates'
import { normalizeModuleFolders, type ModuleFolder } from './moduleFolders'

export interface SimilarityCandidateInfo {
    kind: 'character' | 'module'
    key: string
}

export interface SimilarityCharacterFolder {
    id: string
    name: string
    data: string[]
    color: string
    duplicateCandidate?: SimilarityCandidateInfo
}

export interface SimilarityFolderDatabase {
    characters: Array<{ chaId?: string, name?: unknown, sourceInfo?: { label?: string } }>
    characterOrder: Array<string | SimilarityCharacterFolder>
    modules: Array<{ id?: string, name?: unknown, sourceInfo?: { label?: string } }>
    moduleFolders?: ModuleFolder[]
    moduleActivationHistory?: string[]
}

const SIMILARITY_THRESHOLD = 0.9

function createUniqueId(
    db: SimilarityFolderDatabase,
    createId: () => string,
    reserved: Set<string> = new Set(),
): string {
    const used = new Set<string>()
    for(const character of db.characters) if(character.chaId) used.add(character.chaId)
    for(const entry of db.characterOrder){
        if(typeof entry === 'string') used.add(entry)
        else if(entry.id) used.add(entry.id)
    }
    for(const module of db.modules) if(module.id) used.add(module.id)
    for(const folder of db.moduleFolders ?? []) used.add(folder.id)
    for(const id of reserved) used.add(id)

    for(let attempt = 0; attempt < 100; attempt++){
        const id = createId()
        if(id && !used.has(id)){
            reserved.add(id)
            return id
        }
    }
    throw new Error('Could not allocate a unique similarity folder id')
}

function folderName(label: string, count: number, sourceLabels: readonly string[]): string {
    const sources = [...new Set(sourceLabels.filter(Boolean))].join(' · ')
    return `[유사 후보] ${label} · ${count}개${sources ? ` · ${sources}` : ''}`
}

function similarityComponent<T extends { name?: unknown }>(items: readonly T[], seed: T): T[] {
    const component: T[] = [seed]
    const included = new Set<T>(component)

    for(let cursor = 0; cursor < component.length; cursor++){
        const current = component[cursor]
        for(const candidate of items){
            if(included.has(candidate)) continue
            if(duplicateNameSimilarity(current.name, candidate.name) < SIMILARITY_THRESHOLD) continue
            included.add(candidate)
            component.push(candidate)
        }
    }
    return component
}

function promoteModuleGroups(db: SimilarityFolderDatabase, groups: readonly string[][]): void {
    const promoted = new Set(groups.flat())
    const history = (db.moduleActivationHistory ?? []).filter((id) => !promoted.has(id))
    // History is oldest -> newest. Append groups in reverse display order so
    // the first generated folder receives the newest (topmost) anchor.
    for(const ids of [...groups].reverse()) history.push(...ids)
    db.moduleActivationHistory = history
}

export function organizeAllCharacterSimilarityFolders(
    db: SimilarityFolderDatabase,
    createId: () => string = v4,
): void {
    const groups = findHighSimilarityNameGroups(db.characters, SIMILARITY_THRESHOLD)
        .map((group) => ({
            ...group,
            members: group.members.filter((character) => typeof character.chaId === 'string' && !!character.chaId),
        }))
        .filter((group) => group.members.length > 1)
    const candidateIds = new Set(groups.flatMap((group) => group.members.map((character) => character.chaId!)))
    const oldFolders = new Map(
        db.characterOrder
            .filter((entry): entry is SimilarityCharacterFolder => typeof entry !== 'string' && entry.duplicateCandidate?.kind === 'character')
            .map((folder) => [folder.duplicateCandidate!.key, folder]),
    )
    const reservedIds = new Set<string>()
    const baseOrder: Array<string | SimilarityCharacterFolder> = []
    for(const entry of db.characterOrder){
        if(typeof entry === 'string'){
            if(!candidateIds.has(entry)) baseOrder.push(entry)
            continue
        }
        if(entry.duplicateCandidate?.kind === 'character'){
            for(const id of entry.data){
                if(!candidateIds.has(id) && !baseOrder.includes(id)) baseOrder.push(id)
            }
            continue
        }
        baseOrder.push({ ...entry, data: entry.data.filter((id) => !candidateIds.has(id)) })
    }
    const folders = groups.map((group) => {
        const existing = oldFolders.get(group.key)
        return {
            id: existing?.id ?? createUniqueId(db, createId, reservedIds),
            name: folderName(
                group.label,
                group.members.length,
                group.members.map((member) => member.sourceInfo?.label ?? ''),
            ),
            data: group.members.map((character) => character.chaId!),
            color: existing?.color ?? 'yellow',
            duplicateCandidate: { kind: 'character', key: group.key } as const,
        }
    })
    db.characterOrder = [...folders, ...baseOrder]
}

export function organizeAllModuleSimilarityFolders(
    db: SimilarityFolderDatabase,
    createId: () => string = v4,
): void {
    const groups = findHighSimilarityNameGroups(db.modules, SIMILARITY_THRESHOLD)
        .map((group) => ({
            ...group,
            members: group.members.filter((module) => typeof module.id === 'string' && !!module.id),
        }))
        .filter((group) => group.members.length > 1)
    const candidateIds = new Set(groups.flatMap((group) => group.members.map((module) => module.id!)))
    const normalizedFolders = normalizeModuleFolders(db.moduleFolders)
    const oldFolders = new Map(
        normalizedFolders
            .filter((folder) => folder.duplicateCandidate?.kind === 'module')
            .map((folder) => [folder.duplicateCandidate!.key, folder]),
    )
    const reservedIds = new Set<string>()
    const baseFolders = normalizedFolders
        .filter((folder) => folder.duplicateCandidate?.kind !== 'module')
        .map((folder) => ({ ...folder, moduleIds: folder.moduleIds.filter((id) => !candidateIds.has(id)) }))
    const folders: ModuleFolder[] = groups.map((group) => {
        const existing = oldFolders.get(group.key)
        return {
            id: existing?.id ?? createUniqueId(db, createId, reservedIds),
            name: folderName(
                group.label,
                group.members.length,
                group.members.map((member) => member.sourceInfo?.label ?? ''),
            ),
            moduleIds: group.members.map((module) => module.id!),
            collapsed: existing?.collapsed ?? false,
            duplicateCandidate: { kind: 'module', key: group.key },
        }
    })
    db.moduleFolders = [...folders, ...baseFolders]
    promoteModuleGroups(db, folders.map((folder) => folder.moduleIds))
}

export function organizeAllSimilarityFolders(
    db: SimilarityFolderDatabase,
    createId: () => string = v4,
): void {
    organizeAllCharacterSimilarityFolders(db, createId)
    organizeAllModuleSimilarityFolders(db, createId)
}

export function organizeImportedCharacterSimilarity(
    db: SimilarityFolderDatabase,
    characterId: string,
    createId: () => string = v4,
): void {
    const seed = db.characters.find((character) => character.chaId === characterId)
    if(!seed) return
    const members = similarityComponent(db.characters, seed)
        .filter((character) => typeof character.chaId === 'string' && !!character.chaId)
        .sort((left, right) => db.characters.indexOf(left) - db.characters.indexOf(right))
    if(members.length < 2) return

    const memberIds = new Set(members.map((character) => character.chaId!))
    const existing = db.characterOrder.find((entry): entry is SimilarityCharacterFolder =>
        typeof entry !== 'string'
        && entry.duplicateCandidate?.kind === 'character'
        && entry.data.some((id) => memberIds.has(id)),
    )
    const baseOrder: Array<string | SimilarityCharacterFolder> = []
    for(const entry of db.characterOrder){
        if(typeof entry === 'string'){
            if(!memberIds.has(entry)) baseOrder.push(entry)
            continue
        }
        const remaining = entry.data.filter((id) => !memberIds.has(id))
        if(entry.id === existing?.id){
            // A generated folder can become stale after a rename. Keep its old
            // non-matching members visible at root instead of duplicating the
            // folder id or silently hiding those characters.
            for(const id of remaining) if(!baseOrder.includes(id)) baseOrder.push(id)
        }
        else if(remaining.length > 0) baseOrder.push({ ...entry, data: remaining })
    }
    const representative = members[0]
    const key = normalizeDuplicateName(representative.name)
    db.characterOrder = [{
        id: existing?.id ?? createUniqueId(db, createId),
        name: folderName(
            typeof representative.name === 'string' ? representative.name.trim() : key,
            members.length,
            members.map((member) => member.sourceInfo?.label ?? ''),
        ),
        data: members.map((character) => character.chaId!),
        color: existing?.color ?? 'yellow',
        duplicateCandidate: { kind: 'character', key },
    }, ...baseOrder]
}

export function organizeImportedModuleSimilarity(
    db: SimilarityFolderDatabase,
    moduleId: string,
    createId: () => string = v4,
): void {
    const seed = db.modules.find((module) => module.id === moduleId)
    if(!seed) return
    const members = similarityComponent(db.modules, seed)
        .filter((module) => typeof module.id === 'string' && !!module.id)
        .sort((left, right) => db.modules.indexOf(left) - db.modules.indexOf(right))
    if(members.length < 2) return

    const memberIds = new Set(members.map((module) => module.id!))
    const folders = normalizeModuleFolders(db.moduleFolders)
    const existing = folders.find((folder) =>
        folder.duplicateCandidate?.kind === 'module'
        && folder.moduleIds.some((id) => memberIds.has(id)),
    )
    const baseFolders = folders.flatMap((folder) => {
        if(folder.id === existing?.id) return []
        const remaining = folder.moduleIds.filter((id) => !memberIds.has(id))
        return remaining.length > 0 ? [{ ...folder, moduleIds: remaining }] : []
    })
    const representative = members[0]
    const key = normalizeDuplicateName(representative.name)
    const generated: ModuleFolder = {
        id: existing?.id ?? createUniqueId(db, createId),
        name: folderName(
            typeof representative.name === 'string' ? representative.name.trim() : key,
            members.length,
            members.map((member) => member.sourceInfo?.label ?? ''),
        ),
        moduleIds: members.map((module) => module.id!),
        collapsed: existing?.collapsed ?? false,
        duplicateCandidate: { kind: 'module', key },
    }
    db.moduleFolders = [generated, ...baseFolders]
    promoteModuleGroups(db, [generated.moduleIds])
}
