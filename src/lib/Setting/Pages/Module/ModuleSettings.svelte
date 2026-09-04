<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";

    import { DBState } from 'src/ts/stores.svelte';
    import Button from "src/lib/UI/GUI/Button.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShDropdownMenuItem from "src/lib/UI/GUI/ShDropdownMenuItem.svelte";
    import FolderedList, { type FolderedItemPlacement } from "src/lib/UI/FolderedList.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { addModuleToDatabase, exportModule, exportModuleLegacy, hydrateModuleAssets, importModule, refreshModules, type RisuModule } from "src/ts/process/modules";
    import { SquarePen, Globe, Share2Icon, PlusIcon, HardDriveUpload, PaletteIcon, StarIcon, Waypoints } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { tooltip } from "src/ts/gui/tooltip";
    import { alertConfirm, alertError, alertSelect, notifySuccess } from "src/ts/alert";
    import { onDestroy } from "svelte";
    import { importMCPModule } from "src/ts/process/mcp/mcp";
    import { convertModuleToCharacter } from "src/ts/interchangeability";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import { synchronizeModuleFolderMembership } from "src/ts/process/moduleFolders";
    import { recordModuleActivation, recordModuleFolderActivation, recordModuleFolderOrder, seedModuleActivationHistory, sortModuleFoldersByActivation, sortModulesByActivation } from "src/ts/process/moduleSort";
    import { chooseTitleColor, listTitleColor } from "src/ts/gui/titleColors";
    import type { PromptPresetFolder } from "src/ts/storage/database.svelte";
    let tempModule:RisuModule = $state({
        name: '',
        description: '',
        id: v4(),
    })
    let mode = $state(0)
    let editModuleIndex = $state(-1)
    let converting = $state(false)
    let displayModules = $derived(sortModulesByActivation(DBState.db.modules, '', {
        fallbackOrders: [DBState.db.enabledModules],
        activationHistory: DBState.db.moduleActivationHistory,
    }))
    let displayFolders = $derived(sortModuleFoldersByActivation(
        DBState.db.moduleFolders ?? [],
        DBState.db.modules,
        {
            fallbackOrders: [DBState.db.enabledModules],
            activationHistory: DBState.db.moduleActivationHistory,
        },
    ))

    function isGlobal(rmodule: RisuModule) {
        return DBState.db.enabledModules.includes(rmodule.id)
    }

    function isIntegrated(rmodule: RisuModule) {
        return !!rmodule.namespace
            && !!DBState.db.moduleIntergration?.split(',').map((s) => s.trim()).includes(rmodule.namespace)
    }

    function hasMissingAssets(rmodule: RisuModule) {
        return Number(rmodule.sourceInfo?.missingAssetCount) > 0
    }

    function rememberActivation(moduleId: string) {
        DBState.db.moduleActivationHistory = recordModuleActivation(
            seedModuleActivationHistory(DBState.db.moduleActivationHistory, DBState.db.enabledModules),
            moduleId,
        )
        DBState.db.moduleFolders = recordModuleFolderActivation(
            DBState.db.moduleFolders ?? [], DBState.db.modules, moduleId,
            { activationHistory: DBState.db.moduleActivationHistory },
        )
    }

    function toggleGlobal(rmodule: RisuModule) {
        if (isGlobal(rmodule)) {
            DBState.db.enabledModules.splice(DBState.db.enabledModules.indexOf(rmodule.id), 1)
        } else {
            DBState.db.enabledModules.push(rmodule.id)
            rememberActivation(rmodule.id)
        }
        DBState.db.enabledModules = DBState.db.enabledModules
    }

    function toggleFolderGlobal(indexes: number[]) {
        const ids = indexes.map((index) => displayModules[index]?.id).filter((id): id is string => !!id)
        if (ids.length === 0) return
        const enabled = new Set(DBState.db.enabledModules)
        if (ids.every((id) => enabled.has(id))) {
            DBState.db.enabledModules = DBState.db.enabledModules.filter((id) => !ids.includes(id))
            return
        }
        for (const id of ids) {
            if (!enabled.has(id)) DBState.db.enabledModules.push(id)
            rememberActivation(id)
        }
        DBState.db.enabledModules = [...new Set(DBState.db.enabledModules)]
    }

    function originalModuleIndex(displayIndex: number) {
        const id = displayModules[displayIndex]?.id
        return id ? DBState.db.modules.findIndex((module) => module.id === id) : -1
    }

    function openEditor(index: number) {
        const originalIndex = originalModuleIndex(index)
        const rmodule = DBState.db.modules[originalIndex]
        if (!rmodule || rmodule.mcp) return
        tempModule = rmodule
        editModuleIndex = originalIndex
        mode = 2
    }

    async function exportModuleAt(index: number) {
        const rmodule = displayModules[index]
        if (!rmodule || rmodule.mcp) return
        const sel = parseInt(await alertSelect([`CharX (${language.recommended})`, `RisuM (Legacy)`]))
        if (sel === 0) exportModule(rmodule)
        else exportModuleLegacy(rmodule)
    }

    async function removeModule(index: number) {
        const rmodule = displayModules[index]
        if (!rmodule) return
        const d = await alertConfirm(`${language.removeConfirm}` + rmodule.name)
        if (!d) return
        if (isGlobal(rmodule)) {
            DBState.db.enabledModules.splice(DBState.db.enabledModules.indexOf(rmodule.id), 1)
            DBState.db.enabledModules = DBState.db.enabledModules
        }
        DBState.db.modules = DBState.db.modules.filter((module) => module.id !== rmodule.id)
        DBState.db.moduleActivationHistory = DBState.db.moduleActivationHistory?.filter((id) => id !== rmodule.id) ?? []
        DBState.db.moduleFolders = synchronizeModuleFolderMembership(
            DBState.db.modules,
            DBState.db.moduleFolders,
            { importLegacyWhenFolderIdsEmpty: false },
        )
        notifySuccess(language.moduleDeleted)
    }

    /**
     * Persists only small catalog overlays. The upstream module array keeps its
     * physical order; visual recency lives in moduleActivationHistory.
     */
    function applyPlacements(placements: FolderedItemPlacement[]) {
        if (placements.length !== displayModules.length) return
        const currentFolders = displayFolders
        const folderById = new Map(placements.map(({ index, folderId }) => [displayModules[index]?.id, folderId]))
        DBState.db.modules = DBState.db.modules.map((module) => ({
            ...module,
            folderId: folderById.get(module.id),
        }))
        DBState.db.moduleActivationHistory = placements
            .map(({ index }) => displayModules[index]?.id)
            .filter((id): id is string => !!id)
            .reverse()
        DBState.db.moduleFolders = recordModuleFolderOrder(synchronizeModuleFolderMembership(
            DBState.db.modules,
            currentFolders,
            { importLegacyWhenFolderIdsEmpty: false },
        ))
    }

    function applyFolders(next: typeof DBState.db.moduleFolders) {
        DBState.db.moduleFolders = recordModuleFolderOrder(synchronizeModuleFolderMembership(
            DBState.db.modules,
            next,
            { importLegacyWhenFolderIdsEmpty: false },
        ))
    }

    async function changeModuleColor(rmodule: RisuModule) {
        const color = await chooseTitleColor(rmodule.titleColor)
        if (color === null) return
        const current = DBState.db.modules.find((module) => module.id === rmodule.id)
        if (current) current.titleColor = color || undefined
    }

    async function changeFolderColor(folder: PromptPresetFolder) {
        const color = await chooseTitleColor(folder.titleColor)
        if (color === null) return
        applyFolders(displayFolders.map((item) => item.id === folder.id ? { ...item, titleColor: color || undefined } : item))
    }

    function toggleFolderFavorite(folder: PromptPresetFolder) {
        const changed = displayFolders.map((item) => item.id === folder.id ? { ...item, favorite: !item.favorite } : item)
        if (!folder.favorite) {
            const index = changed.findIndex((item) => item.id === folder.id)
            changed.unshift(...changed.splice(index, 1))
        }
        applyFolders(changed)
    }

    function folderColor(folder: PromptPresetFolder, indexes: number[]) {
        return listTitleColor(folder.titleColor)
    }

    onDestroy(() => {
        refreshModules()
    })
</script>
{#if mode === 0}
    <SettingPage title={language.modules}>

    <FolderedList
        folders={displayFolders}
        itemFolderIds={displayModules.map(m => m.folderId)}
        itemSearchTexts={displayModules.map(m => `${m.name}\n${m.description ?? ''}`)}
        storageKey="risu-module-folders-expanded-v2"
        defaultCollapsed
        newFoldersFirst
        folderTitleColor={folderColor}
        onFolderColor={changeFolderColor}
        onFolderFavorite={toggleFolderFavorite}
        showFolderDelete={false}
        showMenuCancel
        folderRenameLabel="폴더이름변경하기"
        onSelect={openEditor}
        onItemsChange={applyPlacements}
        onFoldersChange={applyFolders}
        onDelete={removeModule}
    >
        {#snippet actions()}
            <ShButton size="sm" onclick={() => {
                tempModule = { name: '', description: '', id: v4() }
                mode = 1
            }}><PlusIcon />{language.createModule}</ShButton>
            <ShButton size="sm" variant="outline" onclick={() => importModule()}><HardDriveUpload />{language.importModule}</ShButton>
            <ShButton size="sm" variant="outline" onclick={() => importMCPModule()} title="MCP"><Waypoints /></ShButton>
        {/snippet}
        {#snippet folderActions(_folder, indexes)}
            {@const activeCount = indexes.filter((index) => DBState.db.enabledModules.includes(displayModules[index]?.id)).length}
            {#if indexes.some((index) => hasMissingAssets(displayModules[index]))}
                <span class="no-sort shrink-0" aria-label="에셋 누락" title="에셋 누락">❗</span>
            {/if}
            <button
                class="no-sort shrink-0 rounded-sm p-1 cursor-pointer {activeCount > 0 ? 'text-emerald-500 bg-emerald-500/15' : 'text-textcolor2 hover:text-primary'}"
                title={`폴더 모듈 전체 활성화 (${activeCount}/${indexes.length})`}
                aria-label={`폴더 모듈 전체 활성화 (${activeCount}/${indexes.length})`}
                onclick={(event) => { event.stopPropagation(); toggleFolderGlobal(indexes) }}
            ><Globe size={17}/></button>
        {/snippet}
        {#snippet itemContent(index)}
            {@const rmodule = displayModules[index]}
            {#if rmodule.mcp}
                <Waypoints size={18} class="shrink-0 text-textcolor2" />
            {/if}
            <div class="flex flex-col min-w-0 grow">
                <span class="truncate text-textcolor" style:color={listTitleColor(rmodule.titleColor)}>{rmodule.favorite ? '★ ' : ''}{rmodule.name}{#if hasMissingAssets(rmodule)} <span aria-label="에셋 누락" title="에셋 누락">❗</span>{/if}</span>
                <span class="text-xs text-textcolor2 truncate">{rmodule.description || 'No description provided'}</span>
            </div>
            <button class="no-sort shrink-0 p-1 cursor-pointer {isGlobal(rmodule) ? 'text-blue-500' : isIntegrated(rmodule) ? 'text-amber-500 hover:text-primary' : 'text-textcolor2 hover:text-primary'}"
                use:tooltip={language.enableGlobal}
                onclick={(e) => { e.stopPropagation(); toggleGlobal(rmodule) }}>
                <Globe size={18}/>
            </button>
        {/snippet}
        {#snippet itemMenu(index)}
            {@const rmodule = displayModules[index]}
            {#if !rmodule.mcp}
                <ShDropdownMenuItem onSelect={() => openEditor(index)}><SquarePen /><span>{language.edit}</span></ShDropdownMenuItem>
                <ShDropdownMenuItem onSelect={() => exportModuleAt(index)}><Share2Icon /><span>{language.download}</span></ShDropdownMenuItem>
            {/if}
            <ShDropdownMenuItem onSelect={() => changeModuleColor(rmodule)}><PaletteIcon /><span>색변경</span></ShDropdownMenuItem>
            <ShDropdownMenuItem onSelect={() => { rmodule.favorite = !rmodule.favorite }}><StarIcon /><span>{rmodule.favorite ? '즐겨찾기 해제' : '즐겨찾기 (맨위로)'}</span></ShDropdownMenuItem>
        {/snippet}
    </FolderedList>
    {#if DBState.db.modules.length === 0}
        <div class="text-textcolor2 p-3">{language.noModules}</div>
    {/if}

    </SettingPage>
{:else if mode === 1}
    <SettingPage title={language.createModule}>
    <ModuleMenu bind:currentModule={tempModule}/>
    <Button className="mt-6" onclick={() => {
        addModuleToDatabase(tempModule)
        notifySuccess(language.moduleCreated)
        mode = 0
    }}>{language.createModule}</Button>
    </SettingPage>
{:else if mode === 2}
    <SettingPage title={language.editModule}>
    <ModuleMenu bind:currentModule={tempModule}/>
    {#if tempModule.name !== ''}
        <Button className="mt-6" onclick={() => {
            DBState.db.modules[editModuleIndex] = tempModule
            notifySuccess(language.moduleUpdated)
            mode = 0
        }}>{language.editModule}</Button>
        <Button className="mt-2" disabled={converting} onclick={async () => {
            if(converting){
                return
            }
            converting = true
            try {
                // Hydrate first: copying the descriptor would make the new
                // character share the module's manifest, so editing one would
                // change the other until the next reload.
                const char = convertModuleToCharacter(await hydrateModuleAssets(tempModule))
                DBState.db.characters.push(char)
                checkCharOrder()
                notifySuccess(language.successfullyConverted)
            } catch (error) {
                alertError(`${error}`)
            } finally {
                converting = false
            }
        }}>{language.convertToCharacter}</Button>
    {/if}
    </SettingPage>
{/if}
