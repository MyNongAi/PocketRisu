// Per-asset cache of NovelAI stealth-metadata status.
//
// Detection decodes the whole image, so it must happen once per asset and only
// for rows actually on screen — this store exists because a character can carry
// tens of thousands of assets and the list is virtualised.

import { SvelteMap } from 'svelte/reactivity'
import { getFileSrc } from '../globalApi.svelte'
import { canCarryStealth, detectStealthMetadata, type StealthStatus } from './stealthMetadata'

// A SvelteMap, not `$state(new Map())`: $state only proxies plain objects and
// arrays, so writes to a plain Map never reached the icon and it stayed white.
const statuses = new SvelteMap<string, StealthStatus>()
const inFlight = new Set<string>()

/** Bounded so browsing many characters cannot grow this without limit. */
const MAX_ENTRIES = 600

/**
 * Each detection fetches and decodes a full image. The module asset table is
 * not virtualised, so without a cap a page of a hundred rows would decode a
 * hundred images at once.
 */
const MAX_CONCURRENT = 3
let running = 0
const queue: Array<() => Promise<void>> = []

function pump(): void {
    while (running < MAX_CONCURRENT && queue.length > 0) {
        const job = queue.shift()!
        running++
        void job().finally(() => {
            running--
            pump()
        })
    }
}

export function getStealthStatus(path: string): StealthStatus | undefined {
    return statuses.get(path)
}

function remember(path: string, status: StealthStatus): void {
    if (statuses.size >= MAX_ENTRIES) {
        // Cheap eviction: drop the oldest insertion. Order is good enough here
        // because the working set is whatever the user is currently scrolling.
        const oldest = statuses.keys().next()
        if (!oldest.done) statuses.delete(oldest.value)
    }
    statuses.set(path, status)
}

async function resolveStatus(path: string, extension: string): Promise<StealthStatus> {
    if (!canCarryStealth(extension)) return 'unsupported'
    const src = await getFileSrc(path)
    if (!src) return 'error'
    const response = await fetch(src)
    if (!response.ok) return 'error'
    return detectStealthMetadata(await response.blob())
}

/**
 * Resolve one asset's status, at most once. Safe to call from render: it
 * returns immediately and fills the store when the answer arrives.
 */
export function requestStealthStatus(path: string, extension: string): void {
    if (!path || statuses.has(path) || inFlight.has(path)) return

    inFlight.add(path)
    queue.push(async () => {
        try {
            // Callers reach this from render and pump() may start the job
            // synchronously, so yield before any write to the reactive map.
            await Promise.resolve()
            remember(path, await resolveStatus(path, extension))
        } catch {
            remember(path, 'error')
        } finally {
            inFlight.delete(path)
        }
    })
    pump()
}

/** Drop everything — used when assets are rewritten underneath the cache. */
export function resetStealthStatuses(): void {
    queue.length = 0
    statuses.clear()
    inFlight.clear()
}
