// Runtime registry fetch — pulls the latest official model registry from
// GitHub at runtime and overlays it on the build-time bundled snapshot.
//
// Flow (see model-preset-runtime-fetch-task.md):
//  1. Fetch index.json (tiny manifest) every ModelPreset menu entry.
//  2. Gate on its top-level `updatedAt`: only when it differs from the last
//     stored value do we re-download the full base-provider + profile files.
//  3. Store the rebuilt registry under registries['bundled'] in the DB cache
//     (preserving registries['custom']), so the official tab + update badge
//     read remote-first via getOfficialRegistry().
//
// Bundled stays the fallback: any failure (network, bad schema, empty result)
// leaves the existing cache/bundle untouched and never throws to the UI.

import { DBState } from 'src/ts/stores.svelte'
import { fetchNative } from 'src/ts/globalApi.svelte'
import type { BaseProviderDefinition, ModelPreset, ModelProfile, RegistryCache } from '../types'
import { getProfileUpdateStatus, type ProfileUpdateStatus } from '../customProfiles'
import { getBundledRegistryId, loadBundledRegistry } from './loader'

const REGISTRY_BASE = 'https://raw.githubusercontent.com/PocketRisu/pocketrisu-model-registry/main/'
const REGISTRY_INDEX_URL = REGISTRY_BASE + 'index.json'
// Skip a re-fetch if one ran this recently (menu re-entry debounce).
const REFETCH_GUARD_MS = 5_000

type RegistryEntry = RegistryCache['registries'][string]

interface RegistryIndexItem {
    id: string
    url: string
    version?: number
}

interface RegistryIndex {
    schemaVersion: number
    contentVersion?: number
    updatedAt?: number
    baseProviders: RegistryIndexItem[]
    profiles: RegistryIndexItem[]
}

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetchNative(url, { method: 'GET' })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return (await res.json()) as T
}

export interface RemoteFetchResult {
    ok: boolean
    entry?: RegistryEntry
    /** Gate value — the index's top-level updatedAt (or contentVersion). */
    gate?: number
    error?: string
}

export async function fetchRemoteRegistry(): Promise<RemoteFetchResult> {
    let index: RegistryIndex
    try {
        index = await fetchJson<RegistryIndex>(REGISTRY_INDEX_URL)
    } catch (e) {
        return { ok: false, error: `index fetch failed: ${(e as Error).message}` }
    }

    if (index.schemaVersion !== 4) {
        // Never break on an unexpected schema — keep the bundled fallback.
        return { ok: false, error: `unsupported schemaVersion ${index.schemaVersion}` }
    }

    const baseProviders: Record<string, BaseProviderDefinition> = {}
    const profiles: Record<string, ModelProfile> = {}

    const baseResults = await Promise.allSettled(
        (index.baseProviders ?? []).map((it) => fetchJson<BaseProviderDefinition>(REGISTRY_BASE + it.url)),
    )
    for (const r of baseResults) {
        if (r.status === 'fulfilled' && r.value?.id) baseProviders[r.value.id] = r.value
        else if (r.status === 'rejected') console.warn('[Registry] base provider fetch failed:', r.reason)
    }

    const profileResults = await Promise.allSettled(
        (index.profiles ?? []).map((it) => fetchJson<ModelProfile>(REGISTRY_BASE + it.url)),
    )
    for (const r of profileResults) {
        if (r.status === 'rejected') {
            console.warn('[Registry] profile fetch failed:', r.reason)
            continue
        }
        const p = r.value
        if (!p?.id || !p.providerBaseId) {
            console.warn('[Registry] skipping malformed profile:', p)
            continue
        }
        if (!baseProviders[p.providerBaseId]) {
            // Profile whose base provider failed/missing is unusable — skip it
            // rather than ship a registry that throws on resolveSnapshot.
            console.warn(`[Registry] skipping profile ${p.id}: base provider ${p.providerBaseId} unavailable`)
            continue
        }
        profiles[p.id] = p
    }

    if (Object.keys(profiles).length === 0) {
        return { ok: false, error: 'no usable profiles fetched' }
    }

    return {
        ok: true,
        gate: index.updatedAt ?? index.contentVersion ?? 0,
        entry: {
            fetchedAt: Date.now(),
            indexVersion: index.contentVersion,
            baseProviders,
            profiles,
        },
    }
}

export function isRefetchGuarded(lastFetched: number | undefined): boolean {
    return lastFetched !== undefined && Date.now() - lastFetched < REFETCH_GUARD_MS
}

export interface SyncResult {
    ok: boolean
    /** True when the gate changed and the cache was rewritten. */
    changed: boolean
    error?: string
}

// Fetch + (on gate change) persist the remote registry into the DB cache.
// force bypasses the debounce guard. Never throws.
export async function syncRemoteRegistry(force = false): Promise<SyncResult> {
    const db = DBState.db
    if (!force && isRefetchGuarded(db.modelProfileRegistryLastFetched)) {
        return { ok: true, changed: false }
    }

    const result = await fetchRemoteRegistry()
    db.modelProfileRegistryLastFetched = Date.now()
    if (!result.ok || !result.entry) {
        return { ok: false, changed: false, error: result.error }
    }

    // Always persist the freshly-fetched entry. fetchRemoteRegistry already
    // downloaded every file, so re-storing is free — and the gate must NOT
    // guard persistence: if a cache was once stored incomplete (e.g. a
    // mid-edit registry state) while the gate stayed the same, gating the
    // write would strand that bad cache forever. The gate's only job is the
    // user-facing "changed" notification (banner / seen-map), not freshness.
    //
    // Assign a brand-new object (not a same-reference reassign) so the async
    // write reliably triggers Svelte reactivity in already-mounted views.
    // Preserve any other registries (e.g. 'custom').
    db.modelProfileRegistryCache = {
        schemaVersion: 4,
        registries: {
            ...(db.modelProfileRegistryCache?.registries ?? {}),
            [getBundledRegistryId()]: result.entry,
        },
    }

    const changed = result.gate !== db.modelProfileRegistryIndexUpdatedAt
    if (changed) {
        db.modelProfileRegistryIndexUpdatedAt = result.gate
    }
    return { ok: true, changed }
}

// The official registry to read from: remote cache if present, else bundled.
// Scoped to just the official entry so custom profiles never leak in.
export function getOfficialRegistry(): RegistryCache {
    const remote = DBState.db.modelProfileRegistryCache?.registries?.[getBundledRegistryId()]
    if (remote?.profiles && Object.keys(remote.profiles).length > 0) {
        return { schemaVersion: 4, registries: { [getBundledRegistryId()]: remote } }
    }
    return loadBundledRegistry()
}

// Per-preset update status against its source registry (official=remote-or-bundled,
// else the custom cache). Shared by the editor badge and the preset-list dot.
export function getPresetUpdateStatus(preset: ModelPreset): ProfileUpdateStatus {
    const sp = preset.sourceProfile
    if (!sp?.registryId) return 'none'
    const cache = sp.registryId === getBundledRegistryId()
        ? getOfficialRegistry()
        : DBState.db.modelProfileRegistryCache
    const current = cache?.registries?.[sp.registryId]?.profiles?.[sp.profileId]
    return getProfileUpdateStatus(current, sp.profileUpdatedAt)
}
