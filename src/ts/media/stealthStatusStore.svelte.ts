// Per-asset cache of NovelAI stealth-metadata status.
//
// Detection decodes the whole image, so it must happen once per asset and only
// for rows actually on screen — this store exists because a character can carry
// tens of thousands of assets and the list is virtualised.

import { getFileSrc } from '../globalApi.svelte'
import { canCarryStealth, detectStealthMetadata, type StealthStatus } from './stealthMetadata'

const statuses = $state(new Map<string, StealthStatus>())
const inFlight = new Set<string>()

/** Bounded so browsing many characters cannot grow this without limit. */
const MAX_ENTRIES = 600

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

/**
 * Resolve one asset's status, at most once. Safe to call from render: it
 * returns immediately and fills the store when the answer arrives.
 */
export function requestStealthStatus(path: string, extension: string): void {
    if (!path || statuses.has(path) || inFlight.has(path)) return

    // Callers reach this from render, so every write to `statuses` has to land
    // after the current render pass — including the cheap early answers, which
    // would otherwise mutate reactive state mid-render.
    inFlight.add(path)
    void (async () => {
        try {
            // An async function body runs synchronously up to its first await,
            // so yield before touching the store at all.
            await Promise.resolve()
            if (!canCarryStealth(extension)) {
                remember(path, 'unsupported')
                return
            }
            const src = await getFileSrc(path)
            if (!src) {
                remember(path, 'error')
                return
            }
            const response = await fetch(src)
            if (!response.ok) {
                remember(path, 'error')
                return
            }
            remember(path, await detectStealthMetadata(await response.blob()))
        } catch {
            remember(path, 'error')
        } finally {
            inFlight.delete(path)
        }
    })()
}

/** Drop everything — used when assets are rewritten underneath the cache. */
export function resetStealthStatuses(): void {
    statuses.clear()
    inFlight.clear()
}
