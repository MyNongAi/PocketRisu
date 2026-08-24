import { mergeTrackedModuleChanges } from '../process/moduleChangeTracker.svelte'
import type { toSaveType } from './risuSave'

type PatchResultLike = {
    success: boolean
    conflict?: boolean
    chatGuardRejected?: boolean
}

export type PatchWriteOutcome = 'saved' | 'rebase' | 'full-write'

/** Keep the 409 hash-conflict path distinct from chat-guard recovery. */
export function classifyPatchWriteResult(result: PatchResultLike): PatchWriteOutcome {
    if (result.success) return 'saved'
    if (result.conflict && !result.chatGuardRejected) return 'rebase'
    return 'full-write'
}

const SPLIT_DB_KEYS = new Set([
    'characters',
    'botPresets',
    'modules',
    'plugins',
    'pluginCustomStorage',
])

/**
 * Apply only locally tracked changes to an owned clone of the latest server DB.
 * `mergedDb` and `localDb` must be independent clones; the function mutates and
 * returns `mergedDb` without cloning the multi-gigabyte database again.
 */
export function mergeTrackedDatabaseChanges(
    mergedDb: any,
    localDb: any,
    toSave: toSaveType,
): any {
    // Root is one coarse tracked block today. Crucially, do not copy it merely
    // because a module/character save collided: that would overwrite unrelated
    // settings changed by the other writer.
    if (toSave.root) {
        for (const key of Object.keys(localDb ?? {})) {
            if (!SPLIT_DB_KEYS.has(key)) {
                mergedDb[key] = localDb[key]
            }
        }
        for (const key of Object.keys(mergedDb ?? {})) {
            if (!SPLIT_DB_KEYS.has(key) && !Object.hasOwn(localDb ?? {}, key)) {
                delete mergedDb[key]
            }
        }
    }

    if (toSave.botPreset) {
        mergedDb.botPresets = localDb.botPresets
        mergedDb.botPresetsId = localDb.botPresetsId
    }
    if (toSave.modules) {
        mergedDb.modules = mergeTrackedModuleChanges(
            mergedDb.modules,
            localDb.modules,
            toSave.moduleIds,
        )
    }
    if (toSave.plugins) {
        mergedDb.plugins = localDb.plugins
    }
    if (toSave.pluginCustomStorage) {
        mergedDb.pluginCustomStorage = localDb.pluginCustomStorage
    }

    const trackedCharIds = new Set<string>(toSave.character.filter(Boolean))
    for (const trackedChat of toSave.chat) {
        if (trackedChat?.[0]) trackedCharIds.add(trackedChat[0])
    }
    const mergedCharacters = Array.isArray(mergedDb.characters) ? mergedDb.characters : []
    const localCharacters = Array.isArray(localDb.characters) ? localDb.characters : []
    for (const charId of trackedCharIds) {
        const localChar = localCharacters.find((char: any) => char?.chaId === charId)
        const mergedIndex = mergedCharacters.findIndex((char: any) => char?.chaId === charId)
        if (localChar) {
            if (mergedIndex >= 0) mergedCharacters[mergedIndex] = localChar
            else mergedCharacters.push(localChar)
        } else if (mergedIndex >= 0) {
            mergedCharacters.splice(mergedIndex, 1)
        }
    }
    mergedDb.characters = mergedCharacters
    return mergedDb
}
