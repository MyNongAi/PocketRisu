// Stored modules ("보관한 모듈", server/node/module-cold-store.cjs).
//
// A module nothing uses keeps its catalog entry in db.modules (name, folder,
// favorite, asset list, links) while its body — lorebook, regex, triggers,
// Lua, background HTML, toggles — waits on the server. The catalog shows it
// as usual; opening it fetches the body into the editor without changing
// the database, and the body comes back into db.modules only when the module
// is saved from the editor, turned on, linked, or asked for by getModules
// (a chat using it, a send). A sweep after boot stores the modules nothing
// uses (setting nodeOnlyColdModules, on unless turned off).

import { tick } from 'svelte'
import { get } from 'svelte/store'
import type { RisuModule } from './modules'
import { DBState, selectedCharID } from '../stores.svelte'
import { isNodeServer } from '../platform'
import type { ColdModuleBody, NodeStorage } from '../storage/nodeStorage'

export const COLD_MARKER = 'nodeOnlyColdModule'
/** Mirrors COLD_BODY_FIELDS in module-cold-store.cjs. */
export const COLD_BODY_FIELDS = ['lorebook', 'regex', 'trigger', 'cjs', 'backgroundEmbedding', 'customModuleToggle'] as const
const MIN_BODY_CHARS = 4096
const STORE_BATCH = 100
const READ_BATCH = 50
const SWEEP_DELAY_MS = 60_000
const SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000

export interface ColdModuleMarker {
    archivedAt: number
    bytes: number
    lorebookCount?: number
    regexCount?: number
    triggerCount?: number
}

export function coldMarkerOf(module: RisuModule | null | undefined): ColdModuleMarker | null {
    const marker = module?.nodeOnlyColdModule
    return marker && Number.isInteger(marker.archivedAt) && marker.archivedAt > 0 ? marker : null
}

export function isColdModule(module: RisuModule | null | undefined): boolean {
    return !!coldMarkerOf(module)
}

/** Same rule as mergeColdBody in module-cold-store.cjs: the row's body under the stub's catalog fields. */
export function mergeColdBody(stub: RisuModule, body: Record<string, unknown>): RisuModule {
    const merged: Record<string, unknown> = { ...stub }
    delete merged[COLD_MARKER]
    for (const field of COLD_BODY_FIELDS) delete merged[field]
    for (const field of COLD_BODY_FIELDS) {
        if (Object.hasOwn(body, field) && body[field] !== undefined) merged[field] = body[field]
    }
    return merged as unknown as RisuModule
}

function splitList(value: unknown): string[] {
    return typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : []
}

type ReferenceSource = {
    enabledModules?: readonly string[]
    moduleIntergration?: string
    botPresets?: readonly ({ moduleIntergration?: string } | null | undefined)[]
    characters?: readonly ({ modules?: readonly string[], chats?: readonly ({ modules?: readonly string[] } | null | undefined)[] } | null | undefined)[]
}

/**
 * What can turn a module on: ids or namespaces. Mirrors
 * referencedModuleNames in module-cold-store.cjs, which decides on the server.
 */
export function referencedModuleNames(db: ReferenceSource): Set<string> {
    const names = new Set<string>()
    const addAll = (list: readonly string[] | undefined) => {
        if (!Array.isArray(list)) return
        for (const name of list) if (typeof name === 'string' && name) names.add(name)
    }
    addAll(db.enabledModules)
    for (const name of splitList(db.moduleIntergration)) names.add(name)
    for (const preset of db.botPresets ?? []) for (const name of splitList(preset?.moduleIntergration)) names.add(name)
    for (const character of db.characters ?? []) {
        addAll(character?.modules)
        for (const chat of character?.chats ?? []) addAll(chat?.modules)
    }
    return names
}

function bodyChars(module: RisuModule): number {
    let chars = 0
    for (const field of COLD_BODY_FIELDS) {
        const value = (module as unknown as Record<string, unknown>)[field]
        if (value === undefined) continue
        chars += typeof value === 'string' ? value.length : JSON.stringify(value).length
        if (chars >= MIN_BODY_CHARS) break
    }
    return chars
}

/** Modules the sweep may store: whole, not an MCP link, nothing uses them, worth a row. */
export function coldCandidateIds(db: ReferenceSource & { modules?: readonly RisuModule[] }, keep: ReadonlySet<string>): string[] {
    const names = referencedModuleNames(db)
    const out: string[] = []
    for (const module of db.modules ?? []) {
        const id = module?.id
        if (typeof id !== 'string' || !id || id.includes('/') || keep.has(id)) continue
        if (isColdModule(module) || module.mcp) continue
        if (names.has(id) || (module.namespace && names.has(module.namespace))) continue
        if (bodyChars(module) < MIN_BODY_CHARS) continue
        out.push(id)
    }
    return out
}

async function nodeStorage(): Promise<NodeStorage | null> {
    if (!isNodeServer) return null
    const { forageStorage } = await import('../globalApi.svelte')
    return (forageStorage.realStorage as NodeStorage) ?? null
}

/** Bodies by module id; a module whose row is gone is left out. */
async function fetchBodies(modules: RisuModule[]): Promise<Map<string, Record<string, unknown>>> {
    const storage = await nodeStorage()
    const out = new Map<string, Record<string, unknown>>()
    if (!storage) return out
    const refs = modules.map((m) => ({ id: m.id, archivedAt: coldMarkerOf(m)!.archivedAt }))
    for (let i = 0; i < refs.length; i += READ_BATCH) {
        const bodies: ColdModuleBody[] = await storage.readColdModuleBodies(refs.slice(i, i + READ_BATCH))
        for (const entry of bodies) {
            if ('body' in entry) out.set(`${entry.id}@${entry.archivedAt}`, entry.body)
            else console.warn('[ModuleCold] stored body missing:', entry.id)
        }
    }
    return out
}

/** The module whole, to show or export; the database is left as it is. */
export async function wholeModule(module: RisuModule): Promise<RisuModule> {
    return (await wholeModules([module]))[0]
}

/** Each module whole (stored ones fetched together). Throws when a body is gone. */
export async function wholeModules(modules: RisuModule[]): Promise<RisuModule[]> {
    const stored = modules.filter((m) => isColdModule(m))
    if (stored.length === 0) return modules
    const bodies = await fetchBodies(stored)
    return modules.map((module) => {
        const marker = coldMarkerOf(module)
        if (!marker) return module
        const body = bodies.get(`${module.id}@${marker.archivedAt}`)
        if (!body) throw new Error(`Stored module data missing: ${module.name || module.id}`)
        return mergeColdBody(module, body)
    })
}

// Modules this page opened or brought back: the sweep leaves them until the
// next boot, so a module being worked on is not stored again under the user.
const keptWhole = new Set<string>()
export function keepModuleWhole(id: string | undefined): void {
    if (id) keptWhole.add(id)
}

const pendingWake = new Map<string, Promise<boolean>>()

/**
 * Bring the bodies of these stored modules back into db.modules (an ordinary
 * edit, saved like any other). Resolves to true when every one of them is
 * whole afterwards. Ids that are not stored are ignored.
 */
export function wakeModules(ids: Iterable<string>): Promise<boolean> {
    const wanted = [...new Set(ids)].filter((id) => isColdModule(DBState.db.modules?.find((m) => m?.id === id)))
    if (wanted.length === 0) return Promise.resolve(true)
    const fresh = wanted.filter((id) => !pendingWake.has(id))
    if (fresh.length > 0) {
        const run = wakeNow(fresh)
        for (const id of fresh) pendingWake.set(id, run.finally(() => pendingWake.delete(id)))
    }
    return Promise.all(wanted.map((id) => pendingWake.get(id) ?? Promise.resolve(true))).then((all) => all.every(Boolean))
}

async function wakeNow(ids: string[]): Promise<boolean> {
    for (const id of ids) keptWhole.add(id)
    const stubs = ids.map((id) => DBState.db.modules.find((m) => m?.id === id)).filter((m): m is RisuModule => isColdModule(m))
    let bodies: Map<string, Record<string, unknown>>
    try {
        bodies = await fetchBodies(stubs)
    } catch (error) {
        console.warn('[ModuleCold] could not fetch stored modules:', error)
        return false
    }
    const { updateLorebooks } = await import('../characters')
    const { refreshModules, rerenderChatForModules } = await import('./modules')
    let woke = 0
    let all = true
    for (const id of ids) {
        // Find it again: the list may have moved, and another device may have
        // brought it back (or stored it anew) meanwhile.
        const index = DBState.db.modules.findIndex((m) => m?.id === id)
        const current = index >= 0 ? DBState.db.modules[index] : null
        const marker = coldMarkerOf(current)
        if (!marker) continue
        const body = bodies.get(`${id}@${marker.archivedAt}`)
        if (!body) {
            all = false
            continue
        }
        const whole = mergeColdBody($state.snapshot(current) as RisuModule, body)
        if (Array.isArray(whole.lorebook)) whole.lorebook = updateLorebooks(whole.lorebook)
        DBState.db.modules[index] = whole
        woke++
    }
    if (woke > 0) {
        refreshModules()
        rerenderChatForModules()
        console.info(`[ModuleCold] brought back ${woke} module(s)`)
    }
    return all
}

// A fetch that failed waits this long before getModules asks again, so a
// server that is away is not asked on every render.
const WAKE_RETRY_MS = 30_000
const wakeFailedAt = new Map<string, number>()

// getModules found stored modules among the ones in use: fetch them after
// this tick (it may run inside a derived), once each.
export function requestModuleWake(modules: readonly (RisuModule | null | undefined)[]): void {
    const now = Date.now()
    const ids = modules
        .filter((m): m is RisuModule => isColdModule(m))
        .map((m) => m.id)
        .filter((id) => !pendingWake.has(id) && now - (wakeFailedAt.get(id) ?? 0) >= WAKE_RETRY_MS)
    if (ids.length === 0) return
    setTimeout(() => {
        void wakeModules(ids).then((ok) => {
            for (const id of ids) {
                if (ok) wakeFailedAt.delete(id)
                else wakeFailedAt.set(id, Date.now())
            }
        })
    }, 0)
}

let sweepTimer: ReturnType<typeof setTimeout> | null = null
let sweeping: Promise<number> | null = null

export function coldModulesEnabled(): boolean {
    return isNodeServer && DBState.db?.nodeOnlyColdModules !== false
}

/** Store the modules nothing uses. Resolves to how many were stored. */
export function runColdModuleSweep(): Promise<number> {
    sweeping ??= sweepNow().finally(() => { sweeping = null })
    return sweeping
}

async function sweepNow(): Promise<number> {
    if (!coldModulesEnabled()) return 0
    const storage = await nodeStorage()
    if (!storage) return 0
    const { canLandServerDbPatch, flushSaves, landServerDbPatch, moduleDiffersFromSaved } = await import('../globalApi.svelte')
    // Without patch sync the change could not land here.
    if (!canLandServerDbPatch()) return 0
    const keep = new Set(keptWhole)
    const open = DBState.db.characters?.[get(selectedCharID)]
    for (const id of open?.modules ?? []) keep.add(id)
    const ids = coldCandidateIds(DBState.db, keep)
    if (ids.length === 0) return 0
    // A module held here otherwise than on the server (an edit not saved
    // yet, or what boot normalized, e.g. lorebook versions) would meet the
    // server's change as a conflict and cost a rebase. Saving it first also
    // keeps the normalized body for good.
    for (let i = 0; i < ids.length; i++) {
        if (i % 20 === 19) await new Promise((resolve) => setTimeout(resolve, 0))
        const index = DBState.db.modules.findIndex((m) => m?.id === ids[i])
        if (index >= 0 && moduleDiffersFromSaved(DBState.db.modules[index])) {
            DBState.db.modules[index] = $state.snapshot(DBState.db.modules[index]) as RisuModule
        }
    }
    // The server stores what it holds: a body edited here must be there first
    // (the trackers see the slots replaced above once the effects run).
    await tick()
    if (!await flushSaves()) return 0
    let stored = 0
    for (let i = 0; i < ids.length; i += STORE_BATCH) {
        if (!coldModulesEnabled()) break
        const { results, published } = await storage.storeColdModules(ids.slice(i, i + STORE_BATCH))
        stored += results.filter((r) => r.ok).length
        if (published && !landServerDbPatch(published)) {
            // No sync loop to land it: the next save's catch-up rebases.
            break
        }
    }
    if (stored > 0) console.info(`[ModuleCold] stored ${stored} module(s) nothing uses`)
    return stored
}

export function scheduleColdModuleSweep(delayMs = SWEEP_DELAY_MS): void {
    if (sweepTimer) clearTimeout(sweepTimer)
    sweepTimer = null
    if (!coldModulesEnabled()) return
    sweepTimer = setTimeout(() => {
        sweepTimer = null
        void runColdModuleSweep()
            .catch((error) => console.warn('[ModuleCold] sweep failed:', error))
            .finally(() => scheduleColdModuleSweep(SWEEP_INTERVAL_MS))
    }, delayMs)
}
