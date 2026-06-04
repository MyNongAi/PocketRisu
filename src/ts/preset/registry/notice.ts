// Catalog-level "what's new" notice for the official model registry.
//
// Compares the official registry (remote-or-bundled) against a per-profile
// "seen" map (profileId -> last acknowledged updatedAt) and splits the
// difference into brand-new vs updated profiles. Drives the ModelPreset menu
// banner + details popup. Acknowledging writes the current map back to `seen`
// (see ModelPresetSettings), so a later bump re-notifies.

import type { RegistryCache } from '../types'
import { getBundledRegistryId } from './loader'
import { localizeDisplayName } from './i18n'

export interface RegistryNoticeEntry {
    id: string
    displayName: string
    updatedAt?: number
}

export interface RegistryNotice {
    newProfiles: RegistryNoticeEntry[]
    updatedProfiles: RegistryNoticeEntry[]
}

export function noticeCount(notice: RegistryNotice): number {
    return notice.newProfiles.length + notice.updatedProfiles.length
}

// Snapshot the official profiles as a profileId -> updatedAt map. Written back
// to `seen` on acknowledge.
export function buildSeenMap(official: RegistryCache): Record<string, number> {
    const profiles = official.registries?.[getBundledRegistryId()]?.profiles ?? {}
    const map: Record<string, number> = {}
    for (const [id, profile] of Object.entries(profiles)) {
        map[id] = profile.updatedAt ?? 0
    }
    return map
}

export function computeRegistryNotice(
    official: RegistryCache,
    seen: Record<string, number> | undefined,
): RegistryNotice {
    const profiles = official.registries?.[getBundledRegistryId()]?.profiles ?? {}
    const newProfiles: RegistryNoticeEntry[] = []
    const updatedProfiles: RegistryNoticeEntry[] = []
    // No baseline yet: caller seeds `seen` silently and shows nothing.
    if (!seen) return { newProfiles, updatedProfiles }
    for (const [id, profile] of Object.entries(profiles)) {
        const entry: RegistryNoticeEntry = {
            id,
            displayName: localizeDisplayName(profile),
            updatedAt: profile.updatedAt,
        }
        if (!(id in seen)) {
            newProfiles.push(entry)
        } else if ((profile.updatedAt ?? 0) > seen[id]) {
            updatedProfiles.push(entry)
        }
    }
    return { newProfiles, updatedProfiles }
}
