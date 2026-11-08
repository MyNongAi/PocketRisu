// A bot dropped on the sidebar's Module tab becomes a new module (the user's
// request, 2026-11-08). The same conversion as the character settings'
// "Convert to module" button (CharConfig.svelte); the bot itself stays.
import { language } from 'src/lang'
import { alertError, notifyError, notifySuccess } from 'src/ts/alert'
import { hydrateCharacterAssets } from 'src/ts/characterCards'
import { convertCharacterToModule } from 'src/ts/interchangeability'
import { addModuleToDatabase, type RisuModule } from 'src/ts/process/modules'
import { getDatabase } from 'src/ts/storage/database.svelte'

const converting = new Set<string>()

/** Bot `chaId` copied into a new module; null when it was not (said in a toast). */
export async function convertBotToModule(chaId: string): Promise<RisuModule | null> {
    if (!chaId || converting.has(chaId)) return null
    const char = getDatabase().characters.find((c) => c?.chaId === chaId)
    if (!char) return null
    if (char.type !== 'character') {
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
