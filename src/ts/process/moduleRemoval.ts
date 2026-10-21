import { DBState } from '../stores.svelte'
import { dissolveShrunkenModuleFolders, synchronizeModuleFolderMembership } from './moduleFolders'

/**
 * Delete modules from the database with what the catalog keeps about them:
 * the global list, the activation history, and folders they leave too small
 * (the steps of a delete in the module catalog). Returns the count deleted.
 */
export function removeModulesFromDatabase(ids: ReadonlySet<string>): number {
    if (ids.size === 0) return 0
    const db = DBState.db
    const previousFolders = synchronizeModuleFolderMembership(
        db.modules,
        db.moduleFolders,
        { importLegacyWhenFolderIdsEmpty: false },
    )
    const before = db.modules.length
    if (db.enabledModules?.some((id) => ids.has(id))) db.enabledModules = db.enabledModules.filter((id) => !ids.has(id))
    db.modules = db.modules.filter((module) => !ids.has(module.id))
    db.moduleActivationHistory = db.moduleActivationHistory?.filter((id) => !ids.has(id)) ?? []
    const synchronized = synchronizeModuleFolderMembership(
        db.modules,
        db.moduleFolders,
        { importLegacyWhenFolderIdsEmpty: false },
    )
    const dissolved = dissolveShrunkenModuleFolders(db.modules, synchronized, previousFolders)
    db.modules = dissolved.modules
    db.moduleFolders = dissolved.folders
    return before - db.modules.length
}
