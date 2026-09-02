<script lang="ts">
    // Chat module picker. Grouped by folder; folder management lives in
    // Settings → Modules. Each row has two scope buttons: chat scope and
    // character scope. Globally enabled modules show a globe instead.
    import { ChevronDownIcon, ChevronRightIcon, CircleCheckIcon, FolderIcon, GlobeIcon, MessageSquareIcon, SearchIcon, SettingsIcon, UserRoundIcon, Waypoints, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { groupByFolder } from "src/ts/folders";

    import { DBState, ReloadGUIPointer } from 'src/ts/stores.svelte';
    import { selectedCharID } from "src/ts/stores.svelte";
    import { openSettings, SettingsRoute } from "src/ts/routing";
    import { onMount } from "svelte";
    import { recordModuleActivation, seedModuleActivationHistory, sortModuleFoldersByActivation, sortModulesByActivation } from "src/ts/process/moduleSort";
    interface Props {
        close?: any;
        alertMode?: boolean;
    }

    let { close = (i:string) => {}, alertMode = false }: Props = $props();
    let moduleSearch = $state('')
    let listEl: HTMLDivElement = $state()
    // Folders start collapsed; searching shows everything that matches.
    // Folders start collapsed; the uncategorized group (key '') starts open,
    // so for that key the set records "collapsed" instead. Always shown as a
    // header so the list reads the same with or without folders.
    let expanded = $state<Set<string>>(new Set());

    const query = $derived(moduleSearch.trim().toLocaleLowerCase())
    let sortedModules = $derived(sortModulesByActivation(DBState.db.modules, '', {
        fallbackOrders: [
            DBState.db.enabledModules,
            DBState.db.characters[$selectedCharID]?.modules,
            currentChat()?.modules,
        ],
        activationHistory: DBState.db.moduleActivationHistory,
    }))
    let sortedFolders = $derived(sortModuleFoldersByActivation(
        DBState.db.moduleFolders ?? [],
        DBState.db.modules,
        {
            fallbackOrders: [
                DBState.db.enabledModules,
                DBState.db.characters[$selectedCharID]?.modules,
                currentChat()?.modules,
            ],
            activationHistory: DBState.db.moduleActivationHistory,
        },
    ))
    const groups = $derived(groupByFolder(sortedModules.map(m => m.folderId), sortedFolders))

    function matches(index: number) {
        const rmodule = sortedModules[index]
        return !query || `${rmodule?.name ?? ''}\n${rmodule?.description ?? ''}`.toLocaleLowerCase().includes(query)
    }

    function toggle(key: string) {
        const next = new Set(expanded);
        if (next.has(key)) next.delete(key); else next.add(key);
        expanded = next;
    }

    function currentChat() {
        const character = DBState.db.characters[$selectedCharID]
        return character?.chats?.[character.chatPage]
    }

    function hasMissingAssets(index: number) {
        return Number(sortedModules[index]?.sourceInfo?.missingAssetCount) > 0
    }

    function rememberActivation(moduleId: string) {
        DBState.db.moduleActivationHistory = recordModuleActivation(
            seedModuleActivationHistory(
                DBState.db.moduleActivationHistory,
                DBState.db.enabledModules,
                DBState.db.characters[$selectedCharID]?.modules,
                currentChat()?.modules,
            ),
            moduleId,
        )
    }

    function toggleChatScope(moduleId: string) {
        const chat = currentChat()
        if (!chat) return
        chat.modules ??= []
        if (chat.modules.includes(moduleId)) chat.modules.splice(chat.modules.indexOf(moduleId), 1)
        else {
            chat.modules.push(moduleId)
            rememberActivation(moduleId)
        }
        chat.modules = chat.modules
        $ReloadGUIPointer += 1
    }

    function toggleCharacterScope(moduleId: string) {
        const character = DBState.db.characters[$selectedCharID]
        if (!character) return
        character.modules ??= []
        if (character.modules.includes(moduleId)) character.modules.splice(character.modules.indexOf(moduleId), 1)
        else {
            character.modules.push(moduleId)
            rememberActivation(moduleId)
        }
        $ReloadGUIPointer += 1
    }

    function toggleFolderGlobal(indexes: number[]) {
        const ids = indexes.map((index) => sortedModules[index]?.id).filter((id): id is string => !!id)
        if (ids.length === 0) return
        const enabled = new Set(DBState.db.enabledModules)
        if (ids.every((id) => enabled.has(id))) {
            DBState.db.enabledModules = DBState.db.enabledModules.filter((id) => !ids.includes(id))
        } else {
            for (const id of ids) {
                if (!enabled.has(id)) DBState.db.enabledModules.push(id)
                rememberActivation(id)
            }
            DBState.db.enabledModules = [...new Set(DBState.db.enabledModules)]
        }
        $ReloadGUIPointer += 1
    }

    onMount(() => {
        listEl?.focus()
    })
</script>


<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-full max-h-full overflow-hidden max-sm:w-full max-sm:h-full max-sm:max-w-none max-sm:rounded-none">
        <div class="flex items-center text-textcolor">
            <h2 class="mt-0 mb-0 text-lg">{language.modules}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={() => {
                    close('')
                }}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>

        <span class="text-sm text-textcolor2">{language.chatModulesInfo}</span>

        <div class="risu-field-border flex items-center gap-2 rounded-md px-3 mt-4 mb-2">
            <SearchIcon size={16} class="text-textcolor2 shrink-0"/>
            <input bind:value={moduleSearch} placeholder={language.search}
                class="w-full py-1.5 text-sm bg-transparent text-textcolor outline-none"/>
        </div>

        <!-- A real focusable scroll region keeps the scrollbar and PageUp/
             PageDown/arrow-key scrolling available in the Ctrl+Q panel. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div bind:this={listEl} role="region" aria-label={language.modules} tabindex="0" class="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 outline-none focus:ring-1 focus:ring-primary/40">
        {#if DBState.db.modules.length === 0}
            <div class="text-textcolor2 p-3">{language.noModules}</div>
        {/if}
        {#each groups as group (group.folder?.id ?? '')}
            {@const visible = group.indexes.filter(matches)}
            {@const key = group.folder?.id ?? ''}
            {@const hasHeader = true}
            {@const open = !!query || (key === '' ? !expanded.has(key) : expanded.has(key))}
            {#if visible.length > 0}
                {#if hasHeader}
                    {@const activeCount = visible.filter((index) => DBState.db.enabledModules.includes(sortedModules[index]?.id)).length}
                    <div class="flex items-center gap-2 w-full rounded-md px-2 py-2 mt-1 border-t border-darkborderc text-textcolor cursor-pointer hover:bg-selected/30 select-none"
                        role="button" tabindex="0" onclick={() => toggle(key)}
                        onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(key) } }}>
                        {#if open}<ChevronDownIcon size={16} class="shrink-0 text-textcolor2"/>{:else}<ChevronRightIcon size={16} class="shrink-0 text-textcolor2"/>{/if}
                        <FolderIcon size={16} class="shrink-0 text-textcolor2"/>
                        <span class="grow text-left truncate {group.folder ? '' : 'text-textcolor2'}">{group.folder?.name ?? language.folderUncategorized}</span>
                        {#if !alertMode}
                            <button
                                class="shrink-0 rounded-sm p-1 {activeCount > 0 ? 'text-emerald-500 bg-emerald-500/15' : 'text-textcolor2 hover:text-primary'}"
                                title={`폴더 모듈 전체 활성화 (${activeCount}/${visible.length})`}
                                aria-label={`폴더 모듈 전체 활성화 (${activeCount}/${visible.length})`}
                                onclick={(event) => { event.stopPropagation(); toggleFolderGlobal(visible) }}
                            ><GlobeIcon size={16}/></button>
                        {/if}
                        <span class="text-xs text-textcolor2">{visible.length}</span>
                    </div>
                {/if}
                {#each open ? visible : [] as i}
                    {@const rmodule = sortedModules[i]}
                    {@const isGlobal = DBState.db.enabledModules.includes(rmodule.id)}
                    {@const inChat = currentChat()?.modules?.includes(rmodule.id) ?? false}
                    {@const inCharacter = DBState.db.characters[$selectedCharID]?.modules?.includes(rmodule.id) ?? false}
                    <!-- Chat and character scope are separate buttons: the old
                         right-click / long-press toggle is not reachable on iOS
                         (Safari fires no contextmenu on long press). -->
                    <div class="flex items-center gap-2 text-textcolor border-t border-darkborderc p-2 pl-7">
                        {#if rmodule.mcp}
                            <Waypoints size={18} class="shrink-0 text-textcolor2" />
                        {/if}
                        <span class="min-w-0 grow truncate {hasMissingAssets(i) ? 'text-red-400' : (!alertMode && isGlobal ? 'text-textcolor2' : '')}">{rmodule.name}</span>
                        {#if alertMode}
                            <button class="text-textcolor2 cursor-pointer hover:text-success transition-colors shrink-0" onclick={(e) => {
                                e.stopPropagation()
                                close(rmodule.id)
                            }}>
                                <CircleCheckIcon size={18}/>
                            </button>
                        {:else if isGlobal}
                            <!-- Globally enabled: always on, managed in Settings > Modules.
                                 Shown explicitly so the row does not read as "off". -->
                            <span class="shrink-0 p-1 rounded-sm text-emerald-500 bg-emerald-500/15" title={language.moduleScopeGlobal} aria-label={language.moduleScopeGlobal}>
                                <GlobeIcon size={18}/>
                            </span>
                        {:else}
                            <button class="shrink-0 cursor-pointer p-1 rounded-sm {inChat ? 'text-blue-500 bg-blue-500/15' : 'text-textcolor2 hover:text-blue-400'}"
                                title={language.moduleScopeChat} aria-label={language.moduleScopeChat} aria-pressed={inChat}
                                onclick={(e) => { e.stopPropagation(); toggleChatScope(rmodule.id) }}>
                                <MessageSquareIcon size={18}/>
                            </button>
                            <button class="shrink-0 cursor-pointer p-1 rounded-sm {inCharacter ? 'text-violet-500 bg-violet-500/15' : 'text-textcolor2 hover:text-violet-400'}"
                                title={language.moduleScopeCharacter} aria-label={language.moduleScopeCharacter} aria-pressed={inCharacter}
                                onclick={(e) => { e.stopPropagation(); toggleCharacterScope(rmodule.id) }}>
                                <UserRoundIcon size={18}/>
                            </button>
                        {/if}
                    </div>
                {/each}
            {/if}
        {/each}
        </div>
        <button class="mt-3 pt-2 w-full border-t border-darkborderc flex items-center gap-2 text-sm text-textcolor2 hover:text-primary cursor-pointer"
            onclick={() => { openSettings(SettingsRoute.Module); close('') }}>
            <SettingsIcon size={16}/><span>{language.moduleManage}</span>
        </button>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
