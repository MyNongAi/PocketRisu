import { language } from "src/lang"
import { alertConfirm, notifySuccess } from "../alert"
import { askProtonLink } from "../protonLinkPrompt.svelte"
import { getDatabase, type customscript, type loreBook } from "../storage/database.svelte"
import { checkCharOrder } from "../globalApi.svelte"
import { selectMultipleFile } from "../util"
import { isNodeServer } from "../platform"
import { v4 } from "uuid"
import { convertExternalLorebook } from "./lorebook.svelte"
import { convertCharacterToModule } from "../interchangeability"
import { importCharacterProcess } from "../characterCards"
import { addModuleToDatabase, hydrateModuleAssets, readModule, type RisuModule } from "./modules"
import { applyModuleLayout, isModuleLayoutFile } from "./moduleLayoutImport"
import { runImportBatch, runImportTask, type ImportProgressReporter } from "../importProgress"
import type { CharxDestination } from "../charxPreflight"
import { planLargeCharxImport } from "../largeCharxImport"
import { ImportCancelledError, isImportCancelled, runImportTransaction, type ImportWriteScope } from "../importTransaction"

export interface ImportModuleFileOptions {
    suppressSuccess?: boolean
    onProgress?: ImportProgressReporter
    /** PocketRisu: the cancellable import this runs in (importTransaction.ts). */
    importScope?: ImportWriteScope
    /** PocketRisu: false skips the large-CHARX question and cancel guard. */
    charxGuard?: boolean
}

/**
 * A large module CHARX (charxPreflight.ts) after the user picked what it is,
 * run as a cancellable transaction. A caller that has no progress card gets
 * one, so the cancel action is always there.
 */
async function importLargeModuleCharx(
    file: { name: string, data: Uint8Array | File },
    options: ImportModuleFileOptions,
    destination: CharxDestination,
): Promise<RisuModule | undefined> {
    const run = (report: ImportProgressReporter) => runImportTransaction(report, async (scope) => {
        if (destination === 'character') {
            await importCharacterProcess({
                name: file.name,
                data: file.data,
                onProgress: report,
                suppressSuccess: options.suppressSuccess,
                importScope: scope,
            })
            checkCharOrder()
            return undefined
        }
        return importModuleFile(file, { ...options, onProgress: report, importScope: scope })
    })
    if (options.onProgress) return run(options.onProgress)
    try {
        return await runImportTask(file.name, run)
    } catch (error) {
        if (isImportCancelled(error)) return undefined
        throw error
    }
}

export async function importModuleFile(
    file: { name: string, data: Uint8Array | File },
    options: ImportModuleFileOptions = {},
): Promise<RisuModule | undefined> {
    const fileName = file.name.toLocaleLowerCase()
    // PocketRisu: a large CHARX first asks module / bot / cancel.
    if (fileName.endsWith('.charx') && !options.importScope && options.charxGuard !== false) {
        const plan = await planLargeCharxImport(file.name, file.data, 'module')
        if (plan.kind === 'cancel') {
            // A tracked task shows "cancelled"; a blocking-alert caller just stops.
            if (options.onProgress) throw new ImportCancelledError()
            return undefined
        }
        if (plan.kind === 'guarded') return importLargeModuleCharx(file, options, plan.destination)
    }
    const finish = (module: RisuModule) => {
        // Nothing awaits between this check and the insert, so a cancel either
        // stops the import here or the module is registered for the rollback.
        options.importScope?.check()
        addModuleToDatabase(module, { received: true })
        options.importScope?.registerOwner('module', module.id)
        options.onProgress?.({
            label: language.importProgress.savingModule,
            progress: 90,
        })
        if(!options.suppressSuccess) notifySuccess(language.successImport)
        return module
    }

    if(fileName.endsWith('.charx')){
        options.onProgress?.({
            label: language.importProgress.readingModule,
            progress: 20,
        })
        const char = await importCharacterProcess({
            name: file.name,
            // Streamed as is: copying a several-hundred-MB archive first
            // doubled the memory a large module import needs.
            data: file.data,
            returnCharacter: true,
            onProgress: options.onProgress,
            suppressSuccess: true,
            importScope: options.importScope,
        })
        if(!char || typeof char === 'number'){
            throw new Error(language.errors.noData)
        }
        return finish(convertCharacterToModule(char))
    }

    // Only a CHARX streams from a File; the other formats are read whole.
    const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(await file.data.arrayBuffer())

    if(fileName.endsWith('.risum')){
        options.onProgress?.({
            label: language.importProgress.readingModule,
            progress: 20,
        })
        const module = await readModule(Buffer.from(bytes), {
            onProgress: options.onProgress,
            importScope: options.importScope,
        })
        if(!module) throw new Error(language.errors.noData)
        return finish(module)
    }

    const importData = JSON.parse(Buffer.from(bytes).toString())
    // PocketRisu: a file of folder places for the modules already here
    // (moduleLayoutImport.ts); it adds no module.
    if(isModuleLayoutFile(importData)){
        options.importScope?.check()
        const db = getDatabase()
        const placed = applyModuleLayout(db.modules, db.moduleFolders ?? [], importData, v4)
        db.modules = placed.modules
        db.moduleFolders = placed.folders
        notifySuccess(language.moduleLayoutImported
            .replace('{{modules}}', String(placed.movedModules))
            .replace('{{folders}}', String(placed.movedFolders))
            .replace('{{created}}', String(placed.createdFolders))
            .replace('{{skipped}}', String(placed.skipped)))
        return undefined
    }
    if(importData.type === 'risuModule'){
        if((!importData.name) || (!importData.id)){
            throw new Error(language.errors.noData)
        }
        importData.id = v4()
        delete importData.mcp

        // Imported modules must own their asset list. Keeping another module's
        // lazy manifest descriptor would make later edits mutate the source.
        if(importData.assetManifest){
            try {
                Object.assign(importData, await hydrateModuleAssets(importData))
            } catch {
                importData.assets = []
            }
            delete importData.assetManifest
        }

        // Asked only when "allow low-level access on import" is turned off (on by default).
        if(importData.lowLevelAccess && getDatabase().nodeOnlyAutoAllowLowLevelImport === false){
            const conf = await alertConfirm(language.lowLevelAccessConfirm, { stayOpen: true })
            if(!conf) return
        }
        return finish(importData)
    }

    // importData.type === 'risu' conflicts with HypaV3 preset exports.
    // Risu lorebooks use an array while presets use a record.
    if(importData.type === 'risu' && importData.data && Array.isArray(importData.data)){
        const lores:loreBook[] = importData.data
        return finish({
            name: importData.name || 'Imported Lorebook',
            description: importData.description || 'Converted from risu lorebook',
            lorebook: lores,
            id: v4(),
        })
    }
    if(importData.entries){
        const lores:loreBook[] = convertExternalLorebook(importData.entries)
        return finish({
            name: importData.name || 'Imported Lorebook',
            description: importData.description || 'Converted from external lorebook',
            lorebook: lores,
            id: v4(),
        })
    }
    if(importData.type === 'regex' && importData.data){
        const regexs:customscript[] = importData.data
        return finish({
            name: importData.name || 'Imported Regex',
            description: importData.description || 'Converted from risu regex',
            regex: regexs,
            id: v4(),
        })
    }

    throw new Error(language.errors.noData)
}

export async function importModuleFiles(){
    const files = await selectMultipleFile(['json', 'lorebook', 'risum', 'charx'])
    if(!files || files.length === 0) return

    const result = await runImportBatch(files, async (file, report) => {
        await importModuleFile(file, {
            suppressSuccess: true,
            onProgress: report,
        })
    })
    if(result.completed > 0){
        notifySuccess(`${result.completed}/${result.total} ${language.successImport}`)
    }
    return result
}

/**
 * The module page's Proton box import of a link, pasted there or dropped on
 * the page (linkDropImport.ts). False when this build cannot import it itself.
 */
export async function importModuleLink(url: string): Promise<boolean> {
    // A Realm address here: the card comes in as a module, converted the way
    // "Convert to module" converts a bot, without adding the bot.
    const { parseRealmReference } = await import('../realmLink')
    const realmId = parseRealmReference(url, 'uuid')
    if (realmId) {
        const { downloadRisuHubAsModule } = await import('../characterCards')
        await downloadRisuHubAsModule(realmId)
        return true
    }

    // Same server-side path as the character import. It routes each file by
    // extension, and from this page a .charx or .json is a module, as it is
    // for this page's own file picker below.
    if (!isNodeServer) return false
    const { importFromProtonLink } = await import('../protonImport')
    return importFromProtonLink(url, '', 'module')
}

export async function importModuleFromProtonDrive() {
    const url = await askProtonLink('module')
    // Cancel or an empty box imports nothing; local files have their own button.
    if (!url) return
    if (await importModuleLink(url)) return

    if (url && url.includes('drive.proton.me/urls/')) {
        window.open(url, '_blank')
    }

    const files = await selectMultipleFile(['json', 'lorebook', 'risum', 'charx'])
    if (!files || files.length === 0) return

    const result = await runImportBatch(files, async (file, report) => {
        await importModuleFile(file, {
            suppressSuccess: true,
            onProgress: report,
        })
    })
    if (result.completed > 0) {
        notifySuccess(`${result.completed}/${result.total} ${language.successImport}`)
    }
}

