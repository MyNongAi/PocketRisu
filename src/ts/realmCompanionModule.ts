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
// The same pairing runs for a Proton link clicked in a bot's creator notes
// (openBotNotesProtonLink), always through the browser.
import { recordModulePair } from './gui/pairedModules'
import { language } from 'src/lang'
import { alertSelect, notifyError, notifySuccess } from './alert'
import { runImportTask, type ImportProgressReporter } from './importProgress'
import { isImportCancelled } from './importTransaction'
import { importModuleFile, rerenderChatForModules, syncLinkedFolders, type RisuModule } from './process/modules'
import { inspectProtonShare, isProtonPasswordRequired, type ProtonInspectResult } from './protonShareClient'
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

// One progress card per module file, named for what it came for (the user's
// request, 2026-10-22: a "렐름 전용 모듈" card stood idle beside the file's
// own card for the whole import).
const taskNameFor = (label: string) => (fileName: string) => `${label} · ${fileName}`

type ShareDownload = {
    /** Open the browser for a plain module file too (a link the user clicked). */
    browse?: boolean
    /** What the cards and the password prompt call it. */
    label?: string
}

async function downloadShareModules(link: string, options: ShareDownload = {}): Promise<RisuModule[]> {
    const label = options.label ?? language.realmCompanionModuleTask
    const companionTaskName = taskNameFor(label)
    let password = ''
    let share: ProtonInspectResult
    try {
        share = await inspectProtonShare(link, password)
    } catch (error) {
        if (!isProtonPasswordRequired(error)) throw error
        // The owner put a password on the link: ask for it; cancel skips this link.
        const { openProtonShare } = await import('./protonImport')
        const opened = await openProtonShare(link, '', `${label}\n${link}`)
        if (!opened) return []
        share = opened.info
        password = opened.password
    }
    const modules: RisuModule[] = []
    const keep = (module: RisuModule) => {
        module.nodeOnlyProtonShare = link
        modules.push(module)
    }
    if (options.browse || share.kind === 'folder' || !isCompanionModuleFile(share.name)) {
        // A folder, or a file that is not plainly a module, opens the same
        // browser a pasted folder link does; what the user picks imports as
        // modules, and those modules are paired.
        const { importProtonShare } = await import('./protonImport')
        await importProtonShare(link, password, share, 'module', keep, { browse: true, taskName: companionTaskName })
        return modules
    }
    // A plain module file downloads and imports by itself, on its own card
    // (unpacked on the server, so its assets never pass through this page).
    const { fetchProtonFile, importProtonFile } = await import('./protonImport')
    const module = await runImportTask(companionTaskName(share.name), async (report: ImportProgressReporter) => {
        const file = await fetchProtonFile(link, password, { path: [], expectedSize: share.entries[0]?.size ?? null }, report)
        return importProtonFile(file, report, (importScope) =>
            importModuleFile(file, { suppressSuccess: true, onProgress: report, importScope }))
    })
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
 * were added. Each module file shows its own import card.
 */
async function importCompanionModules(
    links: readonly string[],
    pairWith: () => readonly { chaId?: string, modules?: string[] }[],
): Promise<{ moduleIds: string[], paired: number }> {
    const moduleIds: string[] = []
    for (const link of links) {
        const existing = getDatabase().modules.filter((module) => module.nodeOnlyProtonShare === link)
        if (existing.length > 0) {
            moduleIds.push(...existing.map((module) => module.id))
            continue
        }
        moduleIds.push(...(await downloadShareModules(link)).map((module) => module.id))
    }
    return { moduleIds, paired: pairWithBots(moduleIds, pairWith()) }
}

/** Pairs `moduleIds` with `characters`; returns how many pairings were added. */
function pairWithBots(moduleIds: readonly string[], characters: readonly { chaId?: string, modules?: string[] }[]): number {
    let paired = 0
    for (const character of characters) {
        paired += pairModulesWithCharacter(character, moduleIds)
        recordModulePair(getDatabase().modules, moduleIds, character.chaId)
    }
    if (paired > 0) {
        syncLinkedFolders()
        rerenderChatForModules()
    }
    return paired
}

function reportFailure(error: unknown, label = language.realmCompanionModuleFailed) {
    notifyError(`${label}: ${error instanceof Error ? error.message : String(error)}`)
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

/**
 * A Proton share link clicked in a bot's creator notes (the user's request,
 * 2026-10-22): the share opens in the Proton browser, a single file too, and
 * what the user imports there comes in as modules paired with the bot.
 * Failures are reported, never thrown.
 */
export async function openBotNotesProtonLink(chaId: string, link: string): Promise<void> {
    try {
        const modules = await downloadShareModules(link, { browse: true, label: language.botNotesModuleTask })
        // Look the character up after the import: the list may have changed.
        const paired = pairWithBots(modules.map((module) => module.id), getDatabase().characters.filter((c) => c?.chaId === chaId))
        if (paired > 0) notifySuccess(language.botNotesModulePaired(paired))
    } catch (error) {
        if (!isImportCancelled(error)) reportFailure(error, language.botNotesModuleFailed)
    }
}

/** A line of a description as a picker label: its words, without links or markdown marks. */
function linkLineLabel(line: string): string {
    return line
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]*>/g, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/[*_`#>|~]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[\s:：\-–—→=]+$/, '')
        .trim()
        .slice(0, 60)
}

/** The words naming the link on line `at`: that line's, or the line above it when the link stands alone. */
function linkLabelAt(lines: readonly string[], at: number): string {
    if (at < 0) return ''
    const own = linkLineLabel(lines[at])
    if (own) return own
    for (let i = at - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue
        return /https?:\/\//i.test(lines[i]) ? '' : linkLineLabel(lines[i])
    }
    return ''
}

/**
 * Every Proton share link in `text`, each named for a picker by the words on
 * its line ("에셋 모듈: <link>" is "에셋 모듈"), or on the line above when it
 * stands alone, else by its number. Unlike the automatic download there is no
 * cap: the user picks.
 */
export function protonLinkChoices(text: string): { link: string, label: string }[] {
    const lines = text.split(/\r?\n/)
    const seen = new Map<string, number>()
    return findProtonShareLinks(text).map((link, index) => {
        const path = new URL(link).pathname
        const label = linkLabelAt(lines, lines.findIndex((line) => line.includes(path))) || language.realmModuleLinkN(index + 1)
        const count = (seen.get(label) ?? 0) + 1
        seen.set(label, count)
        return { link, label: count > 1 ? `${label} (${count})` : label }
    })
}

/**
 * The Realm window's module button (the user's request, 2026-10-22): the
 * modules behind a Proton link in a Realm description, without downloading
 * the bot, for a bot downloaded before, an automatic download that failed, or
 * a description with more links than it takes. With several links the user
 * picks one first. The share opens in the Proton browser, a single file too;
 * what is imported pairs with `pairWith()` (the bots already downloaded from
 * this Realm card), looked up afterwards. Failures are reported, never thrown.
 */
export async function importRealmDescriptionModules(
    description: string,
    pairWith: () => readonly { chaId?: string, modules?: string[] }[],
): Promise<void> {
    const choices = protonLinkChoices(description)
    if (choices.length === 0) return
    let link = choices[0].link
    if (choices.length > 1) {
        const selected = Number.parseInt(await alertSelect([...choices.map((choice) => choice.label), language.cancel], language.realmModulePickLink))
        if (!Number.isInteger(selected) || selected < 0 || selected >= choices.length) return
        link = choices[selected].link
    }
    try {
        const modules = await downloadShareModules(link, { browse: true })
        if (modules.length === 0) return
        const paired = pairWithBots(modules.map((module) => module.id), pairWith())
        notifySuccess(paired > 0 ? language.botNotesModulePaired(paired) : language.realmModuleImported(modules.length))
    } catch (error) {
        if (!isImportCancelled(error)) reportFailure(error)
    }
}

/** The Proton share an anchor in rendered notes points at, or null. */
export function protonShareLinkOf(anchor: Element | null): string | null {
    const href = anchor?.getAttribute('href')
    return href ? findProtonShareLinks(href)[0] ?? null : null
}
