// Test helper for the sidebar toggle list (Toggles.svelte) component tests.
//
// The database is a real Svelte 5 `$state` proxy, so the tests mutate it
// through the same deep proxies the app does (push/splice/assign), and the
// component's `$derived` sees exactly the dependencies it would in the app.
import { DBState, moduleTreeRevision } from 'src/ts/stores.svelte'
import { trackModuleTreeChanges } from 'src/ts/process/moduleChangeTracker.svelte'
import { refreshModules } from 'src/ts/process/modules'
import { cloneModuleDraft } from 'src/ts/process/moduleDraft'
import type { Database } from 'src/ts/storage/database.svelte'

export const PERVENTIA_ID = 'perventia-module'
export const PERVENTIA_NAME = 'Perventia'
export const PERVENTIA_LABEL = 'Perventia mode'
export const PERVENTIA_TOGGLES = 'perventia_mode=Perventia mode\nperventia_style=Perventia style=select=Soft,Hard'
export const PERVENTIA_FOLDER_ID = 'perventia-folder'

type TogglesTestDbOverrides = Record<string, unknown> & {
    characterModules?: string[]
    chatModules?: string[]
    bindedPersona?: string
}

export function createTogglesTestDb(overrides: TogglesTestDbOverrides = {}): Database {
    const { characterModules, chatModules, bindedPersona, ...rootOverrides } = overrides
    const chat: Record<string, unknown> = {
        message: [], note: '', name: 'Chat 1', localLore: [], fmIndex: -1, id: 'chat-1',
    }
    if (chatModules) chat.modules = chatModules
    if (bindedPersona) chat.bindedPersona = bindedPersona
    const character: Record<string, unknown> = {
        chaId: 'char-1', name: 'Test character', type: 'character', chatPage: 0,
        desc: '', firstMessage: '', customModuleToggle: '',
        chats: [chat],
        emotionImages: [], alternateGreetings: [], chatFolders: [],
        additionalAssets: [], globalLore: [], customscript: [], triggerscript: [],
    }
    if (characterModules) character.modules = characterModules
    const db = $state({
        characters: [character],
        modules: [
            { id: 'other-module', name: 'Other', description: '' },
            {
                id: PERVENTIA_ID, name: PERVENTIA_NAME, description: '',
                customModuleToggle: PERVENTIA_TOGGLES, folderId: PERVENTIA_FOLDER_ID,
            },
        ],
        moduleFolders: [{ id: PERVENTIA_FOLDER_ID, name: 'Perventia pack', moduleIds: [PERVENTIA_ID] }],
        enabledModules: [],
        moduleIntergration: '',
        customPromptTemplateToggle: '',
        globalChatVariables: {},
        personas: [],
        selectedPersona: 0,
        disableToggleBinding: true,
        jailbreak: '',
        ...rootOverrides,
    })
    return db as unknown as Database
}

/** Installs a fresh `$state` database as the app database and returns it. */
export function useTogglesTestDb(overrides: TogglesTestDbOverrides = {}): Database {
    refreshModules()
    DBState.db = createTogglesTestDb(overrides)
    return DBState.db
}

/** Saves a module the way ModuleSettings' editor does: the slot is replaced. */
export function saveModuleLikeEditor(moduleId: string, patch: Record<string, unknown>): void {
    const index = DBState.db.modules.findIndex((module) => module.id === moduleId)
    DBState.db.modules[index] = cloneModuleDraft({
        ...$state.snapshot(DBState.db.modules[index]),
        ...patch,
    })
}

/**
 * The module-tree side of saveDb (globalApi.svelte.ts): replacing or
 * restructuring db.modules clears getModules()'s cache and bumps the revision.
 */
export function startModuleTreeTracker(): () => void {
    return $effect.root(() => {
        trackModuleTreeChanges(() => DBState.db.modules, (change) => {
            if (change.kind === 'structure' || change.replaced || change.routingChanged) {
                refreshModules()
            }
            moduleTreeRevision.value += 1
        })
    })
}
