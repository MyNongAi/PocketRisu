// Modules paired with a bot: listed in a character's own modules
// (character.modules), so they switch on in that bot's chats only. Both sides
// show a chain: green while the pair holds, red once one side is gone
// (asked for on 2026-10-03). A bot whose module was deleted still lists its
// id; a module remembers the bots it was paired with
// (nodeOnlyPairedCharacterIds), so it can tell when they are gone.

export type ModuleLinkState = 'linked' | 'broken'

export interface ModuleLink {
    state: ModuleLinkState
    /** Bots it is paired with (linked), or was paired with (broken). */
    names: string[]
}

interface PairCharacter {
    chaId?: string
    name?: string
    modules?: readonly string[]
    trashTime?: number
}

interface PairModule {
    id: string
    nodeOnlyPairedCharacterIds?: string[]
}

/** Module id -> names of the characters that list it in their own modules. */
export function charactersByPairedModule(
    characters: readonly (PairCharacter | null | undefined)[],
): Map<string, string[]> {
    const pairs = new Map<string, string[]>()
    for (const character of characters) {
        if (!character?.modules?.length) continue
        const name = character.name || 'Unnamed'
        for (const id of new Set(character.modules)) {
            const names = pairs.get(id)
            if (names) names.push(name)
            else pairs.set(id, [name])
        }
    }
    return pairs
}

/** A bot's chain: red when one of its own modules no longer exists. */
export function characterModuleLink(
    character: PairCharacter | null | undefined,
    existingModuleIds: ReadonlySet<string>,
): ModuleLinkState | null {
    if (!character?.modules?.length) return null
    return character.modules.every((id) => existingModuleIds.has(id)) ? 'linked' : 'broken'
}

/**
 * Each module's chain. Green while a bot that is not in the trash lists it
 * (or a deactivated bot it was paired with still exists); red when it was
 * paired but every such bot is gone (deleted or in the trash). A bot deleted
 * now is a deactivated stub with trashedAt (characterArchive.ts), so that
 * stub is gone, not asleep (2026-10-20: it stayed green).
 */
export function moduleLinks(
    modules: readonly (PairModule | null | undefined)[],
    characters: readonly (PairCharacter | null | undefined)[],
    archived: readonly ({ chaId?: string, name?: string, trashedAt?: number } | null | undefined)[] = [],
): Map<string, ModuleLink> {
    const live = characters.filter((character): character is PairCharacter => !!character && !character.trashTime)
    const linked = charactersByPairedModule(live)
    const nameById = new Map<string, string>()
    for (const character of characters) if (character?.chaId) nameById.set(character.chaId, character.name || 'Unnamed')
    const archivedNames = new Map<string, string>()
    for (const stub of archived) {
        if (!stub?.chaId) continue
        if (stub.trashedAt) nameById.set(stub.chaId, stub.name || 'Unnamed')
        else archivedNames.set(stub.chaId, stub.name || 'Unnamed')
    }

    const links = new Map<string, ModuleLink>()
    for (const module of modules) {
        if (!module?.id) continue
        const names = linked.get(module.id)
        if (names) {
            links.set(module.id, { state: 'linked', names })
            continue
        }
        const recorded = module.nodeOnlyPairedCharacterIds ?? []
        if (recorded.length === 0) continue
        const sleeping = recorded.filter((id) => archivedNames.has(id)).map((id) => archivedNames.get(id)!)
        if (sleeping.length > 0) {
            links.set(module.id, { state: 'linked', names: sleeping })
            continue
        }
        links.set(module.id, { state: 'broken', names: recorded.map((id) => nameById.get(id) ?? '삭제된 봇') })
    }
    return links
}

/**
 * A module linked to the bot (the user's report, 2026-10-30: the new version
 * of a deleted asset module was linked, and the bot's chain stayed red): the
 * ids of its own modules that no longer exist go too, so the chain shows the
 * pairs it has now. True when any went.
 */
export function dropMissingBotModules(
    character: { modules?: string[] } | null | undefined,
    modules: readonly ({ id?: string } | null | undefined)[],
): boolean {
    if (!character?.modules?.length) return false
    const existing = new Set(modules.map((module) => module?.id).filter(Boolean))
    const kept = character.modules.filter((id) => existing.has(id))
    if (kept.length === character.modules.length) return false
    character.modules = kept
    return true
}

/** The bot's own modules that still exist, in its order (its menu's "연결된 모듈 찾기"). */
export function modulesOfBot<M extends { id: string }>(
    character: PairCharacter | null | undefined,
    modules: readonly (M | null | undefined)[],
): M[] {
    const byId = new Map<string, M>()
    for (const module of modules) if (module?.id) byId.set(module.id, module)
    return [...new Set(character?.modules ?? [])].map((id) => byId.get(id)).filter((module): module is M => !!module)
}

export interface PairedBot {
    chaId: string
    name: string
    /** Its place in db.characters, or -1 for a deactivated one. */
    index: number
    archived: boolean
}

/**
 * Bots that carry the module as their own (a module's menu's "연결된 봇
 * 찾기"): live ones that list it, then deactivated ones it was paired with.
 * None in the trash, the same bots that keep its chain green (moduleLinks).
 */
export function botsOfModule(
    module: PairModule | null | undefined,
    characters: readonly (PairCharacter | null | undefined)[],
    archived: readonly ({ chaId?: string, name?: string, trashedAt?: number } | null | undefined)[] = [],
): PairedBot[] {
    if (!module?.id) return []
    const bots: PairedBot[] = []
    characters.forEach((character, index) => {
        if (!character?.chaId || character.trashTime || !character.modules?.includes(module.id)) return
        bots.push({ chaId: character.chaId, name: character.name || 'Unnamed', index, archived: false })
    })
    const recorded = new Set(module.nodeOnlyPairedCharacterIds ?? [])
    for (const stub of archived) {
        if (!stub?.chaId || stub.trashedAt || !recorded.has(stub.chaId) || bots.some((bot) => bot.chaId === stub.chaId)) continue
        bots.push({ chaId: stub.chaId, name: stub.name || 'Unnamed', index: -1, archived: true })
    }
    return bots
}

/** Notes that the bot carries these modules as its own (pairing). */
export function recordModulePair(modules: PairModule[], moduleIds: readonly string[], chaId: string | undefined): void {
    if (!chaId) return
    for (const module of modules) {
        if (!moduleIds.includes(module.id)) continue
        const ids = module.nodeOnlyPairedCharacterIds ?? []
        if (!ids.includes(chaId)) module.nodeOnlyPairedCharacterIds = [...ids, chaId]
    }
}

/** The user took the module off the bot on purpose: no red chain for that pair. */
export function forgetModulePair(modules: PairModule[], moduleId: string, chaId: string | undefined): void {
    if (!chaId) return
    for (const module of modules) {
        if (module.id !== moduleId || !module.nodeOnlyPairedCharacterIds?.includes(chaId)) continue
        const ids = module.nodeOnlyPairedCharacterIds.filter((id) => id !== chaId)
        if (ids.length > 0) module.nodeOnlyPairedCharacterIds = ids
        else delete module.nodeOnlyPairedCharacterIds
    }
}

/** Load-time backfill: modules record the bots that list them (pairs made before the record existed). */
export function backfillModulePairs(modules: PairModule[] | undefined, characters: readonly (PairCharacter | null | undefined)[] | undefined): boolean {
    if (!modules?.length || !characters?.length) return false
    const byId = new Map(modules.map((module) => [module.id, module]))
    let changed = false
    for (const character of characters) {
        if (!character?.chaId || !character.modules?.length) continue
        for (const id of character.modules) {
            const module = byId.get(id)
            if (!module) continue
            const ids = module.nodeOnlyPairedCharacterIds ?? []
            if (ids.includes(character.chaId)) continue
            module.nodeOnlyPairedCharacterIds = [...ids, character.chaId]
            changed = true
        }
    }
    return changed
}

/**
 * A folder's "link every module to the open bot" (the user's request,
 * 2026-10-06): links the folder's modules the bot does not have yet, after
 * its own; when it already has them all, unlinks them all instead.
 */
export function folderBotLinkChange(botModules: readonly string[] | undefined, folderModules: readonly string[]): { modules: string[], linked: string[], unlinked: string[] } {
    const current = botModules ?? []
    const ids = [...new Set(folderModules)]
    if (ids.length > 0 && ids.every((id) => current.includes(id))) {
        return { modules: current.filter((id) => !ids.includes(id)), linked: [], unlinked: ids }
    }
    const linked = ids.filter((id) => !current.includes(id))
    return { modules: [...current, ...linked], linked, unlinked: [] }
}
