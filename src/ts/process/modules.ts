import { language } from "src/lang"
import { alertClear, alertConfirm, alertError, alertModuleSelect, alertNormal, alertStore, alertWait, notifySuccess } from "../alert"
import { getCurrentCharacter, getCurrentChat, getDatabase, setCurrentCharacter, setDatabase, type Chat, type character, type customscript, type loreBook, type RisuPersona, type triggerscript } from "../storage/database.svelte"
import { AppendableBuffer, downloadFile, forageStorage, loadAssetManifestItems, LocalWriter, readImage, saveAsset, VirtualWriter } from "../globalApi.svelte"
import { checkPersonaBinded, selectMultipleFile, sleep } from "../util"
import { v4 } from "uuid"
import { convertExternalLorebook } from "./lorebook.svelte"
import { compressImage } from '../media'
import type { AssetManifestDescriptor } from '../storage/nodeStorage'
import { decodeRPack, encodeRPack } from "../rpack/rpack_js"
import { HideIconStore, moduleBackgroundEmbedding, ReloadGUIPointer } from "../stores.svelte"
import {get} from "svelte/store"
import { convertCharacterToModule, convertModuleToCharacter } from "../interchangeability"
import { exportCharacterCard, importCharacterProcess } from "../characterCards"
import { collectModuleRuntimeIds, collectModuleRuntimeUi } from "./moduleRuntime"
import { recordModuleFolderActivation, recordNewModules } from "./moduleSort"
import { organizeImportedModuleSimilarity } from "./similarityFolders"
import { runImportBatch, type ImportProgressReporter } from "../importProgress"

export interface MCPModule{
    url: string
}

export interface RisuModule{
    name: string
    description: string
    /** Optional folder membership (see `db.moduleFolders`). Missing means uncategorized. */
    folderId?: string
    /** Optional catalog-only presentation. Missing assets still use the red warning color. */
    titleColor?: string
    favorite?: boolean
    lorebook?: loreBook[]
    regex?: customscript[]
    cjs?: string
    trigger?: triggerscript[]
    id: string
    lowLevelAccess?: boolean
    hideIcon?: boolean
    backgroundEmbedding?:string
    assets?:[string,string,string][]
    assetManifest?:AssetManifestDescriptor
    namespace?:string
    customModuleToggle?:string
    mcp?:MCPModule
    icon?:string
    /** PocketRisu collection provenance. Ignored by upstream clients. */
    sourceInfo?: import('../sourceCollection').SourceImportInfo
}

/** Inserts modules and records them as the newest catalog entries. */
export function addModulesToDatabase(modules: readonly RisuModule[]): void {
    if(modules.length === 0) return
    const db = getDatabase()
    db.modules.push(...modules)
    db.moduleActivationHistory = recordNewModules(
        db.moduleActivationHistory,
        [db.enabledModules],
        modules.map((module) => module.id),
    )
    for(const module of modules){
        organizeImportedModuleSimilarity(db, module.id, v4)
        db.moduleFolders = recordModuleFolderActivation(db.moduleFolders ?? [], db.modules, module.id, {
            activationHistory: db.moduleActivationHistory,
        })
    }
    refreshModules()
}

export function addModuleToDatabase(module: RisuModule): void {
    addModulesToDatabase([module])
}

/** Stable module selection owned by one generation target. */
export interface ModuleRuntimeContext {
    character: character
    chat: Chat
    persona?: RisuPersona | null
    userName?: string
    personaPrompt?: string
    /** Captured once before request awaits; prevents later UI/module toggles from changing this send. */
    modules?: readonly RisuModule[]
}

export async function hydrateModuleAssets(module: RisuModule): Promise<RisuModule> {
    if (Array.isArray(module.assets) || !module.assetManifest) return module
    const hydrated = safeStructuredClone(module)
    hydrated.assets = await loadAssetManifestItems(module.assetManifest) as [string, string, string][]
    delete hydrated.assetManifest
    return hydrated
}

export async function exportModule(module:RisuModule, arg:{
    alertEnd?:boolean
} = {}){
    module = await hydrateModuleAssets(module)
    const alertEnd = arg.alertEnd ?? true

    const char = convertModuleToCharacter(module)
    if(!char.image){
        const res = await fetch('/none.webp')
        const data = new Uint8Array(await res.arrayBuffer())
        char.image = await saveAsset(data)
        char.extentions ??= {}
        char.extentions['moduleNoneImage'] = true
    }
    const writer = new LocalWriter()
    await writer.init(module.name + '.module', ['charx'])
    await exportCharacterCard(char, 'charx', {
        spec: 'v3',
        writer
    })
    if(alertEnd){
        alertNormal(language.successExport)
    }
}

export async function exportModuleLegacy(module:RisuModule, arg:{
    alertEnd?:boolean
    saveData?:boolean
} = {}){
    module = await hydrateModuleAssets(module)
    const alertEnd = arg.alertEnd ?? true
    const saveData = arg.saveData ?? true
    const apb = new AppendableBuffer()
    const writeLength = (len:number) => {
        const lenbuf = Buffer.alloc(4)
        lenbuf.writeUInt32LE(len, 0)
        apb.append(lenbuf)
    }
    const writeByte = (byte:number) => {
        //byte is 0-255
        const buf = Buffer.alloc(1)
        buf.writeUInt8(byte, 0)
        apb.append(buf)
    }

    const assets = module.assets ?? []
    module = safeStructuredClone(module)
    module.assets ??= []
    module.assets = module.assets.map((asset) => {
        return [asset[0], '', asset[2]] as [string,string,string]
    })

    const mainbuf = await encodeRPack(Buffer.from(JSON.stringify({
        module: module,
        type: 'risuModule'
    }, null, 2), 'utf-8'))

    writeByte(111) //magic number
    writeByte(0) //version
    writeLength(mainbuf.length)
    apb.append(mainbuf)

    for(let i=0;i<assets.length;i++){
        const asset = assets[i]
        writeByte(1) //mark as asset
        alertStore.set({
            type: 'wait',
            msg: `Loading... (Adding Assets ${i} / ${assets.length})`
        })
        let rData = await readImage(asset[1])
        if(!rData){
            rData = new Uint8Array(0) //blank buffer
        }
        let encoded = await encodeRPack(Buffer.from(await compressImage(rData)))
        writeLength(encoded.length)
        apb.append(encoded)
    }

    writeByte(0) //end of file

    if(saveData){
        await downloadFile(module.name + '.risum', apb.buffer)
    }
    if(alertEnd){
        notifySuccess(language.successExport)
    }

    return apb.buffer
}

export async function readModule(
    buf: Buffer,
    options: { onProgress?: ImportProgressReporter } = {},
):Promise<RisuModule> {
    let pos = 0

    const readLength = () => {
        const len = buf.readUInt32LE(pos)
        pos += 4
        return len
    }
    const readByte = () => {
        const byte = buf.readUInt8(pos)
        pos += 1
        return byte
    }
    const readData = (len:number) => {
        const data = buf.subarray(pos, pos + len)
        pos += len
        return data
    }

    if(readByte() !== 111){
        console.error("Invalid magic number")
        alertError(language.errors.noData)
        return
    }
    if(readByte() !== 0){ //Version check
        console.error("Invalid version")
        alertError(language.errors.noData)
        return
    }

    const mainLen = readLength()
    const mainData = readData(mainLen)
    const main:{
        type:'risuModule'
        module:RisuModule
    } = JSON.parse(Buffer.from(await decodeRPack(mainData)).toString())

    if(main.type !== 'risuModule'){
        console.error("Invalid module type")
        alertError(language.errors.noData)
        return
    }

    let module = main.module

    const maxConcurrentAssetSaves = 10
    const retryDelayMs = 5000
    const maxRetries = 3
    const totalAssets = module.assets?.length ?? 0
    let completed = 0

    type AssetTask = {
        index: number
        data: Uint8Array
    }

    const runAssetTasks = async (tasks: AssetTask[]) => {
        if (tasks.length === 0) {
            return []
        }
        const inFlight = new Set<Promise<void>>()
        const failed: AssetTask[] = []
        const runTask = (task: AssetTask) => {
            const promise = (async () => {
                try {
                    const decoded = await decodeRPack(task.data)
                    if (!module.assets?.[task.index]) {
                        throw new Error(`Missing asset metadata for index ${task.index}`)
                    }
                    module.assets[task.index][1] = await saveAsset(decoded)
                    completed += 1
                } catch (error) {
                    failed.push(task)
                } finally {
                    if(options.onProgress){
                        options.onProgress({
                            label: `${language.importProgress.savingAssets} (${completed}/${totalAssets})`,
                            progress: totalAssets > 0 ? 20 + (completed / totalAssets * 65) : 85,
                        })
                    } else {
                        alertWait(`Loading... (Adding Assets ${completed} / ${totalAssets})`)
                    }
                }
            })()
            inFlight.add(promise)
            promise.finally(() => inFlight.delete(promise))
        }

        for (const task of tasks) {
            while (inFlight.size >= maxConcurrentAssetSaves) {
                await Promise.race(inFlight)
            }
            runTask(task)
        }

        await Promise.all(inFlight)
        return failed
    }

    const tasks: AssetTask[] = []
    let i = 0
    while(true){
        const mark = readByte()
        if(mark === 0){
            break
        }
        if(mark !== 1){
            alertError(language.errors.noData)
            return
        }
        const len = readLength()
        const data = readData(len)
        tasks.push({
            index: i,
            data
        })
        i++
    }

    try {
        let failed = await runAssetTasks(tasks)
        let retryCount = 0
        while (failed.length > 0 && retryCount < maxRetries) {
            await sleep(retryDelayMs)
            retryCount += 1
            failed = await runAssetTasks(failed)
        }
        if (failed.length > 0) {
            throw new Error(`Failed to save ${failed.length} assets`)
        }
    } finally {
        if(!options.onProgress) alertClear()
    }

    module.id = v4()
    return module
}

export interface ImportModuleFileOptions {
    suppressSuccess?: boolean
    onProgress?: ImportProgressReporter
}

export async function importModuleFile(
    file: { name: string, data: Uint8Array },
    options: ImportModuleFileOptions = {},
): Promise<RisuModule | undefined> {
    const fileName = file.name.toLocaleLowerCase()
    const finish = (module: RisuModule) => {
        addModuleToDatabase(module)
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
            data: Buffer.from(file.data),
            returnCharacter: true,
            onProgress: options.onProgress,
            suppressSuccess: true,
        })
        if(!char || typeof char === 'number'){
            throw new Error(language.errors.noData)
        }
        return finish(convertCharacterToModule(char))
    }

    if(fileName.endsWith('.risum')){
        options.onProgress?.({
            label: language.importProgress.readingModule,
            progress: 20,
        })
        const module = await readModule(Buffer.from(file.data), {
            onProgress: options.onProgress,
        })
        if(!module) throw new Error(language.errors.noData)
        return finish(module)
    }

    const importData = JSON.parse(Buffer.from(file.data).toString())
    if(importData.type === 'risuModule'){
        if((!importData.name) || (!importData.id)){
            throw new Error(language.errors.noData)
        }
        importData.id = v4()

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

        if(importData.lowLevelAccess){
            const conf = await alertConfirm(language.lowLevelAccessConfirm)
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

export async function importModule(){
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

function getModuleById(id:string){
    const db = getDatabase()
    for(let i=0;i<db.modules.length;i++){
        if(db.modules[i].id === id){
            return db.modules[i]
        }
    }

    if(id === '$embedded'){
        const persona = checkPersonaBinded()
        if(persona && persona.embeddedModule){
            return persona.embeddedModule
        }
    }
    return null
}

function getModuleByIds(ids:string[]){
    const db = getDatabase()
    const idSet = new Set(ids)
    const modules = db.modules.filter(m =>
        idSet.has(m.id) || (m.namespace && idSet.has(m.namespace))
    )
    // The bound persona's embedded module lives on the persona, not in
    // db.modules; getModules() lists its id but it was never resolved here.
    if(idSet.has('$embedded')){
        const embedded = getModuleById('$embedded')
        if(embedded){
            modules.push(embedded)
        }
    }
    return deduplicateModuleById(modules)
}

function deduplicateModuleById(modules:RisuModule[]){
    let ids:string[] = []
    let newModules:RisuModule[] = []
    for(let i=0;i<modules.length;i++){
        if(ids.includes(modules[i].id)){
            continue
        }
        ids.push(modules[i].id)
        newModules.push(modules[i])
    }
    return newModules
}

let lastModules = ''
let lastModuleData:RisuModule[] = []
export function getModules(context?:ModuleRuntimeContext){
    if(context?.modules) return [...context.modules]

    const currentChat = context?.chat ?? getCurrentChat()
    const character = context?.character ?? getCurrentCharacter()
    const db = getDatabase()
    const persona = context
        ? (context.persona !== undefined
            ? context.persona
            : (currentChat.bindedPersona ? db.personas.find((value) => value.id === currentChat.bindedPersona) : null))
        : checkPersonaBinded()
    const ids = collectModuleRuntimeIds({
        enabledModules: db.enabledModules,
        chatModules: currentChat?.modules,
        characterModules: character?.modules,
        embeddedModuleId: persona?.embeddedModule?.id,
        moduleIntegration: db.moduleIntergration,
    })
    const idsJoined = ids.join('-') + (persona?.embeddedModule ? `|persona:${persona.id ?? persona.name}` : '')
    // Explicit generation contexts deliberately bypass the UI cache. Two
    // persona-embedded modules may share the conventional `$embedded` id, and
    // a cache keyed only by ids would leak the previously selected persona.
    if(!context && lastModules === idsJoined){
        return lastModuleData
    }

    let modules:RisuModule[] = getModuleByIds(ids)
    if(persona?.embeddedModule && ids.includes(persona.embeddedModule.id)
        && !modules.some((module) => module === persona.embeddedModule)){
        modules.push(persona.embeddedModule)
    }
    if(!context){
        lastModules = idsJoined
        lastModuleData = modules
    }
    return modules

}

export function captureModuleRuntimeContext(character:character, chat:Chat):ModuleRuntimeContext {
    const db = getDatabase()
    const persona = chat.bindedPersona
        ? db.personas.find((value) => value.id === chat.bindedPersona) ?? null
        : db.personas?.[db.selectedPersona] ?? null
    const context:ModuleRuntimeContext = {
        character,
        chat,
        persona,
        userName: persona?.name ?? db.username ?? 'User',
        personaPrompt: persona?.personaPrompt ?? db.personaPrompt ?? '',
    }
    return { ...context, modules: getModules(context) }
}

export function getModuleLorebooks(context?:ModuleRuntimeContext) {
    const modules = getModules(context)
    let lorebooks: loreBook[] = []
    for (const module of modules) {
        if(!module){
            continue
        }
        if (module.lorebook) {
            lorebooks = lorebooks.concat(module.lorebook)
        }
    }
    return lorebooks
}

export function getModuleAssets(context?:ModuleRuntimeContext) {
    const modules = getModules(context)
    let assets: [string,string,string][] = []
    for (const module of modules) {
        if(!module){
            continue
        }
        if (module.assets) {
            assets = assets.concat(module.assets)
        }
    }
    return assets
}


export function getModuleTriggers(context?:ModuleRuntimeContext) {
    const modules = getModules(context)
    let triggers: triggerscript[] = []
    for (const module of modules) {
        if(!module){
            continue
        }
        if (module.trigger) {
            // Copy rather than mutate: getModules() caches the RisuModule objects
            // (lastModuleData), so writing onto `t` writes into the stored module
            // and would leak runtime-only fields (moduleId) into .risum exports.
            triggers = triggers.concat(module.trigger.map((t) => ({
                ...t,
                lowLevelAccess: module.lowLevelAccess,
                moduleId: module.id,
            })))
        }
    }
    return triggers
}

export function getModuleRegexScripts(context?:ModuleRuntimeContext) {
    const modules = getModules(context)
    let customscripts: customscript[] = []
    for (const module of modules) {
        if(!module){
            continue
        }
        if (module.regex) {
            customscripts = customscripts.concat(module.regex)
        }
    }
    return customscripts
}

export function getModuleToggles(context?:ModuleRuntimeContext) {
    const modules = getModules(context)
    let costomModuleToggles: string = ''
    for (const module of modules) {
        if(!module){
            continue
        }
        if (module.customModuleToggle) {
            costomModuleToggles += '\n' + module.customModuleToggle + '\n'
        }
    }
    return costomModuleToggles
}

export function getModuleMcps(context?:ModuleRuntimeContext) {
    const modules = getModules(context)

    return modules.map((v) => v.mcp?.url).filter((v) => v)
}

export async function applyModule() {
    const sel = await alertModuleSelect()
    if (!sel) {
        return
    }

    const module = safeStructuredClone(getModuleById(sel))
    if (!module) {
        return
    }

    const currentChar = getCurrentCharacter()
    if (!currentChar) {
        return
    }
    if (module.lorebook) {
        for (const lore of module.lorebook) {
            currentChar.globalLore.push(lore)
        }
    }
    if (module.regex) {
        for (const regex of module.regex) {
            currentChar.customscript.push(regex)
        }
    }
    if (module.trigger) {
        for (const trigger of module.trigger) {
            currentChar.triggerscript.push(trigger)
        }
    }

    setCurrentCharacter(currentChar)

    notifySuccess(language.successApplyModule)
}

let lastModuleIds:string = ''

export function moduleUpdate(){


    const m = getModules()
    const runtimeUi = collectModuleRuntimeUi(m)

    // Always publish, including ''. Otherwise disabling/removing the final
    // embedding leaves the previous module background stuck in the store.
    moduleBackgroundEmbedding.set(runtimeUi.backgroundEmbedding)
    HideIconStore.set(getCurrentCharacter()?.hideChatIcon || runtimeUi.hideIcon)

    if(lastModuleIds !== runtimeUi.ids){
        ReloadGUIPointer.set(get(ReloadGUIPointer) + 1)
        lastModuleIds = runtimeUi.ids
    }
}

export function refreshModules(){
    lastModules = ''
    lastModuleData = []
}
