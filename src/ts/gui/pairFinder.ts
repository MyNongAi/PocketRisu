// From a bot's menu to its own modules, and from a module's menu to the bots
// that carry it (the chain, pairedModules.ts; the user's request, 2026-10-20).
// Several: a list to pick one. A module is found by opening the module page
// searched to its name with its row marked (ModuleSettings reads
// moduleFindRequest); a bot by opening it and scrolling the bot list to it.
import { writable } from 'svelte/store'
import { language } from '../../lang'
import { alertSelect } from '../alert'
import { promptActivateCharacter } from '../characterArchive'
import { changeChar } from '../characters'
import { openSettings, SettingsRoute } from '../routing'
import { DBState, QuickSettings, settingsOpen, sideBarStore } from '../stores.svelte'
import { botsOfModule, modulesOfBot } from './pairedModules'

/** The module the module page should find (it takes and clears this). */
export const moduleFindRequest = writable<string | null>(null)

// The module list of the sidebar's module tab, when it is on screen, finds
// the module in place instead of the module page (the user's request,
// 2026-10-27). Each such list registers here and says whether it took it.
// Since 2026-10-28 any bot menu finds it there whatever is open: the sidebar
// opens on its module tab first (the user's request).
const panelFinders = new Set<(moduleId: string) => boolean>()

export function addModulePanelFinder(find: (moduleId: string) => boolean): () => void {
    panelFinders.add(find)
    return () => { panelFinders.delete(find) }
}

async function pick<T>(items: T[], label: (item: T) => string, prompt: string): Promise<T | null> {
    if (items.length <= 1) return items[0] ?? null
    const selected = Number.parseInt(await alertSelect([...items.map(label), language.cancel], prompt))
    return Number.isInteger(selected) && selected >= 0 && selected < items.length ? items[selected] : null
}

/** The bot's own modules that still exist (its menu shows "연결된 모듈 찾기" for them). */
export function botHasModules(chaId: string | undefined): boolean {
    const character = DBState.db.characters.find((c) => c?.chaId === chaId)
    return modulesOfBot(character, DBState.db.modules).length > 0
}

const SIDEBAR_WAIT_MS = 3000
const SIDEBAR_POLL_MS = 50

function openSidebarModuleTab() {
    settingsOpen.set(false)
    sideBarStore.set(true)
    QuickSettings.open = true
    QuickSettings.index = 2
}

/** The sidebar's module list takes the find, opened on its tab when it is not on screen (it mounts on the tab's first opening). */
export async function findInSidebar(moduleId: string, wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<boolean> {
    const take = () => [...panelFinders].some((find) => find(moduleId))
    if (take()) return true
    openSidebarModuleTab()
    for (let waited = 0; waited < SIDEBAR_WAIT_MS; waited += SIDEBAR_POLL_MS) {
        await wait(SIDEBAR_POLL_MS)
        if (take()) return true
    }
    return false
}

export async function findModulesOfBot(chaId: string): Promise<void> {
    const character = DBState.db.characters.find((c) => c?.chaId === chaId)
    const module = await pick(modulesOfBot(character, DBState.db.modules), (m) => m.name || 'Unnamed', language.pairFindWhichModule)
    if (!module) return
    if (await findInSidebar(module.id)) return
    // The sidebar's list declines while it shows a module's editor (its
    // unsaved draft stays): the module page then.
    moduleFindRequest.set(module.id)
    openSettings(SettingsRoute.Module)
}

export async function findBotsOfModule(moduleId: string): Promise<void> {
    const module = DBState.db.modules.find((m) => m?.id === moduleId)
    const bots = botsOfModule(module, DBState.db.characters, DBState.db.nodeOnlyArchivedCharacters ?? [])
    const bot = await pick(bots, (b) => b.archived ? `${b.name} (${language.pairFindAsleep})` : b.name, language.pairFindWhichBot)
    if (!bot) return
    if (bot.archived) {
        if (!await promptActivateCharacter(bot.chaId)) return
    } else {
        const index = DBState.db.characters.findIndex((c) => c?.chaId === bot.chaId)
        if (index < 0) return
        changeChar(index)
    }
    settingsOpen.set(false)
    // The bot list is back once settings close; then it opens the bot's folders and scrolls.
    setTimeout(() => window.dispatchEvent(new CustomEvent('scrollToActiveCharacter')), 200)
}
