import type { loreBook } from '../storage/database.svelte'
import { duplicateNameSimilarity } from '../sourceCollectionDuplicates'

export type LoreComparisonStatus = 'match' | 'different'

interface ComparableCharacter {
    chaId?: string
    name?: unknown
    globalLore?: loreBook[]
}

interface ComparableModule {
    id?: string
    name?: unknown
    folderId?: string
    lorebook?: loreBook[]
}

interface SimilarityFolder {
    id?: string
    data?: string[]
    duplicateCandidate?: { kind?: 'character' | 'module' }
}

interface LoreComparisonDatabase {
    characters: ComparableCharacter[]
    characterOrder?: Array<string | SimilarityFolder>
    modules?: ComparableModule[]
    moduleFolders?: SimilarityFolder[]
}

const SIMILARITY_THRESHOLD = 0.9

function normalizedText(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
}

/** The visible lore title is comment first, then its activation key. */
export function loreTitleAndContentSignature(book: Partial<loreBook>): string {
    const title = normalizedText(book.comment) || normalizedText(book.key)
    return JSON.stringify([title, normalizedText(book.content)])
}

function compareLorebooks(
    current: readonly loreBook[] | undefined,
    peers: ReadonlyArray<readonly loreBook[] | undefined>,
): Map<loreBook, LoreComparisonStatus> {
    if (!current || peers.length === 0) return new Map()
    const peerSignatures = new Set<string>()
    for (const lorebooks of peers) {
        for (const book of lorebooks ?? []) peerSignatures.add(loreTitleAndContentSignature(book))
    }
    return new Map(current.map((book) => [
        book,
        peerSignatures.has(loreTitleAndContentSignature(book)) ? 'match' : 'different',
    ]))
}

function similarName(left: unknown, right: unknown): boolean {
    return duplicateNameSimilarity(left, right) >= SIMILARITY_THRESHOLD
}

export function buildCharacterLoreComparisonStatuses(
    db: LoreComparisonDatabase,
    chaId: string | undefined,
): Map<loreBook, LoreComparisonStatus> {
    if (!chaId) return new Map()
    const current = db.characters.find((character) => character.chaId === chaId)
    if (!current) return new Map()
    const peerIds = new Set<string>()
    for (const folder of db.characterOrder ?? []) {
        if (typeof folder === 'string' || folder.duplicateCandidate?.kind !== 'character') continue
        if (!folder.data?.includes(chaId)) continue
        for (const id of folder.data) if (id !== chaId) peerIds.add(id)
    }
    for (const candidate of db.characters) {
        if (candidate.chaId && candidate.chaId !== chaId && similarName(current.name, candidate.name)) {
            peerIds.add(candidate.chaId)
        }
    }
    const peers = db.characters
        .filter((character) => !!character.chaId && peerIds.has(character.chaId))
        .map((character) => character.globalLore)
    return compareLorebooks(current.globalLore, peers)
}

export function buildModuleLoreComparisonStatuses(
    db: LoreComparisonDatabase,
    moduleId: string | undefined,
): Map<loreBook, LoreComparisonStatus> {
    if (!moduleId) return new Map()
    const modules = db.modules ?? []
    const current = modules.find((module) => module.id === moduleId)
    if (!current) return new Map()
    const peerIds = new Set<string>()
    const candidateFolder = (db.moduleFolders ?? []).find((folder) =>
        folder.id === current.folderId && folder.duplicateCandidate?.kind === 'module')
    if (candidateFolder) {
        for (const candidate of modules) {
            if (candidate.id && candidate.id !== moduleId && candidate.folderId === candidateFolder.id) {
                peerIds.add(candidate.id)
            }
        }
    }
    for (const candidate of modules) {
        if (candidate.id && candidate.id !== moduleId && similarName(current.name, candidate.name)) {
            peerIds.add(candidate.id)
        }
    }
    const peers = modules
        .filter((module) => !!module.id && peerIds.has(module.id))
        .map((module) => module.lorebook)
    return compareLorebooks(current.lorebook, peers)
}
