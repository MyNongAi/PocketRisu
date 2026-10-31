// A link dragged in from another page or app imports the way the Proton box
// imports a pasted link (the user's request, 2026-10-31): a Realm address
// brings the bot, a Proton Drive share link its files. Dropped on the module
// page they come in as modules, as that page's Proton box takes them.
// The box's last resort, opening the link and picking the downloaded files,
// needs a click, so a link neither can import says so instead.
import { language } from 'src/lang'
import { notifyWarning } from './alert'

export async function importDroppedLink(url: string, destination: 'character' | 'module'): Promise<boolean> {
    const imported = destination === 'module'
        ? await (await import('./process/modules')).importModuleLink(url)
        : await (await import('./characters')).importCharacterLink(url)
    if (!imported) notifyWarning(language.linkDropUnsupported)
    return imported
}
