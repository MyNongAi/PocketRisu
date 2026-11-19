// BUILD-FENCE-LATEST-WINS: an older tab keeps saving; only a storage-format break stops it.
// Build mismatches keep saving and reload after work finishes. An epoch
// refusal alone stops the save loop and preserves unsaved work for export.

import { writable } from 'svelte/store'
import { language } from 'src/lang'
import { allowNextUnload } from '../../preload'

export const BUILD_ID_HEADER = 'x-pocketrisu-build'
export const STORAGE_EPOCH_HEADER = 'x-pocketrisu-storage-epoch'
export const STORAGE_FORMAT_EPOCH = 1
export const STALE_BUILD_STATUS = 426
export const STALE_BUILD_CODE = 'STALE_CLIENT_BUILD'
const BUILD_ID_URL = '/build-id.txt'
const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
// The server build this tab last reloaded for (sessionStorage, per tab).
const RELOAD_MARK_KEY = 'pocketrisu-stale-build-reload'
// The reload mark as this page found it, read before a build check clears
// it: set means the page before this one reloaded itself into a new build.
const reloadMarkAtLoad: string | null = (() => {
    try { return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(RELOAD_MARK_KEY) } catch { return null }
})()

/** This page life began with the fence's own reload (bootReason.ts). */
export function startedByBuildReload(): boolean {
    return reloadMarkAtLoad !== null
}
const CHECK_INTERVAL_MS = 15_000

// Empty outside production builds (vite dev server, tests): no header is sent
// and the server lets every request through.
let clientBuildId: string = typeof __POCKETRISU_BUILD_ID__ === 'string' ? __POCKETRISU_BUILD_ID__ : ''

export function getClientBuildId(): string {
    return clientBuildId
}

/** Tests only: pretend to be a production build with this id. */
export function setClientBuildIdForTests(id: string): void {
    clientBuildId = id
}

export function parseBuildId(text: unknown): string | null {
    if (typeof text !== 'string') return null
    const id = text.trim()
    return BUILD_ID_PATTERN.test(id) ? id : null
}

export function addBuildIdHeader(headers: Headers): void {
    if (clientBuildId) {
        headers.set(BUILD_ID_HEADER, clientBuildId)
        headers.set(STORAGE_EPOCH_HEADER, String(STORAGE_FORMAT_EPOCH))
    }
}

export function setXhrBuildIdHeader(xhr: XMLHttpRequest): void {
    if (clientBuildId) {
        xhr.setRequestHeader(BUILD_ID_HEADER, clientBuildId)
        xhr.setRequestHeader(STORAGE_EPOCH_HEADER, String(STORAGE_FORMAT_EPOCH))
    }
}

/** A storage request the server refused, unapplied, for an incompatible epoch. */
export class StaleBuildError extends Error {
    readonly status = STALE_BUILD_STATUS
    constructor(readonly serverBuildId: string) {
        super(language.staleBuildRefused)
        this.name = 'StaleBuildError'
        Object.setPrototypeOf(this, StaleBuildError.prototype)
    }
}

/** The server build id named by a stale-build refusal body, or null. */
export function parseStaleBuildBody(body: unknown): string | null {
    const data = body as { code?: unknown, serverBuild?: unknown, serverEpoch?: unknown } | null
    if (data?.code !== STALE_BUILD_CODE) return null
    return parseBuildId(data.serverBuild) ?? (data.serverEpoch === STORAGE_FORMAT_EPOCH ? (clientBuildId || 'unknown') : null)
}

/** The server build id when this response is a stale-build refusal, else null. */
export async function readStaleBuildRefusal(response: Response): Promise<string | null> {
    if (response.status !== STALE_BUILD_STATUS) return null
    try {
        return parseStaleBuildBody(await response.clone().json())
    } catch {
        return null
    }
}

export function readStaleBuildRefusalXhr(xhr: XMLHttpRequest): string | null {
    if (xhr.status !== STALE_BUILD_STATUS) return null
    try {
        return parseStaleBuildBody(JSON.parse(xhr.responseText))
    } catch {
        return null
    }
}

export type StaleBuildAction = 'reload' | 'notice'

/**
 * What a tab does once the server serves another build. It reloads only when
 * nothing would be lost, and only once per server build: still being stale
 * after a reload for the same build means the reload came back on old code,
 * and reloading again would loop.
 */
export function decideStaleBuildAction({ unsavedWork, serverBuildId, reloadedFor }: {
    unsavedWork: boolean
    serverBuildId: string
    reloadedFor: string | null
}): StaleBuildAction {
    if (unsavedWork) return 'notice'
    if (reloadedFor === serverBuildId) return 'notice'
    return 'reload'
}

export interface StaleBuildNoticeState {
    serverBuildId: string
    /** This tab already reloaded once for this server build and still runs old code. */
    reloadTried: boolean
    /** Unsent chat input, shown for copying. */
    unsavedText: string
    /** The save loop holds edits the server never acknowledged; offer them as JSON. */
    canDownloadEdits: boolean
    /** Bumped by every report, so a collapsed notice opens again. */
    seq: number
}

export const staleBuildNotice = writable<StaleBuildNoticeState | null>(null)

export interface StaleBuildSaveState {
    /** Edits not acknowledged by the server yet, or a reply still being generated. */
    hasUnsavedWork: () => boolean
    downloadUnsavedEdits?: () => Promise<void>
}

let saveState: StaleBuildSaveState | null = null
const textSources = new Set<() => string>()
const stopListeners = new Set<() => void>()
let staleFor: string | null = null
let reloading = false
let pendingBuild: string | null = null
let pendingDeps: StaleBuildDeps | null = null
let pendingTimer: ReturnType<typeof setInterval> | null = null
export const newBuildNotice = writable(false)

/** Retry the automatic reload after a save or generation finishes. */
export function checkPendingBuildReload(): StaleBuildAction | null {
    if (!pendingBuild || !pendingDeps || reloading || staleFor !== null) return null
    const serverBuildId = pendingBuild
    const deps = pendingDeps
    let busy = true
    try { busy = (saveState?.hasUnsavedWork() ?? true) || collectUnsavedText().length > 0 } catch { /* keep saving */ }
    let action = decideStaleBuildAction({ unsavedWork: busy, serverBuildId, reloadedFor: readReloadMark(deps.storage) })
    if (action === 'reload' && !writeReloadMark(deps.storage, serverBuildId)) action = 'notice'
    if (action === 'reload') {
        reloading = true
        newBuildNotice.set(false)
        if (pendingTimer) clearInterval(pendingTimer)
        pendingTimer = null
        allowNextUnload()
        deps.reload()
    } else {
        newBuildNotice.set(true)
    }
    return action
}

/** A different code build remains write-compatible. */
export function reportNewBuild(serverBuildId: string, deps: StaleBuildDeps = browserDeps()): StaleBuildAction {
    if (reloading) return 'reload'
    pendingBuild = serverBuildId
    pendingDeps = deps
    const action = checkPendingBuildReload() ?? 'notice'
    if (action === 'notice' && !pendingTimer) pendingTimer = setInterval(checkPendingBuildReload, 1000)
    return action
}

/** The save loop's view of unsaved work (globalApi saveDb). */
export function setStaleBuildSaveState(state: StaleBuildSaveState | null): void {
    saveState = state
}

/** Text that only exists on screen, such as the chat input. Returns the unregister function. */
export function registerUnsavedText(source: () => string): () => void {
    textSources.add(source)
    return () => { textSources.delete(source) }
}

/** Runs once this tab is known to be stale (at once if it already is). Returns the unregister function. */
export function onStaleBuild(listener: () => void): () => void {
    if (staleFor !== null) {
        listener()
        return () => {}
    }
    stopListeners.add(listener)
    return () => { stopListeners.delete(listener) }
}

export function isStaleBuild(): boolean {
    return staleFor !== null
}

function collectUnsavedText(): string {
    const parts: string[] = []
    for (const source of textSources) {
        try {
            const text = source()
            if (text && !parts.includes(text)) parts.push(text)
        } catch {
            // A source that cannot answer contributes nothing.
        }
    }
    return parts.join('\n\n')
}

type MarkStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface StaleBuildDeps {
    reload: () => void
    storage: MarkStorage | null
}

function browserDeps(): StaleBuildDeps {
    let storage: MarkStorage | null = null
    try { storage = sessionStorage } catch { /* blocked: no automatic reloads */ }
    return { reload: () => location.reload(), storage }
}

function readReloadMark(storage: MarkStorage | null): string | null {
    try { return storage?.getItem(RELOAD_MARK_KEY) ?? null } catch { return null }
}

function writeReloadMark(storage: MarkStorage | null, serverBuildId: string): boolean {
    if (!storage) return false
    try {
        storage.setItem(RELOAD_MARK_KEY, serverBuildId)
        return storage.getItem(RELOAD_MARK_KEY) === serverBuildId
    } catch {
        return false
    }
}

/**
 * An incompatible storage epoch was refused. Stop saving and preserve edits.
 */
export function reportStaleBuild(serverBuildId: string, deps: StaleBuildDeps = browserDeps()): StaleBuildAction {
    if (pendingTimer) clearInterval(pendingTimer)
    pendingTimer = null
    newBuildNotice.set(false)
    const first = staleFor === null
    staleFor = serverBuildId
    if (first) {
        const listeners = [...stopListeners]
        stopListeners.clear()
        for (const listener of listeners) {
            try { listener() } catch (error) { console.error('[BuildFence] stop listener failed:', error) }
        }
    }
    if (reloading) return 'reload'

    const unsavedText = collectUnsavedText()
    let saveUnsaved: boolean
    try {
        saveUnsaved = saveState?.hasUnsavedWork() ?? false
    } catch {
        // Unknown counts as unsaved: a needless notice beats lost edits.
        saveUnsaved = true
    }
    const reloadedFor = readReloadMark(deps.storage)
    let action = decideStaleBuildAction({
        unsavedWork: saveUnsaved || unsavedText.length > 0,
        serverBuildId,
        reloadedFor,
    })
    // The mark is what stops a reload loop; never reload without it.
    if (action === 'reload' && !writeReloadMark(deps.storage, serverBuildId)) action = 'notice'

    if (action === 'reload') {
        console.warn(`[BuildFence] the server now serves build ${serverBuildId} (this page: ${clientBuildId}); reloading`)
        reloading = true
        allowNextUnload()
        deps.reload()
        return 'reload'
    }
    console.warn(`[BuildFence] storage epoch mismatch; saving stopped, unsaved work kept on screen`)
    staleBuildNotice.update((previous) => ({
        serverBuildId,
        reloadTried: reloadedFor === serverBuildId,
        unsavedText,
        canDownloadEdits: saveUnsaved && !!saveState?.downloadUnsavedEdits,
        seq: (previous?.seq ?? 0) + 1,
    }))
    return 'notice'
}

/** The notice's reload button: the user has seen what is unsaved. */
export function reloadIntoNewBuild(reload: () => void = () => location.reload()): void {
    allowNextUnload()
    reload()
}

export function downloadUnsavedEdits(): Promise<void> {
    return saveState?.downloadUnsavedEdits?.() ?? Promise.resolve()
}

/**
 * Compare this tab's build with dist/build-id.txt. 'unknown' when either side
 * has no id (dev server, no build id file, offline).
 */
export async function checkServerBuild(
    fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
    deps: StaleBuildDeps = browserDeps(),
): Promise<'match' | 'stale' | 'unknown'> {
    if (!clientBuildId) return 'unknown'
    // An epoch refusal already stopped this tab.
    if (staleFor !== null) return 'stale'
    let serverBuildId: string | null = null
    try {
        const response = await fetchFn(BUILD_ID_URL, { cache: 'no-store' })
        if (response.ok) serverBuildId = parseBuildId(await response.text())
    } catch {
        // Offline or the server is restarting: the next check or write decides.
    }
    if (!serverBuildId) return 'unknown'
    if (serverBuildId === clientBuildId) {
        try { deps.storage?.removeItem(RELOAD_MARK_KEY) } catch { /* best-effort */ }
        return 'match'
    }
    reportNewBuild(serverBuildId, deps)
    return 'stale'
}

let watching = false

/** Check the server build now and whenever the tab comes back (at most every 15 s). */
export function watchServerBuild(): void {
    if (watching || !clientBuildId || typeof window === 'undefined') return
    watching = true
    let lastCheckAt = -Infinity
    const check = () => {
        if (Date.now() - lastCheckAt < CHECK_INTERVAL_MS) return
        lastCheckAt = Date.now()
        void checkServerBuild()
    }
    check()
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
    })
    window.addEventListener('pageshow', check)
    window.addEventListener('online', check)
}

/** Tests only. */
export function resetBuildFenceForTests(): void {
    saveState = null
    textSources.clear()
    stopListeners.clear()
    staleFor = null
    reloading = false
    watching = false
    pendingBuild = null
    pendingDeps = null
    if (pendingTimer) clearInterval(pendingTimer)
    pendingTimer = null
    newBuildNotice.set(false)
    staleBuildNotice.set(null)
}
