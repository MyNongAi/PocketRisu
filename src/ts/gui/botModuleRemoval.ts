// A bot's menu "연결된 모듈과 같이 삭제" (the user's request, 2026-10-22):
// the bot goes to the trash as with "삭제", and the modules linked to it
// (character.modules, the green chain) go with it, but only those nothing
// else uses. Modules have no trash, so a module another bot, the global
// list or a prompt preset still turns on stays.

import type { RisuModule } from '../process/modules'
import { referencedModuleNames } from '../process/moduleCold.svelte'
import { modulesOfBot } from './pairedModules'

type BotDb = Omit<Parameters<typeof referencedModuleNames>[0], 'characters'> & {
    characters?: readonly ({ chaId?: string, modules?: readonly string[], chats?: readonly ({ modules?: readonly string[] } | null | undefined)[] } | null | undefined)[]
    modules?: readonly (RisuModule | null | undefined)[]
    nodeOnlyArchivedCharacters?: readonly ({ chaId?: string } | null | undefined)[]
}

/** The bot's linked modules: those only it uses, and those something else uses too. */
export function splitBotModules(db: BotDb, chaId: string): { only: RisuModule[], shared: RisuModule[] } {
    const character = db.characters?.find((c) => c?.chaId === chaId)
    const linked = modulesOfBot(character, db.modules ?? [])
    const otherCharacters = (db.characters ?? []).filter((c) => c?.chaId !== chaId)
    // Everything else that turns modules on, this bot and its chats left out.
    const names = referencedModuleNames({ ...db, characters: otherCharacters })
    // Deactivated bots keep no module list here; the module remembers them.
    const otherBots = new Set<string>()
    for (const c of otherCharacters) if (c?.chaId) otherBots.add(c.chaId)
    for (const stub of db.nodeOnlyArchivedCharacters ?? []) if (stub?.chaId && stub.chaId !== chaId) otherBots.add(stub.chaId)
    const only: RisuModule[] = []
    const shared: RisuModule[] = []
    for (const module of linked) {
        const used = names.has(module.id)
            || (!!module.namespace && names.has(module.namespace))
            || (module.nodeOnlyPairedCharacterIds ?? []).some((id) => otherBots.has(id))
        ;(used ? shared : only).push(module)
    }
    return { only, shared }
}

/** Ask, put the bot in the trash, then delete the modules only it used. */
export async function removeBotWithModules(chaId: string): Promise<void> {
    const [{ DBState }, { language }, { alertConfirm, alertError, notifySuccess }, { removeChar }, { removeModulesFromDatabase }] = await Promise.all([
        import('../stores.svelte'),
        import('../../lang'),
        import('../alert'),
        import('../characters'),
        import('../process/moduleRemoval'),
    ])
    const character = DBState.db.characters.find((c) => c?.chaId === chaId)
    if (!character) return
    const name = character.name || 'Unnamed'
    const { only, shared } = splitBotModules(DBState.db, chaId)
    const label = (module: RisuModule) => module.name || 'Unnamed'
    if (!await alertConfirm(language.removeWithModulesConfirm(name, only.map(label), shared.map(label)))) return
    try {
        await removeChar(chaId, name, 'normal', { skipConfirm: true })
    } catch (error) {
        alertError(language.deactivateCharacterFailed + (error instanceof Error ? error.message : String(error)))
        return
    }
    // Still listed: the trash did not take it, so its modules stay too.
    if (DBState.db.characters.some((c) => c?.chaId === chaId)) return
    const removed = removeModulesFromDatabase(new Set(only.map((module) => module.id)))
    notifySuccess(language.removeWithModulesDone(name, removed))
}
