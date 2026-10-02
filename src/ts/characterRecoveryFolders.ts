import type { folder } from './storage/database.svelte'

export type CharacterRecoveryOrderEntry = string | folder

function withoutCharacter(
    order: CharacterRecoveryOrderEntry[],
    chaId: string,
): CharacterRecoveryOrderEntry[] {
    const next: CharacterRecoveryOrderEntry[] = []
    for (const entry of order) {
        if (typeof entry === 'string') {
            if (entry !== chaId) next.push(entry)
            continue
        }
        const data = (entry.data ?? []).filter((id) => id !== chaId)
        if (data.length === 0 && entry.name?.startsWith('[에셋 누락]')) continue
        next.push({ ...entry, data })
    }
    return next
}

function containsCharacter(order: CharacterRecoveryOrderEntry[], chaId: string): boolean {
    return order.some((entry) => typeof entry === 'string'
        ? entry === chaId
        : (entry.data ?? []).includes(chaId))
}

/** Remove a recovered character from missing-asset folders without making it
 * disappear from the sidebar. Existing non-missing folder membership wins;
 * otherwise the character returns to the top-level list. */
export function releaseCharacterFromMissingFolders(
    order: CharacterRecoveryOrderEntry[],
    chaId: string,
): CharacterRecoveryOrderEntry[] {
    const next: CharacterRecoveryOrderEntry[] = []
    let removed = false
    for (const entry of order) {
        if (typeof entry === 'string' || !entry.name?.startsWith('[에셋 누락]')) {
            next.push(entry)
            continue
        }
        const data = (entry.data ?? []).filter((id) => {
            if (id === chaId) removed = true
            return id !== chaId
        })
        if (data.length > 0) next.push({ ...entry, data })
    }
    if (removed && !containsCharacter(next, chaId)) next.unshift(chaId)
    return next
}

/** "[에셋 누락] 모바일웹리스" → "[복구] 모바일웹리스"; null for any other folder. */
export function recoveredFolderName(missingFolderName: string): string | null {
    const match = /^\[에셋 누락\]\s*(.+)$/.exec(missingFolderName)
    return match ? `[복구] ${match[1]}` : null
}

/** A card restored out of a "[에셋 누락] …" folder moves into the matching
 * "[복구] …" folder, so restored cards stay together instead of scattering
 * into the top-level list (the user's choice, 2026-10-02). A card that was
 * not in a missing-asset folder is released as before. */
export function moveRecoveredCharacter(
    order: CharacterRecoveryOrderEntry[],
    chaId: string,
    newFolderId: string,
): CharacterRecoveryOrderEntry[] {
    const source = order.find((entry): entry is folder => (
        typeof entry !== 'string' && !!entry.name?.startsWith('[에셋 누락]') && (entry.data ?? []).includes(chaId)
    ))
    const target = source ? recoveredFolderName(source.name) : null
    if (!target) return releaseCharacterFromMissingFolders(order, chaId)
    return moveCharacterToRecoveryFolder(order, chaId, target, newFolderId)
}

/** Put each listed card into its named folder, wherever it sits now. Folders
 * that do not exist yet are created at the top, in the order of first use;
 * a missing-asset folder left empty is dropped, as elsewhere. */
export function assignCharactersToFolders(
    order: CharacterRecoveryOrderEntry[],
    assignments: ReadonlyMap<string, string>,
    newFolderId: () => string,
): CharacterRecoveryOrderEntry[] {
    const next: CharacterRecoveryOrderEntry[] = []
    for (const entry of order) {
        if (typeof entry === 'string') {
            if (!assignments.has(entry)) next.push(entry)
            continue
        }
        next.push({ ...entry, data: (entry.data ?? []).filter((id) => !assignments.has(id)) })
    }
    const created: folder[] = []
    for (const [chaId, name] of assignments) {
        let target = next.find((entry): entry is folder => typeof entry !== 'string' && entry.name === name)
            ?? created.find((entry) => entry.name === name)
        if (!target) {
            target = { id: newFolderId(), name, color: '', data: [] }
            created.push(target)
        }
        target.data.push(chaId)
    }
    return [...created, ...next].filter((entry) => (
        typeof entry === 'string' || entry.data.length > 0 || !entry.name?.startsWith('[에셋 누락]')
    ))
}

/** A character can occupy only one sidebar location. Move unresolved cards
 * into one top-level Proton folder and keep that folder itself at the top. */
export function moveCharacterToRecoveryFolder(
    order: CharacterRecoveryOrderEntry[],
    chaId: string,
    folderName: string,
    newFolderId: string,
): CharacterRecoveryOrderEntry[] {
    const stripped = withoutCharacter(order, chaId)
    const existingIndex = stripped.findIndex((entry) => (
        typeof entry !== 'string' && entry.name === folderName
    ))
    const existing = existingIndex >= 0 ? stripped[existingIndex] as folder : null
    const rest = existingIndex >= 0
        ? stripped.filter((_, index) => index !== existingIndex)
        : stripped
    const target: folder = existing
        ? { ...existing, data: [chaId, ...(existing.data ?? []).filter((id) => id !== chaId)] }
        : { id: newFolderId, name: folderName, color: '', data: [chaId] }
    return [target, ...rest]
}
