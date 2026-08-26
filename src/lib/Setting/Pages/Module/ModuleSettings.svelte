<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    
    import { DBState } from 'src/ts/stores.svelte';
    import Button from "src/lib/UI/GUI/Button.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { exportModule, importModule, refreshModules, type RisuModule } from "src/ts/process/modules";
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
        normalizeModuleFolders,
        type ModuleFolder,
    } from "src/ts/process/moduleFolders";
    import { resolveModuleEditTargetIndex } from "src/ts/process/moduleEditing";
    import MeasuredVirtualList from "src/lib/UI/Virtual/MeasuredVirtualList.svelte";
    import type { ModuleCatalogEntry } from "src/ts/process/moduleFolders";
    import type { ModuleDropTarget } from "src/ts/process/moduleFolders";

    type ModuleCatalogRow =
        | { kind: 'module'; module: RisuModule; nested: boolean }
        | { kind: 'folder'; entry: Extract<ModuleCatalogEntry<RisuModule>, { kind: 'folder' }> }
        | { kind: 'empty-folder'; folderId: string }

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
    let moduleDropIndicator = $state('')
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

    async function createFolder(){
        const name = (await alertInput(language.folderNameInput)).trim()
        if(!name) return
        updateFolders((folders) => [
            ...folders,
            { id: v4(), name, moduleIds: [] },
        ])
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
        moduleDropIndicator = ''
    }

    function beginModuleDrag(event: DragEvent, module: RisuModule){
        if(moduleSearch.trim() !== ''){
            event.preventDefault()
            return
        }
        draggedModuleId = module.id
        folderPickerModule = null
        if(event.dataTransfer){
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', module.id)
        }
    }

    function allowModuleDrop(event: DragEvent, indicator: string){
        if(!draggedModuleId) return
        event.preventDefault()
        if(event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        moduleDropIndicator = indicator
    }

    function applyModuleDrop(event: DragEvent, target: ModuleDropTarget){
        if(!draggedModuleId) return
        event.preventDefault()
        event.stopPropagation()
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
        if(!draggedModuleId || draggedModuleId === moduleId) return
        const placement = moduleDropPosition(event, moduleId)
        allowModuleDrop(event, placement.indicator)
    }

    function dropBesideModule(event: DragEvent, moduleId: string){
        if(!draggedModuleId || draggedModuleId === moduleId) return
        applyModuleDrop(event, moduleDropPosition(event, moduleId).target)
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

    onDestroy(() => {
        refreshModules()
    })
</script>

{#snippet moduleActions()}
    <button
        type="button"
        class="text-textcolor2 hover:text-primary cursor-pointer"
        aria-label={language.createModuleFolder}
        use:tooltip={language.createModuleFolder}
        onclick={() => { void createFolder() }}
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
                class={moduleSearch.trim() === ''
                    ? "mr-2 shrink-0 cursor-grab touch-none text-textcolor2 hover:text-primary active:cursor-grabbing"
                    : "mr-2 shrink-0 cursor-not-allowed text-textcolor2/40"
                }
                draggable={moduleSearch.trim() === ''}
                aria-label={`${language.moveToModuleFolder}: ${rmodule.name}`}
                use:tooltip={moduleSearch.trim() === '' ? language.moveToModuleFolder : language.search}
                onclick={(event) => event.stopPropagation()}
                ondragstart={(event) => beginModuleDrag(event, rmodule)}
                ondragend={clearModuleDrag}
            >
                <GripVerticalIcon size={18}/>
            </button>
            {#if rmodule.mcp}
                <Waypoints size={18} class="mr-2" />
            {/if}
            <span class="font-bold min-w-0 truncate">{rmodule.name}</span>
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

<div class={quickPanel ? 'flex h-full min-h-0 flex-col' : 'contents'}>
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
            ${draggedModuleId ? 'mt-3 h-10 px-3 opacity-100' : 'h-0 border-transparent opacity-0'}
            ${moduleDropIndicator === 'root' ? 'border-primary bg-primary/15 text-primary' : 'border-selected text-textcolor2'}`}
        data-module-root-drop
        role="group"
        aria-label={language.moduleFolderRoot}
        ondragover={(event) => allowModuleDrop(event, 'root')}
        ondrop={(event) => applyModuleDrop(event, { kind: 'root' })}
    >
        <FolderInputIcon size={17}/>
        <span class="text-sm font-bold">{language.moduleFolderRoot}</span>
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
                    ${moduleDropIndicator === `folder:${row.folderId}` ? 'border-primary bg-primary/15' : 'border-selected'}`}
                role="group"
                ondragover={(event) => allowModuleDrop(event, `folder:${row.folderId}`)}
                ondrop={(event) => applyModuleDrop(event, { kind: 'folder', folderId: row.folderId })}
            >
                {language.noModules}
            </div>
        {:else}
            {@const entry = row.entry}
            <div
                class={`border-b ${moduleDropIndicator === `folder:${entry.folder.id}` ? 'border-primary bg-primary/15' : 'border-selected'}`}
                data-module-folder-drop={entry.folder.id}
                role="group"
                aria-label={entry.folder.name}
                ondragover={(event) => allowModuleDrop(event, `folder:${entry.folder.id}`)}
                ondrop={(event) => applyModuleDrop(event, { kind: 'folder', folderId: entry.folder.id })}
            >
                        <div class="flex min-h-12 items-center gap-2 bg-selected/25 px-3 py-2">
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
                                <span class="shrink-0 text-xs text-textcolor2">{entry.modules.length}</span>
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
        DBState.db.modules.push(tempModule)
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
