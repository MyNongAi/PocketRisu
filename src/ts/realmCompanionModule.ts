// Realm companion modules. A Realm card whose description links a Proton
// Drive share almost always links the bot's own asset module. After
// downloadRisuHub imports the character, the module files behind that link
// are downloaded through the server's Proton pipeline, imported, and paired
// with the character (character.modules), so they switch on in that bot's
// chats only. A module already downloaded from the same link is paired again
// instead of being downloaded twice.
import { language } from 'src/lang'
import { notifyError, notifySuccess } from './alert'
import { runImportTask, type ImportProgressReporter } from './importProgress'
import { importModuleFile, type RisuModule } from './process/modules'
import { downloadProtonEntry, inspectProtonShare, isProtonPasswordRequired, type ProtonEntry, type ProtonInspectResult } from './protonShareClient'
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
 * Whether a shared file is a module: a RISUM, or a CHARX named
 * `*.module.charx` (how modules are exported as CHARX). A plain CHARX or PNG
 * is the bot itself, which the Realm download already imported.
 */
export function isCompanionModuleFile(name: string): boolean {
    const lower = name.toLocaleLowerCase()
    return lower.endsWith('.risum') || lower.endsWith('.module.charx')
}

/** The module files a share holds: the shared file itself, or those at the top of a shared folder. */
export function pickCompanionModuleEntries(share: { kind: 'file' | 'folder', name: string, entries: ProtonEntry[] }): ProtonEntry[] | 'file' {
    if (share.kind === 'file') return isCompanionModuleFile(share.name) ? 'file' : []
    return share.entries.filter((entry) => entry.type === 2 && isCompanionModuleFile(entry.name))
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
    const picked = pickCompanionModuleEntries(share)
    const targets = picked === 'file'
        ? [{ path: [] as string[], expectedSize: share.entries[0]?.size ?? null }]
        : picked.map((entry) => ({ linkId: entry.linkId, expectedSize: entry.size }))
    const modules: RisuModule[] = []
    for (const target of targets) {
        const file = await downloadProtonEntry(link, password, target, report)
        const module = await importModuleFile(file, { suppressSuccess: true, onProgress: report })
        if (!module) continue
        module.nodeOnlyProtonShare = link
        modules.push(module)
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
    pairWith: () => readonly { modules?: string[] }[],
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
        for (const character of pairWith()) paired += pairModulesWithCharacter(character, moduleIds)
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
        reportFailure(error)
    }
}
