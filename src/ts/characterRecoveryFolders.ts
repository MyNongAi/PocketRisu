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
