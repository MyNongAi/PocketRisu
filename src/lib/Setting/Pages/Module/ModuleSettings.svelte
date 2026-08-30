<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    
    import { DBState } from 'src/ts/stores.svelte';
    import Button from "src/lib/UI/GUI/Button.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { addModuleToDatabase, exportModule, importModule, refreshModules, type RisuModule } from "src/ts/process/modules";
    import {
        ChevronDownIcon,
        ChevronRightIcon,
        FolderIcon,
        FolderInputIcon,
        FolderPlusIcon,
        Globe,
        GripVerticalIcon,
        HardDriveUpload,
        PlusIcon,
        Share2Icon,
        SquarePen,
        TrashIcon,
        Waypoints,
        XIcon,
    } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { tooltip } from "src/ts/gui/tooltip";
    import { alertConfirm, alertInput, notifyError, notifySuccess } from "src/ts/alert";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { onDestroy } from "svelte";
    import { importMCPModule } from "src/ts/process/mcp/mcp";
    import { convertModuleToCharacter } from "src/ts/interchangeability";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import { recordModuleActivation, seedModuleActivationHistory, sortModulesByActivation } from "src/ts/process/moduleSort";
    import {
        assignModuleToFolder,
        buildModuleFolderCatalog,
        findModuleFolderId,
        moveModuleByDrop,
        moveModuleFolderByDrop,
        normalizeModuleFolders,
        type ModuleFolder,
    } from "src/ts/process/moduleFolders";
    import { resolveModuleEditTargetIndex } from "src/ts/process/moduleEditing";
    import MeasuredVirtualList from "src/lib/UI/Virtual/MeasuredVirtualList.svelte";
    import type { ModuleCatalogEntry } from "src/ts/process/moduleFolders";
    import type { ModuleDropTarget } from "src/ts/process/moduleFolders";
    import type { ModuleFolderDropTarget } from "src/ts/process/moduleFolders";
    import { importDroppedFiles } from "src/ts/dropImport";
    import { RISU_APP_INTERNAL_DRAG_TYPE, RISU_SIDEBAR_DRAG_TYPE } from "src/ts/dragTypes";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";

    type ModuleCatalogRow =
        | { kind: 'module'; module: RisuModule; nested: boolean }
        | { kind: 'folder'; entry: Extract<ModuleCatalogEntry<RisuModule>, { kind: 'folder' }> }
        | { kind: 'empty-folder'; folderId: string }

    type ModulePointerDrag = {
        pointerId: number
        startX: number
        startY: number
        kind: 'module' | 'folder'
        id: string
        active: boolean
    }

    let tempModule:RisuModule = $state({
        name: '',
        description: '',
        id: v4(),
    })
    let mode = $state(0)
    let editModuleId = $state('')
    let editModuleOriginal:RisuModule|null = null
    let moduleSearch = $state('')
    let folderPickerModule:RisuModule|null = $state(null)
    let draggedModuleId = $state('')
    let draggedFolderId = $state('')
    let moduleDropIndicator = $state('')
    let externalModuleDropActive = $state(false)
    let folderCreateOpen = $state(false)
    let newFolderName = $state('')
    let modulePointerDrag:ModulePointerDrag|null = null
    let draggingModuleCatalogItem = $derived(!!draggedModuleId || !!draggedFolderId)
    let { quickPanel = false }: { quickPanel?: boolean } = $props()
    let moduleFolders = $derived(normalizeModuleFolders(DBState.db.moduleFolders))
    const moduleVirtualKeys = new WeakMap<RisuModule, string>()
    let nextModuleVirtualKey = 0

    function moduleCatalog(modules:RisuModule[], search:string){
        const sortedModules = sortModulesByActivation(modules, '', {
            fallbackOrders: [DBState.db.enabledModules],
            activationHistory: DBState.db.moduleActivationHistory,
        })
        return buildModuleFolderCatalog(sortedModules, moduleFolders, search)
    }

    function moduleVirtualKey(module: RisuModule){
        let key = moduleVirtualKeys.get(module)
        if(!key){
            key = `module-object:${nextModuleVirtualKey++}`
            moduleVirtualKeys.set(module, key)
        }
        return key
    }

    function catalogRowKey(row: ModuleCatalogRow){
        if(row.kind === 'module') return moduleVirtualKey(row.module)
        if(row.kind === 'folder') return `folder:${row.entry.folder.id}`
        return `folder-empty:${row.folderId}`
    }

    let moduleCatalogRows = $derived.by<ModuleCatalogRow[]>(() => {
        const rows: ModuleCatalogRow[] = []
        const searchActive = moduleSearch.trim() !== ''
        for(const entry of moduleCatalog(DBState.db.modules, moduleSearch)){
            if(entry.kind === 'module'){
                rows.push({ kind: 'module', module: entry.module, nested: false })
                continue
            }

            rows.push({ kind: 'folder', entry })
            if(entry.folder.collapsed && !searchActive) continue
            if(entry.modules.length === 0){
                rows.push({ kind: 'empty-folder', folderId: entry.folder.id })
                continue
            }
            for(const module of entry.modules){
                rows.push({ kind: 'module', module, nested: true })
            }
        }
        return rows
    })

    function updateFolders(updater: (folders: ModuleFolder[]) => ModuleFolder[]){
        DBState.db.moduleFolders = normalizeModuleFolders(updater(moduleFolders))
    }

    function openFolderCreator(){
        newFolderName = ''
        folderCreateOpen = true
    }

    function createFolder(){
        const name = newFolderName.trim()
        if(!name) return
        updateFolders((folders) => [
            { id: v4(), name, moduleIds: [] },
            ...folders,
        ])
        folderCreateOpen = false
        newFolderName = ''
    }

    function modulesInFolder(folder: ModuleFolder){
        const ids = new Set(folder.moduleIds)
        return DBState.db.modules.filter((module) => ids.has(module.id))
    }

    async function renameFolder(folder: ModuleFolder){
        const name = (await alertInput(language.changeFolderName, [], folder.name)).trim()
        if(!name || name === folder.name) return
        updateFolders((folders) => folders.map((item) => item.id === folder.id
            ? { ...item, name }
            : item,
        ))
    }

    async function deleteFolder(folder: ModuleFolder){
        if(!await alertConfirm(`${folder.name}\n\n${language.moduleFolderDeleteConfirm}`)) return
        updateFolders((folders) => folders.filter((item) => item.id !== folder.id))
        notifySuccess(language.moduleFolderContentsKept)
    }

    function toggleFolder(folder: ModuleFolder){
        updateFolders((folders) => folders.map((item) => item.id === folder.id
            ? { ...item, collapsed: !item.collapsed }
            : item,
        ))
    }

    function toggleFolderModules(modules: RisuModule[]){
        const moduleIds = modules.map((module) => module.id)
        if(moduleIds.length === 0) return

        const enabledModules = new Set(DBState.db.enabledModules)
        const shouldEnableAll = moduleIds.some((id) => !enabledModules.has(id))
        let activationHistory = seedModuleActivationHistory(
            DBState.db.moduleActivationHistory,
            DBState.db.enabledModules,
        )

        if(shouldEnableAll){
            for(const id of moduleIds){
                enabledModules.add(id)
                activationHistory = recordModuleActivation(activationHistory, id)
            }
        }
        else{
            for(const id of moduleIds) enabledModules.delete(id)
        }

        DBState.db.moduleActivationHistory = activationHistory
        DBState.db.enabledModules = [...enabledModules]
    }

    function moveModuleToFolder(moduleId: string, folderId: string){
        DBState.db.moduleFolders = assignModuleToFolder(
            moduleFolders,
            moduleId,
            folderId,
        )
        folderPickerModule = null
    }

    function currentOrderedModuleIds(){
        const ids:string[] = []
        for(const entry of moduleCatalog(DBState.db.modules, '')){
            if(entry.kind === 'module') ids.push(entry.module.id)
            else ids.push(...entry.modules.map((module) => module.id))
        }
        return ids
    }

    function clearModuleDrag(){
        draggedModuleId = ''
        draggedFolderId = ''
        moduleDropIndicator = ''
    }

    function setModuleDragSource(kind: 'module' | 'folder', id: string){
        draggedModuleId = kind === 'module' ? id : ''
        draggedFolderId = kind === 'folder' ? id : ''
        folderPickerModule = null
    }

    function beginModuleDrag(event: DragEvent, module: RisuModule){
        setModuleDragSource('module', module.id)
        if(event.dataTransfer){
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData(RISU_APP_INTERNAL_DRAG_TYPE, 'module')
            // The visible drag label should never expose a malformed legacy id
            // as the literal string "null". Internal routing uses component
            // state and the app-wide custom drag marker, not this text payload.
            event.dataTransfer.setData('text/plain', module.name || language.modules)
        }
    }

    function beginFolderDrag(event: DragEvent, folder: ModuleFolder){
        if(moduleSearch.trim() !== ''){
            event.preventDefault()
            return
        }
        setModuleDragSource('folder', folder.id)
        if(event.dataTransfer){
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData(RISU_APP_INTERNAL_DRAG_TYPE, 'module-folder')
            // Folder ids are internal metadata. Imported legacy data can carry
            // malformed ids such as the literal string "null", which browsers
            // expose as the visible drag label. The component state is the
            // source of truth, so only show a human-readable folder name here.
            event.dataTransfer.setData('text/plain', folder.name || language.modules)
        }
    }

    function allowModuleDrop(event: DragEvent, indicator: string){
        if(!draggingModuleCatalogItem) return
        event.preventDefault()
        // App.svelte owns the global file-import surface and marks every
        // internal drag as dropEffect=none. Stop here after accepting a module
        // catalog drop so that outer fallback cannot cancel the valid target.
        event.stopPropagation()
        if(event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        moduleDropIndicator = indicator
    }

    function applyModuleDrop(event: DragEvent, target: ModuleDropTarget){
        if(!draggedModuleId) return
        event.preventDefault()
        event.stopPropagation()
        commitModuleDrop(target)
    }

    function commitModuleDrop(target: ModuleDropTarget){
        if(!draggedModuleId) return
        const moved = moveModuleByDrop(
            currentOrderedModuleIds(),
            moduleFolders,
            draggedModuleId,
            target,
        )
        DBState.db.moduleFolders = moved.folders
        // moduleActivationHistory stores oldest -> newest, while the catalog is
        // top -> bottom. A later activation still moves that module to the top.
        DBState.db.moduleActivationHistory = [...moved.orderedModuleIds].reverse()
        clearModuleDrag()
    }

    function applyFolderDrop(event: DragEvent, target: ModuleFolderDropTarget){
        if(!draggedFolderId) return
        event.preventDefault()
        event.stopPropagation()
        commitFolderDrop(target)
    }

    function commitFolderDrop(target: ModuleFolderDropTarget){
        if(!draggedFolderId) return
        const moved = moveModuleFolderByDrop(
            currentOrderedModuleIds(),
            moduleFolders,
            draggedFolderId,
            target,
        )
        DBState.db.moduleFolders = moved.folders
        DBState.db.moduleActivationHistory = [...moved.orderedModuleIds].reverse()
        clearModuleDrag()
    }

    function moduleDropPosition(event: DragEvent, moduleId: string){
        const bounds = event.currentTarget instanceof HTMLElement
            ? event.currentTarget.getBoundingClientRect()
            : null
        const position = bounds && event.clientY > bounds.top + bounds.height / 2
            ? 'after'
            : 'before'
        return {
            target: { kind: 'module', moduleId, position } as const,
            indicator: `module:${moduleId}:${position}`,
        }
    }

    function previewModuleDrop(event: DragEvent, moduleId: string){
        if(draggedModuleId === moduleId) return
        if(draggedFolderId && findModuleFolderId(moduleFolders, moduleId) === draggedFolderId) return
        if(!draggingModuleCatalogItem) return
        const placement = moduleDropPosition(event, moduleId)
        allowModuleDrop(event, placement.indicator)
    }

    function dropBesideModule(event: DragEvent, moduleId: string){
        if(draggedModuleId === moduleId) return
        if(draggedFolderId && findModuleFolderId(moduleFolders, moduleId) === draggedFolderId) return
        const target = moduleDropPosition(event, moduleId).target
        if(draggedModuleId) applyModuleDrop(event, target)
        else if(draggedFolderId) applyFolderDrop(event, target)
    }

    function folderDropPosition(event: DragEvent, folderId: string){
        const bounds = event.currentTarget instanceof HTMLElement
            ? event.currentTarget.getBoundingClientRect()
            : null
        const position = bounds && event.clientY > bounds.top + bounds.height / 2
            ? 'after'
            : 'before'
        return {
            target: { kind: 'folder', folderId, position } as const,
            indicator: `folder-order:${folderId}:${position}`,
        }
    }

    function previewFolderDrop(event: DragEvent, folderId: string){
        if(draggedModuleId){
            allowModuleDrop(event, `folder:${folderId}`)
            return
        }
        if(!draggedFolderId || draggedFolderId === folderId) return
        allowModuleDrop(event, folderDropPosition(event, folderId).indicator)
    }

    function dropOnFolder(event: DragEvent, folderId: string){
        if(draggedModuleId){
            applyModuleDrop(event, { kind: 'folder', folderId })
            return
        }
        if(!draggedFolderId || draggedFolderId === folderId) return
        applyFolderDrop(event, folderDropPosition(event, folderId).target)
    }

    function dropAtRoot(event: DragEvent){
        if(draggedModuleId) applyModuleDrop(event, { kind: 'root' })
        else if(draggedFolderId) applyFolderDrop(event, { kind: 'root' })
    }

    function pointerDropTarget(clientX: number, clientY: number):ModuleDropTarget|ModuleFolderDropTarget|null{
        const hit = document.elementFromPoint(clientX, clientY)
        if(!(hit instanceof Element)) return null

        if(hit.closest('[data-module-root-drop]')) return { kind: 'root' }

        const folderTarget = hit.closest<HTMLElement>('[data-module-folder-drop]')
        if(folderTarget){
            const folderId = folderTarget.dataset.moduleFolderDrop
            if(!folderId) return null
            if(draggedModuleId) return { kind: 'folder', folderId }
            if(draggedFolderId && draggedFolderId !== folderId){
                const bounds = folderTarget.getBoundingClientRect()
                return {
                    kind: 'folder',
                    folderId,
                    position: clientY > bounds.top + bounds.height / 2 ? 'after' : 'before',
                }
            }
            return null
        }

        const moduleTarget = hit.closest<HTMLElement>('[data-module-drop-id]')
        const moduleId = moduleTarget?.dataset.moduleDropId
        if(!moduleTarget || !moduleId || draggedModuleId === moduleId) return null
        if(draggedFolderId && findModuleFolderId(moduleFolders, moduleId) === draggedFolderId) return null
        const bounds = moduleTarget.getBoundingClientRect()
        return {
            kind: 'module',
            moduleId,
            position: clientY > bounds.top + bounds.height / 2 ? 'after' : 'before',
        }
    }

    function pointerDropIndicator(target: ModuleDropTarget|ModuleFolderDropTarget|null){
        if(!target) return ''
        if(target.kind === 'root') return 'root'
        if(target.kind === 'module') return `module:${target.moduleId}:${target.position}`
        if('position' in target) return `folder-order:${target.folderId}:${target.position}`
        return `folder:${target.folderId}`
    }

    function removeModulePointerListeners(){
        window.removeEventListener('pointermove', moveModulePointerDrag)
        window.removeEventListener('pointerup', finishModulePointerDrag)
        window.removeEventListener('pointercancel', cancelModulePointerDrag)
    }

    function startModulePointerDrag(event: PointerEvent, kind: 'module'|'folder', id: string){
        if(!event.isPrimary || event.button !== 0) return
        if(kind === 'folder' && moduleSearch.trim() !== '') return
        removeModulePointerListeners()
        modulePointerDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            kind,
            id,
            active: false,
        }
        window.addEventListener('pointermove', moveModulePointerDrag, { passive: false })
        window.addEventListener('pointerup', finishModulePointerDrag)
        window.addEventListener('pointercancel', cancelModulePointerDrag)
        event.preventDefault()
        event.stopPropagation()
    }

    function moveModulePointerDrag(event: PointerEvent){
        const drag = modulePointerDrag
        if(!drag || event.pointerId !== drag.pointerId) return
        if(!drag.active){
            if(Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return
            drag.active = true
            setModuleDragSource(drag.kind, drag.id)
        }
        if(event.cancelable) event.preventDefault()
        moduleDropIndicator = pointerDropIndicator(pointerDropTarget(event.clientX, event.clientY))
    }

    function finishModulePointerDrag(event: PointerEvent){
        const drag = modulePointerDrag
        if(!drag || event.pointerId !== drag.pointerId) return
        const target = drag.active ? pointerDropTarget(event.clientX, event.clientY) : null
        modulePointerDrag = null
        removeModulePointerListeners()
        if(target){
            if(drag.kind === 'module') commitModuleDrop(target as ModuleDropTarget)
            else commitFolderDrop(target as ModuleFolderDropTarget)
        } else {
            clearModuleDrag()
        }
        if(drag.active){
            event.preventDefault()
            event.stopPropagation()
        }
    }

    function cancelModulePointerDrag(event?: PointerEvent){
        if(event && modulePointerDrag && event.pointerId !== modulePointerDrag.pointerId) return
        modulePointerDrag = null
        removeModulePointerListeners()
        clearModuleDrag()
    }

    function createModule(){
        editModuleId = ''
        editModuleOriginal = null
        tempModule = {
            name: '',
            description: '',
            id: v4(),
        }
        mode = 1
    }

    function isExternalFileDrag(event: DragEvent){
        const types = Array.from(event.dataTransfer?.types ?? [])
        return types.includes('Files')
            && !types.includes(RISU_APP_INTERNAL_DRAG_TYPE)
            && !types.includes(RISU_SIDEBAR_DRAG_TYPE)
    }

    function previewExternalModuleImport(event: DragEvent){
        if(!isExternalFileDrag(event)) return
        event.preventDefault()
        event.stopPropagation()
        if(event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
        externalModuleDropActive = true
    }

    function leaveExternalModuleImport(event: DragEvent){
        if(!externalModuleDropActive) return
        const nextTarget = event.relatedTarget
        const surface = event.currentTarget as HTMLElement
        if(nextTarget instanceof Node && surface.contains(nextTarget)) return
        externalModuleDropActive = false
    }

    async function dropExternalFilesAsModules(event: DragEvent){
        if(!isExternalFileDrag(event) || !event.dataTransfer?.files.length) return
        event.preventDefault()
        event.stopPropagation()
        externalModuleDropActive = false
        await importDroppedFiles(Array.from(event.dataTransfer.files), 'module')
    }

    onDestroy(() => {
        cancelModulePointerDrag()
        refreshModules()
    })
</script>

{#snippet moduleActions()}
    <button
        type="button"
        class="text-textcolor2 hover:text-primary cursor-pointer"
        aria-label={language.createModuleFolder}
        use:tooltip={language.createModuleFolder}
        onclick={openFolderCreator}
    >
        <FolderPlusIcon />
    </button>
    <button
        type="button"
        class="text-textcolor2 hover:text-primary cursor-pointer"
        aria-label={language.createModule}
        use:tooltip={language.createModule}
        onclick={createModule}
    >
        <PlusIcon />
    </button>
    <button
        type="button"
        class="text-textcolor2 hover:text-primary cursor-pointer"
        aria-label={`MCP ${language.importModule}`}
        use:tooltip={`MCP ${language.importModule}`}
        onclick={() => { void importMCPModule() }}
    >
        <Waypoints />
    </button>
    <button
        type="button"
        class="text-textcolor2 hover:text-primary cursor-pointer"
        aria-label={language.importModule}
        use:tooltip={language.importModule}
        onclick={() => { void importModule() }}
    >
        <HardDriveUpload />
    </button>
{/snippet}

{#snippet moduleRow(rmodule: RisuModule, nested = false)}
    <div
        class={`${nested
            ? "relative ml-4 border-b border-l border-selected"
            : "relative border-b border-selected"
        } ${moduleDropIndicator === `module:${rmodule.id}:before` ? 'border-t-2 border-t-primary' : ''}
          ${moduleDropIndicator === `module:${rmodule.id}:after` ? 'border-b-2 border-b-primary' : ''}
          ${draggedModuleId === rmodule.id ? 'opacity-55' : ''}`}
        data-module-drop-id={rmodule.id}
        role="group"
        aria-label={rmodule.name}
        ondragover={(event) => previewModuleDrop(event, rmodule.id)}
        ondrop={(event) => dropBesideModule(event, rmodule.id)}
    >
        <div class="pl-3 pt-3 text-left flex items-center">
            <button
                type="button"
                class="mr-2 shrink-0 cursor-grab touch-none text-textcolor2 hover:text-primary active:cursor-grabbing"
                draggable={true}
                aria-label={`${language.moveToModuleFolder}: ${rmodule.name}`}
                use:tooltip={language.moveToModuleFolder}
                onclick={(event) => event.stopPropagation()}
                onpointerdown={(event) => startModulePointerDrag(event, 'module', rmodule.id)}
                ondragstart={(event) => beginModuleDrag(event, rmodule)}
                ondragend={clearModuleDrag}
            >
                <GripVerticalIcon size={18}/>
            </button>
            {#if rmodule.mcp}
                <Waypoints size={18} class="mr-2" />
            {/if}
            <span class:text-red-400={(rmodule.sourceInfo?.missingAssetCount ?? 0) > 0} class="font-bold min-w-0 truncate">{rmodule.name}</span>
            <div class="grow flex justify-end">
                <button
                    class={folderPickerModule === rmodule
                        ? "mr-2 cursor-pointer text-primary"
                        : "text-textcolor2 hover:text-primary mr-2 cursor-pointer"
                    }
                    aria-label={language.moveToModuleFolder}
                    use:tooltip={language.moveToModuleFolder}
                    onclick={(e) => {
                        e.stopPropagation()
                        folderPickerModule = folderPickerModule === rmodule ? null : rmodule
                    }}
                >
                    <FolderInputIcon size={18}/>
                </button>
                <button class={(DBState.db.enabledModules.includes(rmodule.id)) ?
                        "mr-2 cursor-pointer text-blue-500" :
                        rmodule.namespace &&
                        DBState.db.moduleIntergration?.split(',').map((s) => s.trim()).includes(rmodule.namespace) ?
                        "text-amber-500 hover:text-primary mr-2 cursor-pointer" :
                        "text-textcolor2 hover:text-primary mr-2 cursor-pointer"
                    } use:tooltip={language.enableGlobal} onclick={async (e) => {
                    e.stopPropagation()
                    let activationHistory = seedModuleActivationHistory(
                        DBState.db.moduleActivationHistory,
                        DBState.db.enabledModules,
                    )
                    if(DBState.db.enabledModules.includes(rmodule.id)){
                        DBState.db.enabledModules.splice(DBState.db.enabledModules.indexOf(rmodule.id), 1)
                    }
                    else{
                        DBState.db.enabledModules.push(rmodule.id)
                        activationHistory = recordModuleActivation(
                            activationHistory,
                            rmodule.id,
                        )
                    }
                    DBState.db.moduleActivationHistory = activationHistory
                    DBState.db.enabledModules = DBState.db.enabledModules
                }}>
                    <Globe size={18}/>
                </button>
                {#if !rmodule.mcp}
                    <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" use:tooltip={language.download} onclick={async (e) => {
                        e.stopPropagation()
                        exportModule(rmodule)
                    }}>
                        <Share2Icon size={18}/>
                    </button>
                    <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" use:tooltip={language.edit} onclick={async (e) => {
                        e.stopPropagation()
                        tempModule = safeStructuredClone(rmodule)
                        editModuleId = rmodule.id
                        editModuleOriginal = rmodule
                        mode = 2
                    }}>
                        <SquarePen size={18}/>
                    </button>
                {:else}
                    <button class="text-textcolor2 mr-2 cursor-not-allowed" aria-disabled="true">
                        <Share2Icon size={18}/>
                    </button>
                    <button class="text-textcolor2 mr-2 cursor-not-allowed" aria-disabled="true">
                        <SquarePen size={18}/>
                    </button>
                {/if}
                <button class="text-textcolor2 hover:text-red-400 mr-2 cursor-pointer" use:tooltip={language.remove} onclick={async (e) => {
                    e.stopPropagation()
                    const d = await alertConfirm(`${language.removeConfirm}` + rmodule.name)
                    if(d){
                        if(DBState.db.enabledModules.includes(rmodule.id)){
                            DBState.db.enabledModules.splice(DBState.db.enabledModules.indexOf(rmodule.id), 1)
                            DBState.db.enabledModules = DBState.db.enabledModules
                        }
                        const index = resolveModuleEditTargetIndex(DBState.db.modules, rmodule.id, rmodule)
                        if(index !== -1) DBState.db.modules.splice(index, 1)
                        DBState.db.modules = DBState.db.modules
                        DBState.db.moduleActivationHistory = DBState.db.moduleActivationHistory?.filter((id) => id !== rmodule.id) ?? []
                        DBState.db.moduleFolders = moduleFolders.map((folder) => ({
                            ...folder,
                            moduleIds: folder.moduleIds.filter((id) => id !== rmodule.id),
                        }))
                        if(folderPickerModule === rmodule) folderPickerModule = null
                        notifySuccess(language.moduleDeleted)
                    }
                }}>
                    <TrashIcon size={18}/>
                </button>
            </div>
        </div>
        <div class="mt-1 mb-3 px-3">
            <span class="text-sm text-textcolor2">{rmodule.description || 'No description provided'}</span>
        </div>
        {#if folderPickerModule === rmodule}
            <!-- Overlay the picker inside the existing row instead of growing
                 a measured virtual row. Row-height mutations during the same
                 Svelte flush produced a spurious null rejection in long lists. -->
            <div class="absolute inset-x-3 top-10 z-30 flex items-center gap-2 rounded-md border border-selected bg-darkbg p-2 shadow-lg">
                <FolderInputIcon size={16} class="shrink-0 text-textcolor2" />
                <select
                    class="min-w-0 grow rounded-md border border-darkborderc bg-transparent px-2 py-1 text-textcolor"
                    value={findModuleFolderId(moduleFolders, rmodule.id)}
                    aria-label={language.moveToModuleFolder}
                    onchange={(event) => moveModuleToFolder(rmodule.id, event.currentTarget.value)}
                >
                    <option class="bg-darkbg" value="">{language.moduleFolderRoot}</option>
                    {#each moduleFolders as folder (folder.id)}
                        <option class="bg-darkbg" value={folder.id}>{folder.name}</option>
                    {/each}
                </select>
                <button
                    type="button"
                    class="shrink-0 cursor-pointer text-textcolor2 hover:text-primary"
                    aria-label={language.cancel}
                    onclick={() => folderPickerModule = null}
                >
                    <XIcon size={18}/>
                </button>
            </div>
        {/if}
    </div>
{/snippet}

<div
    class={quickPanel ? 'relative flex h-full min-h-0 flex-col' : 'contents'}
    data-module-file-drop-surface
    role="region"
    aria-label={language.modules}
    ondragenter={previewExternalModuleImport}
    ondragover={previewExternalModuleImport}
    ondragleave={leaveExternalModuleImport}
    ondrop={dropExternalFilesAsModules}
>
{#if mode === 0}
    <SettingPage
        title={language.modules}
        contentClassName={quickPanel ? 'min-h-0 flex-1 overflow-hidden' : ''}
    >

    <div class="mt-4 flex gap-2 items-center">
        <TextInput className="grow" placeholder={language.search} bind:value={moduleSearch} />
        {@render moduleActions()}
    </div>

    <div
        class={`flex items-center justify-center gap-2 overflow-hidden rounded-md border border-dashed transition-all
            ${externalModuleDropActive ? 'mt-3 h-12 border-primary bg-primary/15 px-3 text-primary opacity-100' : 'h-0 border-transparent opacity-0'}`}
        data-module-file-drop-indicator
        role="status"
    >
        <HardDriveUpload size={18}/>
        <span class="text-sm font-bold">{language.importModule} · CHARX / RISUM</span>
    </div>

    <div
        class={`flex items-center justify-center gap-2 overflow-hidden rounded-md border border-dashed transition-all
            ${draggingModuleCatalogItem ? 'mt-3 h-10 px-3 opacity-100' : 'h-0 border-transparent opacity-0'}
            ${moduleDropIndicator === 'root' ? 'border-primary bg-primary/15 text-primary' : 'border-selected text-textcolor2'}`}
        data-module-root-drop
        role="group"
        aria-label={language.moduleFolderRoot}
        ondragover={(event) => allowModuleDrop(event, 'root')}
        ondrop={dropAtRoot}
    >
        <FolderInputIcon size={17}/>
        <span class="text-sm font-bold">{draggedFolderId ? language.modules : language.moduleFolderRoot}</span>
    </div>

    {#if moduleCatalogRows.length === 0}
        <div
            class={`contain w-full max-w-full mt-4 border-selected border-1 rounded-md ${quickPanel ? 'min-h-0 flex-1' : ''}`}
            role="status"
        >
            <div class="text-textcolor2 p-3">{language.noModules}</div>
        </div>
    {:else}
    <MeasuredVirtualList
        items={moduleCatalogRows}
        estimatedItemHeight={84}
        overscan={5}
        smallListThreshold={24}
        className={`contain w-full max-w-full mt-4 border-selected border-1 rounded-md ${quickPanel ? 'min-h-0 flex-1' : 'h-[min(60vh,40rem)]'}`}
        ariaLabel={language.modules}
        resetKey={moduleSearch}
        key={catalogRowKey}
    >
        {#snippet children(row)}
        {#if row.kind === 'module'}
            {@render moduleRow(row.module, row.nested)}
        {:else if row.kind === 'empty-folder'}
            <div
                class={`ml-4 border-b border-l px-3 py-2 text-sm text-textcolor2
                    ${moduleDropIndicator === `folder:${row.folderId}` ? 'border-primary bg-primary/15' : 'border-selected'}
                    ${moduleDropIndicator.startsWith(`folder-order:${row.folderId}:`) ? 'border-2 border-primary' : ''}`}
                role="group"
                ondragover={(event) => previewFolderDrop(event, row.folderId)}
                ondrop={(event) => dropOnFolder(event, row.folderId)}
            >
                {language.noModules}
            </div>
        {:else}
            {@const entry = row.entry}
            {@const enabledModuleCount = entry.modules.filter((module) => DBState.db.enabledModules.includes(module.id)).length}
            {@const allFolderModulesEnabled = entry.modules.length > 0 && enabledModuleCount === entry.modules.length}
            <div
                class={`border-b ${moduleDropIndicator === `folder:${entry.folder.id}` ? 'border-primary bg-primary/15' : 'border-selected'}
                    ${moduleDropIndicator === `folder-order:${entry.folder.id}:before` ? 'border-t-2 border-t-primary' : ''}
                    ${moduleDropIndicator === `folder-order:${entry.folder.id}:after` ? 'border-b-2 border-b-primary' : ''}
                    ${draggedFolderId === entry.folder.id ? 'opacity-55' : ''}`}
                data-module-folder-drop={entry.folder.id}
                data-module-active-count={enabledModuleCount}
                role="group"
                aria-label={entry.folder.name}
                ondragover={(event) => previewFolderDrop(event, entry.folder.id)}
                ondrop={(event) => dropOnFolder(event, entry.folder.id)}
            >
                        <div class="flex min-h-12 items-center gap-2 bg-selected/25 px-3 py-2">
                            <button
                                type="button"
                                class={moduleSearch.trim() === ''
                                    ? "shrink-0 cursor-grab touch-none text-textcolor2 hover:text-primary active:cursor-grabbing"
                                    : "shrink-0 cursor-not-allowed text-textcolor2/40"
                                }
                                draggable={moduleSearch.trim() === ''}
                                aria-label={`${language.moveToModuleFolder}: ${entry.folder.name}`}
                                use:tooltip={moduleSearch.trim() === '' ? language.moveToModuleFolder : language.search}
                                onclick={(event) => event.stopPropagation()}
                                onpointerdown={(event) => startModulePointerDrag(event, 'folder', entry.folder.id)}
                                ondragstart={(event) => beginFolderDrag(event, entry.folder)}
                                ondragend={clearModuleDrag}
                            >
                                <GripVerticalIcon size={18}/>
                            </button>
                            <button
                                type="button"
                                class="flex min-w-0 grow cursor-pointer items-center gap-2 text-left hover:text-primary"
                                aria-expanded={!entry.folder.collapsed}
                                onclick={() => toggleFolder(entry.folder)}
                            >
                                {#if entry.folder.collapsed}
                                    <ChevronRightIcon size={18} class="shrink-0" />
                                {:else}
                                    <ChevronDownIcon size={18} class="shrink-0" />
                                {/if}
                                <FolderIcon size={18} class="shrink-0" />
                                <span class="truncate font-bold">{entry.folder.name}</span>
                                <span
                                    class={allFolderModulesEnabled
                                        ? "shrink-0 rounded-full bg-blue-500/20 px-1.5 py-0.5 text-xs font-bold text-blue-400"
                                        : enabledModuleCount > 0
                                            ? "shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-xs font-bold text-amber-400"
                                        : "shrink-0 text-xs text-textcolor2"
                                    }
                                    aria-label={`${language.active}: ${enabledModuleCount}/${entry.modules.length}`}
                                    use:tooltip={`${language.active}: ${enabledModuleCount}/${entry.modules.length}`}
                                >
                                    {enabledModuleCount}/{entry.modules.length}
                                </span>
                            </button>
                            <button
                                type="button"
                                class={allFolderModulesEnabled
                                    ? "shrink-0 cursor-pointer text-blue-400 hover:text-primary"
                                    : enabledModuleCount > 0
                                        ? "shrink-0 cursor-pointer text-amber-400 hover:text-primary"
                                        : "shrink-0 cursor-pointer text-textcolor2 hover:text-primary"
                                }
                                aria-label={`${language.enableGlobal}: ${entry.folder.name}`}
                                use:tooltip={`${language.enableGlobal}: ${entry.folder.name}`}
                                onclick={(event) => {
                                    event.stopPropagation()
                                    toggleFolderModules(entry.modules)
                                }}
                                disabled={entry.modules.length === 0}
                            >
                                <Globe size={18}/>
                            </button>
                            <button
                                type="button"
                                class="shrink-0 cursor-pointer text-textcolor2 hover:text-primary"
                                aria-label={language.renameFolder}
                                use:tooltip={language.renameFolder}
                                onclick={() => { void renameFolder(entry.folder) }}
                            >
                                <SquarePen size={17}/>
                            </button>
                            <button
                                type="button"
                                class="shrink-0 cursor-pointer text-textcolor2 hover:text-red-400"
                                aria-label={language.remove}
                                use:tooltip={language.remove}
                                onclick={() => { void deleteFolder(entry.folder) }}
                            >
                                <TrashIcon size={17}/>
                            </button>
                        </div>
            </div>
        {/if}
        {/snippet}
    </MeasuredVirtualList>
    {/if}

    {#if !quickPanel}
        <div class="mt-3 flex shrink-0 items-center justify-end gap-3 border-t border-selected py-3">
            {@render moduleActions()}
        </div>
    {/if}

    </SettingPage>
    {#if quickPanel}
        <!-- Keep quick-panel actions outside SettingPage's scrollable content.
             This is a real sidebar footer, not the last row of the module list. -->
        <div
            class="z-10 -mx-4 -mb-6 mt-3 flex min-h-14 shrink-0 items-center justify-end gap-4 border-t border-selected bg-darkbg px-4 py-3"
            data-quick-module-footer
        >
            {@render moduleActions()}
        </div>
    {/if}
{:else if mode === 1}
    <SettingPage
        title={language.createModule}
        contentClassName={quickPanel ? 'min-h-0 flex-1 overflow-y-auto' : ''}
    >
    <ModuleMenu bind:currentModule={tempModule}/>
    <Button className="mt-6" onclick={() => {
        addModuleToDatabase(tempModule)
        notifySuccess(language.moduleCreated)
        mode = 0
    }}>{language.createModule}</Button>
    </SettingPage>
{:else if mode === 2}
    <SettingPage
        title={language.editModule}
        contentClassName={quickPanel ? 'min-h-0 flex-1 overflow-y-auto' : ''}
    >
    <ModuleMenu bind:currentModule={tempModule}/>
    {#if tempModule.name !== ''}
        <Button className="mt-6" onclick={() => {
            const editModuleIndex = resolveModuleEditTargetIndex(
                DBState.db.modules,
                editModuleId,
                editModuleOriginal,
            )
            if(editModuleIndex === -1){
                notifyError(language.moduleEditTargetMissing)
                return
            }
            DBState.db.modules[editModuleIndex] = tempModule
            refreshModules()
            notifySuccess(language.moduleUpdated)
            editModuleId = ''
            editModuleOriginal = null
            mode = 0
        }}>{language.editModule}</Button>
        <Button className="mt-2" onclick={async () => {
            const confirmed = await alertConfirm(`${language.convertToCharacter}: ${tempModule.name}`)
            if(!confirmed) return
            const char = convertModuleToCharacter(tempModule)
            DBState.db.characters.push(char)
            checkCharOrder()
            notifySuccess(language.successfullyConverted)
        }}>{language.convertToCharacter}</Button>
    {/if}
    </SettingPage>
{/if}
</div>

<ShDialog bind:open={folderCreateOpen} size="lg" tier="alert" closeOnEscape={true}>
    {#snippet title()}{language.createModuleFolder}{/snippet}
    {#snippet description()}
        폴더 {moduleFolders.length}개 · 모듈 {DBState.db.modules.length}개
    {/snippet}

    <div class="flex flex-col gap-3">
        <div class="max-h-64 overflow-y-auto rounded-md border border-darkborderc bg-selected/10">
            {#if moduleFolders.length === 0}
                <div class="p-3 text-sm text-textcolor2">{language.noModules}</div>
            {:else}
                {#each moduleFolders as folder (folder.id)}
                    {@const members = modulesInFolder(folder)}
                    <div class="border-b border-selected px-3 py-2 last:border-b-0">
                        <div class="flex items-center gap-2">
                            <FolderIcon size={16} class="shrink-0 text-textcolor2" />
                            <span class="min-w-0 grow truncate font-semibold">{folder.name}</span>
                            <span class="shrink-0 text-xs text-textcolor2">{members.length}</span>
                        </div>
                        <div class="mt-1 truncate pl-6 text-xs text-textcolor2" title={members.map((module) => module.name).join(' · ')}>
                            {members.length > 0 ? members.map((module) => module.name).join(' · ') : language.noModules}
                        </div>
                    </div>
                {/each}
            {/if}
        </div>

        <div class="flex flex-col gap-1">
            <label for="new-module-folder-name" class="text-sm text-textcolor2">{language.folderNameInput}</label>
            <TextInput
                id="new-module-folder-name"
                bind:value={newFolderName}
                fullwidth
                onkeydown={(event) => {
                    if(event.key === 'Enter' && !event.isComposing) createFolder()
                }}
            />
        </div>
    </div>

    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { folderCreateOpen = false }}>{language.cancel}</ShButton>
        <ShButton disabled={!newFolderName.trim()} onclick={createFolder}>{language.confirm}</ShButton>
    {/snippet}
</ShDialog>
