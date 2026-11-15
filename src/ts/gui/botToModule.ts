// A bot dropped on the sidebar's Module tab becomes a new module (the user's
// request, 2026-11-08). The same conversion as the character settings'
// "Convert to module" button (CharConfig.svelte); the bot itself stays.
import { language } from 'src/lang'
import { alertError, notifyError, notifySuccess } from 'src/ts/alert'
import { hydrateCharacterAssets } from 'src/ts/characterCards'
import { convertCharacterToModule } from 'src/ts/interchangeability'
import { addModuleToDatabase, type RisuModule } from 'src/ts/process/modules'
import { getDatabase } from 'src/ts/storage/database.svelte'
import { writable } from 'svelte/store'

const converting = new Set<string>()

// The bot lifted in any piece of the sidebar. In the PC split the bot list
// ('rail') and the panel holding the Module tab are separate Sidebar
// instances, each with its own drag state, so a bot lifted in the list never
// lit the tab or reached it (the user's request, 2026-11-15). `over`: a touch
// drag's finger is on a Module tab.
export type LiftedBot = { id: string, over: boolean }
export const liftedBot = writable<LiftedBot | null>(null)

/**
 * The bot a drag over a Module tab carries: this sidebar's own drag first,
 * else one lifted in another piece of the sidebar (only while the browser
 * drag is a sidebar one). null for a folder or anything else.
 */
export function moduleDropBot(
    local: { kind: string, id: string } | null,
    lifted: LiftedBot | null,
    sidebarDrag: boolean,
): string | null {
    if (local) return local.kind === 'character' ? local.id : null
    return sidebarDrag && lifted ? lifted.id : null
}

/** Bot `chaId` copied into a new module; null when it was not (said in a toast). */
export async function convertBotToModule(chaId: string): Promise<RisuModule | null> {
    if (!chaId || converting.has(chaId)) return null
    const char = getDatabase().characters.find((c) => c?.chaId === chaId)
    if (!char) return null
    // A bot's `type` is optional and often absent (an imported card); only a
    // group chat from older data says 'group' (no longer in the types).
    if ((char as { type?: string }).type === 'group') {
        notifyError(language.botToModuleGroup)
        return null
    }
    converting.add(chaId)
    try {
        // Hydrate first: a copied manifest descriptor would make the module
        // and the bot edit one shared asset list.
        const module = convertCharacterToModule(await hydrateCharacterAssets(char))
        addModuleToDatabase(module)
        notifySuccess(language.botToModuleDone.replace('{}', module.name || 'Unnamed'))
        return module
    } catch (error) {
        alertError(`${error}`)
        return null
    } finally {
        converting.delete(chaId)
    }
}
