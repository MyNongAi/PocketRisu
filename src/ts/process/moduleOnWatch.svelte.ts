// 최근순 lifts a module when it is turned on. The list's own buttons record
// that (rememberActivation), but a module also comes on by itself: the open
// bot's own modules and the prompt preset's (moduleIntergration) are drawn
// orange as soon as another bot or preset is picked, and a chat's own
// modules as soon as that chat is opened. Those stayed where they were; the
// user's rule (2026-10-27): "주황이든 파랑이든 활성화되면 최상단".

import { untrack } from 'svelte'
import { DBState, selIdState } from '../stores.svelte'
import { recordModuleActivation, recordModuleFolderActivation, seedModuleActivationHistory, type SortableModule, type SortableModuleFolder } from './moduleSort'

export interface ModuleOnDb {
    modules: ReadonlyArray<SortableModule & { namespace?: string }>
    moduleFolders?: SortableModuleFolder[]
    enabledModules: ReadonlyArray<string>
    moduleIntergration?: string
    moduleActivationHistory?: string[]
    characters: ReadonlyArray<{ modules?: ReadonlyArray<string>, chats?: ReadonlyArray<{ modules?: ReadonlyArray<string> } | undefined>, chatPage?: number } | undefined>
}

/** Every module on for the open chat: everywhere (blue), in this chat, the bot's own or the preset's (orange). */
export function modulesOnNow(db: ModuleOnDb, characterIndex: number): string[] {
    const character = db.characters[characterIndex]
    const chat = character?.chats?.[character.chatPage ?? 0]
    const namespaces = (db.moduleIntergration ?? '').split(',').map((name) => name.trim()).filter(Boolean)
    const integrated = namespaces.length === 0 ? [] : db.modules
        .filter((module) => !!module?.namespace && namespaces.includes(module.namespace))
        .map((module) => module.id)
    return [...new Set([...db.enabledModules, ...(chat?.modules ?? []), ...(character?.modules ?? []), ...integrated])]
}

/** The ids in `next` that `previous` did not have. */
export function modulesTurnedOn(previous: ReadonlyArray<string>, next: ReadonlyArray<string>): string[] {
    const before = new Set(previous)
    return next.filter((id) => !before.has(id))
}

/** Records `ids` as just turned on, the first one newest, and lifts their folders with them. */
export function liftModulesTurnedOn(db: ModuleOnDb, ids: ReadonlyArray<string>): void {
    const known = new Set(db.modules.map((module) => module?.id))
    let history = seedModuleActivationHistory(db.moduleActivationHistory, db.enabledModules)
    let folders = db.moduleFolders ?? []
    for (const id of [...ids].reverse()) {
        if (!known.has(id)) continue
        history = recordModuleActivation(history, id)
        folders = recordModuleFolderActivation(folders, db.modules, id, { activationHistory: history })
    }
    db.moduleActivationHistory = history
    db.moduleFolders = folders
}

/** Watches what is on for the open chat and lifts what comes on; the state at start is the baseline. */
export function startModuleOnWatch(): () => void {
    return $effect.root(() => {
        let previous: string[] | null = null
        $effect(() => {
            const db = DBState.db as unknown as ModuleOnDb | undefined
            if (!db?.modules) return
            const now = modulesOnNow(db, selIdState.selId)
            untrack(() => {
                const turnedOn = previous ? modulesTurnedOn(previous, now) : []
                previous = now
                if (turnedOn.length > 0) liftModulesTurnedOn(db, turnedOn)
            })
        })
    })
}
