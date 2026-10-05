// Where a card or module was downloaded from on Proton Drive (the user's
// request, 2026-10-05): kept on the imported character or module so a card
// whose assets break later can be fetched again from the same link, and so
// the source badge can read 프로톤. The share's password is never kept; a
// protected link asks for it again.

/** A Proton download, as recorded on what it imported. */
export interface ProtonSourceRecord {
    /** The share link (https://drive.proton.me/urls/<id>#<key>). */
    link: string
    /** The file's name in the share. */
    file: string
    /** For a folder share: the file's link id and the folder link ids above it, outermost first. */
    linkId?: string
    path?: string[]
    /** When it was downloaded. */
    at: number
}

/** The share link of whatever an item records (its Proton source, or a Realm companion module's share). */
export function protonLinkOf(item: { nodeOnlyProtonSource?: ProtonSourceRecord, nodeOnlyProtonShare?: string } | null | undefined): string {
    return item?.nodeOnlyProtonSource?.link || item?.nodeOnlyProtonShare || ''
}

/** Copies a recorded share link (the bot and module menus). */
export async function copyProtonLink(link: string): Promise<void> {
    const [{ alertError, notifySuccess }, { language }] = await Promise.all([import('./alert'), import('src/lang')])
    try {
        await navigator.clipboard.writeText(link)
        notifySuccess(language.protonLinkCopied)
    } catch {
        alertError(link)
    }
}

interface StampableCharacter { chaId?: string, nodeOnlyProtonSource?: ProtonSourceRecord }
interface StampableModule { id?: string, nodeOnlyProtonSource?: ProtonSourceRecord, nodeOnlyProtonShare?: string }

export interface ImportedIds {
    characters: Set<string>
    modules: Set<string>
}

/** The character and module ids there are before an import. */
export function snapshotImportedIds(db: { characters?: readonly (StampableCharacter | null | undefined)[], modules?: readonly (StampableModule | null | undefined)[] }): ImportedIds {
    return {
        characters: new Set((db.characters ?? []).map((c) => c?.chaId).filter((id): id is string => !!id)),
        modules: new Set((db.modules ?? []).map((m) => m?.id).filter((id): id is string => !!id)),
    }
}

/**
 * Records `source` on the characters and modules an import added (those not
 * in `before`; a large CHARX may come in as either). A module also gets the
 * share link the Realm companion download reuses. Returns the stamped ids.
 */
export function stampProtonSource(
    db: { characters?: (StampableCharacter | null | undefined)[], modules?: (StampableModule | null | undefined)[] },
    before: ImportedIds,
    source: ProtonSourceRecord,
): { characters: string[], modules: string[] } {
    const characters: string[] = []
    const modules: string[] = []
    for (const character of db.characters ?? []) {
        if (!character?.chaId || before.characters.has(character.chaId)) continue
        character.nodeOnlyProtonSource = { ...source }
        characters.push(character.chaId)
    }
    for (const module of db.modules ?? []) {
        if (!module?.id || before.modules.has(module.id)) continue
        module.nodeOnlyProtonSource = { ...source }
        module.nodeOnlyProtonShare ??= source.link
        modules.push(module.id)
    }
    return { characters, modules }
}
