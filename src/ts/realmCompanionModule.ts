// Realm companion modules. A Realm card whose description links a Proton
// Drive share almost always links the bot's own asset module. After
// downloadRisuHub imports the character, the module behind that link comes in
// through the server's Proton pipeline and is paired with the character
// (character.modules), so it switches on in that bot's chats only. A link to
// one RISUM or *.module.charx imports it by itself; a folder, or any other
// file, opens the same Proton browser a pasted folder link does, and the
// modules picked there are paired.
// A module already downloaded from the same link is paired again instead of
// being downloaded twice.
import { recordModulePair } from './gui/pairedModules'
import { language } from 'src/lang'
import { notifyError, notifySuccess } from './alert'
import { runImportTask, type ImportProgressReporter } from './importProgress'
import { isImportCancelled } from './importTransaction'
import { importModuleFile, rerenderChatForModules, syncLinkedFolders, type RisuModule } from './process/modules'
import { downloadProtonEntry, inspectProtonShare, isProtonPasswordRequired, type ProtonInspectResult } from './protonShareClient'
import { getDatabase } from './storage/database.svelte'

const PROTON_HOSTS = new Set(['drive.proton.me', 'drive.proton.ch'])

// A card description can link several shares; more than this is not a
// companion module but a list, and is left to the user.
const MAX_LINKS = 3

/**
 * Public Proton Drive share links in `text`, normalized (no query, no trailing
 * slash) and deduplicated, in order. Only https://drive.proton.me/urls/<id>#<key>
 * counts: without the key after '#' the share cannot be decrypted.
 */
export function findProtonShareLinks(text: string): string[] {
    const links: string[] = []
    for (const candidate of text.match(/https:\/\/[^\s<>"'`)\]]+/gi) ?? []) {
        try {
            const url = new URL(candidate.replace(/[)\]},.;!?]+$/, ''))
            if (url.protocol !== 'https:' || !PROTON_HOSTS.has(url.hostname)
                || url.port || url.username || url.password
                || !/^\/urls\/[A-Za-z0-9]+\/?$/.test(url.pathname)
                || !/^#[A-Za-z0-9_-]+$/.test(url.hash)) continue
            url.search = ''
            url.pathname = url.pathname.replace(/\/$/, '')
            if (!links.includes(url.href)) links.push(url.href)
        } catch { /* not a usable share URL */ }
    }
    return links
}

/**
 * Whether a shared file is plainly a module, downloaded without asking: a
 * RISUM, or a CHARX named `*.module.charx` (how modules are exported as
 * CHARX). Any other file opens in the Proton browser instead (the user
 * picks it, or closes the browser), the way a folder does: a name like
 * "… Image Module.charx" was taken for the bot and silently skipped.
 */
export function isCompanionModuleFile(name: string): boolean {
    const lower = name.toLocaleLowerCase()
    return lower.endsWith('.risum') || lower.endsWith('.module.charx')
}

/** Adds module ids to a character's own modules (character.modules), keeping order and no duplicates. */
export function pairModulesWithCharacter(character: { modules?: string[] }, moduleIds: readonly string[]): number {
    const current = character.modules ?? []
    const added = [...new Set(moduleIds)].filter((id) => !current.includes(id))
    if (added.length > 0) character.modules = [...current, ...added]
    return added.length
}

async function downloadShareModules(link: string, report: ImportProgressReporter): Promise<RisuModule[]> {
    let password = ''
    let share: ProtonInspectResult
    try {
        share = await inspectProtonShare(link, password)
    } catch (error) {
        if (!isProtonPasswordRequired(error)) throw error
        // The owner put a password on the link: ask for it; cancel skips this link.
        const { openProtonShare } = await import('./protonImport')
        const opened = await openProtonShare(link, '', `${language.realmCompanionModuleTask}\n${link}`)
        if (!opened) return []
        share = opened.info
        password = opened.password
    }
    const modules: RisuModule[] = []
    const keep = (module: RisuModule) => {
        module.nodeOnlyProtonShare = link
        modules.push(module)
    }
    if (share.kind === 'folder' || !isCompanionModuleFile(share.name)) {
        // A folder, or a file that is not plainly a module, opens the same
        // browser a pasted folder link does; what the user picks imports as
        // modules, and those modules are paired.
        const { importProtonShare } = await import('./protonImport')
        await importProtonShare(link, password, share, 'module', keep, { browse: true })
        return modules
    }
    // A plain module file downloads and imports by itself.
    const file = await downloadProtonEntry(link, password, { path: [], expectedSize: share.entries[0]?.size ?? null }, report)
    const module = await importModuleFile(file, { suppressSuccess: true, onProgress: report })
    if (module) {
        // The browser path records this itself (importProtonShare).
        module.nodeOnlyProtonSource ??= { link, file: share.name, at: Date.now() }
        keep(module)
    }
    return modules
}

/**
 * Imports the modules behind `links` (reusing ones already downloaded from the
 * same share) and pairs them with the characters `pairWith(chaIds)` returns,
 * looked up after the downloads. Returns the module ids, and how many pairings
 * were added. Runs as its own background import task.
 */
async function importCompanionModules(
    links: readonly string[],
    pairWith: () => readonly { chaId?: string, modules?: string[] }[],
): Promise<{ moduleIds: string[], paired: number }> {
    return runImportTask(language.realmCompanionModuleTask, async (report) => {
        const moduleIds: string[] = []
        for (const link of links) {
            const existing = getDatabase().modules.filter((module) => module.nodeOnlyProtonShare === link)
            if (existing.length > 0) {
                moduleIds.push(...existing.map((module) => module.id))
                continue
            }
            report({ label: language.importProgress.importing, progress: null })
            moduleIds.push(...(await downloadShareModules(link, report)).map((module) => module.id))
        }
        let paired = 0
        for (const character of pairWith()) {
            paired += pairModulesWithCharacter(character, moduleIds)
            recordModulePair(getDatabase().modules, moduleIds, character.chaId)
        }
        if (paired > 0) {
            syncLinkedFolders()
            rerenderChatForModules()
        }
        return { moduleIds, paired }
    })
}

function reportFailure(error: unknown) {
    notifyError(`${language.realmCompanionModuleFailed}: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * Downloads and pairs the companion modules linked in `texts` (the Realm
 * description and the card's creator notes) with the character `chaId`, right
 * after a Realm download imported it. Quiet when there is nothing to fetch;
 * failures are reported, never thrown.
 */
export async function importRealmCompanionModules(chaId: string, texts: readonly (string | undefined)[]): Promise<void> {
    const links = findProtonShareLinks(texts.filter(Boolean).join('\n'))
    if (links.length === 0 || links.length > MAX_LINKS) return
    try {
        // Look the character up after the downloads: the list may have changed.
        const { paired } = await importCompanionModules(links, () => getDatabase().characters.filter((c) => c?.chaId === chaId))
        if (paired > 0) notifySuccess(language.realmCompanionModulePaired(paired))
    } catch (error) {
        // The user cancelled a large module from its progress card.
        if (!isImportCancelled(error)) reportFailure(error)
    }
}
