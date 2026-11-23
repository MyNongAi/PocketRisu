<script lang="ts">
    import { language } from "src/lang";
    import { hasNewMark, markSeen } from "src/ts/newMarks.svelte";
    import NewMark from "src/lib/UI/NewMark.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";

    import { DBState, ReloadGUIPointer, selectedCharID } from 'src/ts/stores.svelte';
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShDropdownMenuItem from "src/lib/UI/GUI/ShDropdownMenuItem.svelte";
    import ShDropdownMenu from "src/lib/UI/GUI/ShDropdownMenu.svelte";
    import ShDropdownMenuTrigger from "src/lib/UI/GUI/ShDropdownMenuTrigger.svelte";
    import ShDropdownMenuContent from "src/lib/UI/GUI/ShDropdownMenuContent.svelte";
    import FolderedList, { type FolderedItemPlacement } from "src/lib/UI/FolderedList.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { addModuleToDatabase, exportModule, exportModuleLegacy, hydrateModuleAssets, refreshModules, rerenderChatForModules, syncFavoriteModules, syncLinkedFolders, type RisuModule } from "src/ts/process/modules";
    import { importModuleFiles, importModuleFromProtonDrive } from "src/ts/process/moduleImport";
    import { favoriteAfterMove, isModuleFavoritesFolder } from "src/ts/process/moduleFavoritesFolder";
    import { Clock3Icon, SquarePen, Globe, MessageSquareIcon, CheckIcon, Share2Icon, PlusIcon, HardDriveUpload, ListOrderedIcon, StarIcon, Waypoints, CloudDownloadIcon, LinkIcon, Link2Icon, UnlinkIcon, UserSearchIcon, InfoIcon } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { tooltip } from "src/ts/gui/tooltip";
    import { alertConfirm, alertError, alertSelect, notifySuccess } from "src/ts/alert";
    import { onDestroy, onMount, tick, untrack } from "svelte";
    import { addModulePanelFinder, findBotsOfModule, moduleFindRequest } from "src/ts/gui/pairFinder";
    import { importMCPModule } from "src/ts/process/mcp/mcp";
    import { RISU_ACCESS_URL } from "src/ts/process/mcp/toolGate";
    import { convertModuleToCharacter } from "src/ts/interchangeability";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import { dissolveShrunkenModuleFolders, synchronizeModuleFolderMembership } from "src/ts/process/moduleFolders";
    // LEGACY-MODULE-FOLDERS
    import { legacyActivationHistoryFromPlacements, legacyModuleFolderView, sortLegacyModulesByActivation, storedLegacyPlacements } from "src/ts/process/legacyModuleFolderView";
    import { activationHistoryAfterPlacement, activationHistoryFromDisplay, getLatestModuleCatalogPromotion, liftModulesToNewest, unpinModuleFavoritesOnce, recordModuleActivation, recordModuleFolderActivation, recordModuleFolderOrder, seedModuleActivationHistory, sortModuleFoldersByActivation, sortModulesByActivation } from "src/ts/process/moduleSort";
    import { listTitleColor, shownMissingAssetCount } from "src/ts/gui/titleColors";
    import { openItemInfo } from "src/ts/gui/itemInfo";
    import { localOriginOf, resolveCharacterSourceBadge } from "src/ts/gui/characterSourceBadge";
    import { copyProtonLink, protonLinkOf } from "src/ts/protonSource";
    import { cloneModuleDraft } from "src/ts/process/moduleDraft";
    import { removeModulesFromDatabase } from "src/ts/process/moduleRemoval";
    import { restoreIllustrationPresets } from "src/ts/process/illustrationRun";
    import { isColdModule, keepModuleWhole, wakeModules, wholeModule } from "src/ts/process/moduleCold.svelte";
    import type { PromptPresetFolder } from "src/ts/storage/database.svelte";
    import { importDroppedFiles } from "src/ts/dropImport";
    import { importDroppedLink } from "src/ts/linkDropImport";
    import { FileDropSurface } from "src/ts/gui/fileDropSurface.svelte";
    import FileDropIndicator from "src/lib/UI/GUI/FileDropIndicator.svelte";
    import PairedModuleMark from "src/lib/UI/GUI/PairedModuleMark.svelte";
    import { dropMissingBotModules, folderBotLinkChange, forgetModulePair, moduleLinks, recordModulePair } from "src/ts/gui/pairedModules";
    import { moduleGlobeHold } from "src/ts/gui/moduleGlobeHold";

    let { sidePanel = false }: { sidePanel?: boolean } = $props();

    let tempModule:RisuModule = $state({
        name: '',
        description: '',
        id: v4(),
    })
    let mode = $state(0)
    // Prompt presets edited since: their modules move into or out of [프롬] (presetModuleFolder.ts).
    onMount(() => { syncLinkedFolders() })
    onMount(() => { unpinModuleFavoritesOnce(DBState.db) })
    // The 🎨 module and the old app-wide illustration presets in it (illustrationModule.ts).
    onMount(() => { restoreIllustrationPresets() })
    let editModuleIndex = $state(-1)
    let converting = $state(false)
    // The module in the editor is a stored one (moduleCold.svelte.ts): its
    // body was fetched to show; saving puts it back in the database.
    let editingStored = $state(false)
    let openingModule = $state(false)
    // FolderedList is unmounted while the module editor is open. Keep the
    // query here so returning to the catalog restores the same filtered view.
    let moduleSearchQuery = $state('')
    let scopeMenus = $state<Record<string, boolean>>({})
    let moduleListScrollTop = 0
    let modulePageRoot: HTMLDivElement
    type ModuleCatalogSort = 'recent' | 'registered'
    let moduleCatalogSort = $state<ModuleCatalogSort>(
        typeof localStorage !== 'undefined' && localStorage.getItem('risu-module-catalog-sort') === 'registered'
            ? 'registered'
            : 'recent',
    )
    // LEGACY-MODULE-FOLDERS: this device's catalog view, never a DB setting.
    function readLegacyModuleFolders() {
        try { return typeof localStorage !== 'undefined' && localStorage.getItem('risu-module-folder-legacy') === 'true' } catch { return false }
    }
    let legacyModuleFolders = $state(readLegacyModuleFolders())
    function toggleLegacyModuleFolders() {
        legacyModuleFolders = !legacyModuleFolders
        try { localStorage.setItem('risu-module-folder-legacy', String(legacyModuleFolders)) } catch {}
    }
    // 최근순 follows the activations and the drags. Above it the favorites
    // hold the top (the user's rule, 2026-10-27: "즐찾만 고정"), and under
    // them the modules on now (2026-10-30; interleaveModuleCatalogGroups).
    let recencyOptions = $derived({
        fallbackOrders: moduleFallbackOrders(),
        activationHistory: DBState.db.moduleActivationHistory,
    })
    let displayModules = $derived(moduleCatalogSort === 'registered'
        ? [...DBState.db.modules]
        : (legacyModuleFolders ? sortLegacyModulesByActivation : sortModulesByActivation)(DBState.db.modules, '', recencyOptions)) // LEGACY-MODULE-FOLDERS
    let favoriteModuleIndexes = $derived(new Set(displayModules.flatMap((module, index) => module?.favorite ? [index] : [])))
    // The blue and orange ones, 🎨 with the bot's illustration toggle on too.
    let activeModuleIndexes = $derived(new Set(displayModules.flatMap((module, index) => module
        && (isGlobal(module) || (sidePanel && isInChat(module)) || isIntegrated(module) || isBotModule(module) || isIllustrationOn(module) || isEditModeOn(module)) ? [index] : [])))
    let displayFolders = $derived(moduleCatalogSort === 'registered'
        ? [...(DBState.db.moduleFolders ?? [])]
        : sortModuleFoldersByActivation(
            DBState.db.moduleFolders ?? [],
            DBState.db.modules,
            recencyOptions,
        ))
    // LEGACY-MODULE-FOLDERS
    let legacyFolderView = $derived(legacyModuleFolders ? legacyModuleFolderView(displayModules, displayFolders) : undefined)
    let catalogPromotion = $derived(moduleCatalogSort === 'recent'
        ? getLatestModuleCatalogPromotion(
            DBState.db.modules,
            DBState.db.moduleFolders ?? [],
            recencyOptions,
        )
        : undefined)

    // A bot's menu "연결된 모듈 찾기" (pairFinder.ts): the list searched to
    // the module's name, its row marked while that search stays.
    let foundModuleId = $state('')
    let foundModuleIndex = $derived(foundModuleId && moduleSearchQuery
        ? displayModules.findIndex((module) => module.id === foundModuleId)
        : -1)
    function showFoundModule(id: string) {
        const module = DBState.db.modules.find((m) => m?.id === id)
        if (!module) return
        moduleSearchQuery = module.name
        foundModuleId = id
    }
    // The sidebar's module tab mounts this list too (QuickSettingsGUI). It
    // stays mounted while the sidebar is closed, so it leaves the page's
    // request alone, and takes a find itself only while it is on screen and
    // showing the list (an open editor keeps its unsaved draft).
    const sidePanelList = () => modulePageRoot?.closest<HTMLElement>('.rs-setting-cont-5') ?? null
    $effect(() => {
        const id = $moduleFindRequest
        if (!id || sidePanelList()) return
        untrack(() => {
            moduleFindRequest.set(null)
            showFoundModule(id)
        })
    })
    onMount(() => addModulePanelFinder((id) => {
        const list = sidePanelList()
        if (!list || mode !== 0) return false
        const rect = list.getBoundingClientRect()
        if (rect.width === 0 || rect.right <= 0 || rect.left >= window.innerWidth) return false
        showFoundModule(id)
        list.scrollTop = 0
        return true
    }))
    let promotedModuleIndex = $derived(catalogPromotion && (!catalogPromotion.folderId || (legacyModuleFolders && !legacyFolderView?.folders.some((folder) => folder.id === catalogPromotion?.folderId))) // LEGACY-MODULE-FOLDERS
        ? displayModules.findIndex((module) => module.id === catalogPromotion?.moduleId)
        : -1)
    let promotedFolderId = $derived(legacyModuleFolders && !legacyFolderView?.folders.some((folder) => folder.id === catalogPromotion?.folderId) ? '' : catalogPromotion?.folderId ?? '') // LEGACY-MODULE-FOLDERS

    function setModuleCatalogSort(next: ModuleCatalogSort) {
        moduleCatalogSort = next
        try { localStorage.setItem('risu-module-catalog-sort', next) } catch {}
    }

    function isGlobal(rmodule: RisuModule) {
        return DBState.db.enabledModules.includes(rmodule.id)
    }

    // MODULE-SIDEPANEL-CHAT-SCOPE (2026-11-23): the quick panel follows the open chat.
    function currentChat() {
        const character = DBState.db.characters[$selectedCharID]
        return character?.chats?.[character.chatPage]
    }

    function isInChat(rmodule: RisuModule) {
        return !!currentChat()?.modules?.includes(rmodule.id)
    }

    function moduleFallbackOrders() {
        return sidePanel
            ? [DBState.db.enabledModules, DBState.db.characters[$selectedCharID]?.modules, currentChat()?.modules]
            : [DBState.db.enabledModules]
    }

    // A module the open bot has as its own (character.modules) is on by
    // itself in that bot's chats: drawn like the other automatic case.
    function isBotModule(rmodule: RisuModule) {
        return !!DBState.db.characters[$selectedCharID]?.modules?.includes(rmodule.id)
    }

    // The 🎨 module while the open bot's illustration toggle (사이드바 삽화 토글)
    // is on: in use, drawn orange like the bot's own (the user's request,
    // 2026-10-27); moduleOnWatch lifts it when the toggle comes on.
    function isIllustrationOn(rmodule: RisuModule) {
        return !!rmodule.nodeOnlyIllustrationModule && !!DBState.db.characters[$selectedCharID]?.nodeOnlyIllustration?.enabled
    }

    // The Risu Access module while the open chat's bot edit mode is on
    // (editMode.ts): in use, drawn orange like 🎨 (the user's request, 2026-10-28).
    function isEditModeOn(rmodule: RisuModule) {
        const char = DBState.db.characters[$selectedCharID]
        return rmodule.mcp?.url === RISU_ACCESS_URL && !!char?.chats?.[char.chatPage]?.modules?.includes(rmodule.id)
    }

    function isIntegrated(rmodule: RisuModule) {
        return !!rmodule.namespace
            && !!DBState.db.moduleIntergration?.split(',').map((s) => s.trim()).includes(rmodule.namespace)
    }

    function hasMissingAssets(rmodule: RisuModule) {
        return shownMissingAssetCount(rmodule.sourceInfo) > 0
    }

    function moduleAssetCount(rmodule: RisuModule) {
        const recorded = Number(rmodule.sourceInfo?.assetReferenceCount)
        if (Number.isFinite(recorded) && recorded >= 0) return Math.floor(recorded)
        const manifest = Number(rmodule.assetManifest?.count)
        if (Number.isFinite(manifest) && manifest >= 0) return Math.floor(manifest)
        return rmodule.assets?.length ?? 0
    }

    function moduleSource(rmodule: RisuModule) {
        return resolveCharacterSourceBadge(rmodule.sourceInfo?.label, localOriginOf(rmodule))
    }

    function listScrollElement() {
        // Settings and the Ctrl+Q sidebar mount the same module catalogue in
        // different scroll containers.
        return modulePageRoot?.closest<HTMLElement>('.rs-setting-cont-4')
            ?? modulePageRoot?.closest<HTMLElement>('.rs-setting-cont-5')
            ?? null
    }

    function rememberListScroll() {
        moduleListScrollTop = listScrollElement()?.scrollTop ?? moduleListScrollTop
    }

    async function returnToModuleList() {
        mode = 0
        await tick()
        requestAnimationFrame(() => {
            const element = listScrollElement()
            if (element) element.scrollTop = moduleListScrollTop
            requestAnimationFrame(() => {
                const settledElement = listScrollElement()
                if (settledElement) settledElement.scrollTop = moduleListScrollTop
            })
        })
    }

    function rememberActivation(moduleId: string) {
        DBState.db.moduleActivationHistory = recordModuleActivation(
            seedModuleActivationHistory(DBState.db.moduleActivationHistory, ...moduleFallbackOrders()),
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
            markSeen(rmodule)
            void wakeModules([rmodule.id])
        }
        DBState.db.enabledModules = DBState.db.enabledModules
    }

    function toggleChatScope(moduleId: string) {
        const chat = currentChat()
        if (!chat) return
        chat.modules ??= []
        if (chat.modules.includes(moduleId)) chat.modules.splice(chat.modules.indexOf(moduleId), 1)
        else {
            chat.modules.push(moduleId)
            rememberActivation(moduleId)
            void wakeModules([moduleId])
        }
        chat.modules = chat.modules
        $ReloadGUIPointer += 1
    }

    // MODULE-SIDEPANEL-SCOPE-MENU (2026-11-23): a tap removes the shown scope; hold/right-click chooses one.
    function tapSideScope(rmodule: RisuModule) {
        if (isGlobal(rmodule)) toggleGlobal(rmodule)
        else if (isBotModule(rmodule)) toggleBotLink(rmodule)
        else toggleChatScope(rmodule.id)
    }

    function sideScopeLabel(rmodule: RisuModule) {
        const state = isGlobal(rmodule) ? language.moduleSideGlobalOn
            : isBotModule(rmodule) ? language.moduleSideBotOn
            : isInChat(rmodule) ? language.moduleSideChatOn
            : isIntegrated(rmodule) || isIllustrationOn(rmodule) || isEditModeOn(rmodule) ? language.moduleSideAutomatic
            : language.moduleSideOff
        return `${state} · ${language.moduleSideChooseScope}${!currentChat() && !isGlobal(rmodule) && !isBotModule(rmodule) ? ` · ${language.moduleChatRequiresOpenChat}` : ''}`
    }

    function toggleFolderChat(indexes: number[]) {
        const chat = currentChat()
        if (!chat) return
        const ids = folderModuleIds(indexes).filter((id) => !DBState.db.enabledModules.includes(id))
        if (ids.length === 0) return
        const modules = chat.modules ?? []
        if (ids.every((id) => modules.includes(id))) {
            chat.modules = modules.filter((id) => !ids.includes(id))
        } else {
            const added = ids.filter((id) => !modules.includes(id))
            chat.modules = [...modules, ...added]
            for (const id of added) rememberActivation(id)
            void wakeModules(added)
        }
        $ReloadGUIPointer += 1
    }

    // The bot open now: a module's ⋮ menu links the module to it as one of
    // its own modules (the chain), or unlinks it — the same pairing as the
    // chat's module menu "이 캐릭터에서 사용" (the user's request, 2026-10-05).
    let openBot = $derived(DBState.db.characters[$selectedCharID])

    function toggleBotLink(rmodule: RisuModule) {
        const character = DBState.db.characters[$selectedCharID]
        if (!character) return
        const current = character.modules ?? []
        if (current.includes(rmodule.id)) {
            character.modules = current.filter((id) => id !== rmodule.id)
            forgetModulePair(DBState.db.modules, rmodule.id, character.chaId)
            notifySuccess(language.moduleBotUnlinked.replace('{}', character.name || 'Unnamed'))
        } else {
            character.modules = [...current, rmodule.id]
            recordModulePair(DBState.db.modules, [rmodule.id], character.chaId)
            dropMissingBotModules(character, DBState.db.modules)
            void wakeModules([rmodule.id])
            notifySuccess(language.moduleBotLinked.replace('{}', character.name || 'Unnamed'))
        }
        // Gathered first, so 최근순 lifts the folder the module ends up in.
        syncLinkedFolders()
        if (character.modules.includes(rmodule.id)) rememberActivation(rmodule.id)
        rerenderChatForModules()
    }

    // A folder's ⋮ menu: every module in it linked to the open bot at once,
    // or all unlinked when the bot already has them all (folderBotLinkChange).
    function folderModuleIds(indexes: number[]) {
        return indexes.map((index) => displayModules[index]?.id).filter((id): id is string => !!id)
    }

    function toggleFolderBotLink(indexes: number[]) {
        const character = DBState.db.characters[$selectedCharID]
        const ids = folderModuleIds(indexes)
        if (!character || ids.length === 0) return
        const change = folderBotLinkChange(character.modules, ids)
        character.modules = change.modules
        syncLinkedFolders()
        rerenderChatForModules()
        const name = character.name || 'Unnamed'
        if (change.unlinked.length > 0) {
            for (const id of change.unlinked) forgetModulePair(DBState.db.modules, id, character.chaId)
            notifySuccess(language.moduleFolderBotUnlinked.replace('{}', name).replace('{n}', String(change.unlinked.length)))
            return
        }
        recordModulePair(DBState.db.modules, change.linked, character.chaId)
        dropMissingBotModules(character, DBState.db.modules)
        for (const id of change.linked) rememberActivation(id)
        void wakeModules(change.linked)
        notifySuccess(language.moduleFolderBotLinked.replace('{}', name).replace('{n}', String(change.linked.length)))
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
        void wakeModules(ids)
    }

    function originalModuleIndex(displayIndex: number) {
        const id = displayModules[displayIndex]?.id
        return id ? DBState.db.modules.findIndex((module) => module.id === id) : -1
    }

    async function openEditor(index: number) {
        if (openingModule) return
        const originalIndex = originalModuleIndex(index)
        const rmodule = DBState.db.modules[originalIndex]
        if (!rmodule || rmodule.mcp) return
        // Looked at: no longer NEW (newMarks.svelte.ts).
        markSeen(rmodule)
        rememberListScroll()
        // Being worked on: the sweep leaves it whole until the next boot.
        keepModuleWhole(rmodule.id)
        const stored = isColdModule(rmodule)
        let draft: RisuModule = $state.snapshot(rmodule) as RisuModule
        if (stored) {
            // Shown, not brought back: turning it on or saving does that.
            openingModule = true
            try {
                draft = await wholeModule(draft)
            } catch (error) {
                alertError(language.moduleColdLoadFailed + (error instanceof Error ? error.message : String(error)))
                return
            } finally {
                openingModule = false
            }
        }
        tempModule = cloneModuleDraft(draft)
        editingStored = stored
        editModuleIndex = DBState.db.modules.findIndex((module) => module.id === rmodule.id)
        if (editModuleIndex < 0) return
        mode = 2
    }

    async function exportModuleAt(index: number) {
        const rmodule = displayModules[index]
        if (!rmodule || rmodule.mcp) return
        const sel = parseInt(await alertSelect([`CharX (${language.recommended})`, `RisuM (Legacy)`, language.cancel]))
        if (sel === 0) exportModule(rmodule)
        else if (sel === 1) exportModuleLegacy(rmodule)
    }

    async function removeModule(index: number) {
        const rmodule = displayModules[index]
        if (!rmodule) return
        const d = await alertConfirm(`${language.removeConfirm}` + rmodule.name)
        if (!d) return
        removeModulesFromDatabase(new Set([rmodule.id]))
        notifySuccess(language.moduleDeleted)
    }

    /**
     * Persists only small catalog overlays. The upstream module array keeps its
     * physical order; visual recency lives in moduleActivationHistory.
     */
    function applyPlacements(placements: FolderedItemPlacement[], fromDrop = false) {
        if (placements.length !== displayModules.length) return
        // LEGACY-MODULE-FOLDERS: history uses the drawn order before stored hidden IDs are restored.
        const legacyHistory = legacyModuleFolders && moduleCatalogSort === 'recent'
            ? legacyActivationHistoryFromPlacements(placements, displayModules.map((module) => module.id))
            : undefined
        if (legacyModuleFolders && legacyFolderView) {
            placements = storedLegacyPlacements(placements, legacyFolderView.itemFolderIds, displayModules.map((module) => module.folderId))
        }
        const currentFolders = displayFolders
        const folderById = new Map(placements.map(({ index, folderId }) => [displayModules[index]?.id, folderId]))
        // The rows before and after, read before the modules change under displayModules.
        const placedBefore = displayModules.map((module) => ({
            id: module.id,
            folderId: module.folderId || currentFolders.find((folder) => folder.moduleIds?.includes(module.id))?.id,
        }))
        const placedAfter = placements
            .map(({ index, folderId }) => ({ id: displayModules[index]?.id, folderId }))
            .filter((item): item is { id: string, folderId: string | undefined } => !!item.id)
        // Only a module whose folder changed gets a new object: the save
        // tracker compares every replaced module again on the next save. One
        // moved into the ★ folder is a favorite, one moved out of it is not.
        const favoritesId = currentFolders.find(isModuleFavoritesFolder)?.id
        DBState.db.modules = DBState.db.modules.map((module) => {
            const folderId = folderById.get(module.id)
            if (module.folderId === folderId) return module
            const favorite = favoriteAfterMove(!!module.favorite, module.folderId, folderId, favoritesId)
            return favorite === !!module.favorite ? { ...module, folderId } : { ...module, folderId, favorite }
        })
        const synchronized = synchronizeModuleFolderMembership(
            DBState.db.modules,
            currentFolders,
            { importLegacyWhenFolderIdsEmpty: false },
        )
        const dissolved = dissolveShrunkenModuleFolders(DBState.db.modules, synchronized, currentFolders)
        DBState.db.modules = dissolved.modules
        DBState.db.moduleFolders = dissolved.folders
        // A favorite left loose goes into the ★ folder; an emptied ★ folder goes.
        syncFavoriteModules()
        if (moduleCatalogSort === 'registered') {
            return
        }
        if (legacyHistory) { // LEGACY-MODULE-FOLDERS: September menu moves store displayed order, newest first.
            DBState.db.moduleActivationHistory = legacyHistory
            DBState.db.moduleFolders = recordModuleFolderOrder(DBState.db.moduleFolders)
            return
        }
        if (fromDrop) {
            // What the drop left on screen is the order from now on: a dragged
            // module or folder stays where it was put, a module on now too;
            // only the favorites stay above (activationHistoryFromDisplay).
            DBState.db.moduleActivationHistory = activationHistoryFromDisplay(
                placedAfter.map((item) => item.id),
                DBState.db.moduleActivationHistory,
                moduleFallbackOrders(),
            )
        } else {
            DBState.db.moduleActivationHistory = activationHistoryAfterPlacement(
                placedBefore,
                placedAfter,
                DBState.db.moduleActivationHistory ?? [],
                moduleFallbackOrders(),
            )
        }
        DBState.db.moduleFolders = recordModuleFolderOrder(DBState.db.moduleFolders)
    }

    function applyFolders(next: PromptPresetFolder[]) {
        // LEGACY-MODULE-FOLDERS: merge edits to real folders without erasing hidden folders or saved parents.
        if (legacyModuleFolders) {
            const shownIds = new Set(legacyFolderView?.folders.map((folder) => folder.id) ?? [])
            const current = DBState.db.moduleFolders ?? []
            const originalById = new Map(current.map((folder) => [folder.id, folder]))
            const queue = next.filter((folder) => shownIds.has(folder.id) || !originalById.has(folder.id))
            const restoreParent = (drawn: PromptPresetFolder) => {
                const original = originalById.get(drawn.id)
                return original ? { ...original, ...drawn, nodeOnlyParentFolderId: original.nodeOnlyParentFolderId } : drawn
            }
            const merged = current.flatMap((folder) => {
                if (!shownIds.has(folder.id)) return [folder]
                const replacement = queue.shift()
                return replacement ? [restoreParent(replacement)] : []
            })
            merged.push(...queue.map(restoreParent))
            const keptIds = new Set(merged.map((folder) => folder.id))
            next = merged.map((folder) => {
                const parent = folder.nodeOnlyParentFolderId
                if (!parent || keptIds.has(parent)) return folder
                return { ...folder, nodeOnlyParentFolderId: originalById.get(parent)?.nodeOnlyParentFolderId }
            })
        }
        DBState.db.moduleFolders = recordModuleFolderOrder(synchronizeModuleFolderMembership(
            DBState.db.modules,
            next,
            { importLegacyWhenFolderIdsEmpty: false },
        ))
        // A folder delete hands over the folders from before its module moves.
        syncFavoriteModules()
    }

    // Color, the missing mark and a broken pairing in one dialog (ItemInfoDialog).
    function changeFolderColor(folder: PromptPresetFolder) {
        openItemInfo('moduleFolder', folder.id)
    }

    function toggleFolderFavorite(folder: PromptPresetFolder) {
        const changed = displayFolders.map((item) => item.id === folder.id ? { ...item, favorite: !item.favorite } : item)
        if (!folder.favorite) {
            const index = changed.findIndex((item) => item.id === folder.id)
            changed.unshift(...changed.splice(index, 1))
            if (!legacyModuleFolders) { // LEGACY-MODULE-FOLDERS: September favorite folders do not activate members.
                // Recent sorting lifts this folder's members only in the normal view.
                const inside = new Set([folder.id])
                for (let grew = true; grew;) {
                    grew = false
                    for (const item of changed) {
                        if (!inside.has(item.id) && item.nodeOnlyParentFolderId && inside.has(item.nodeOnlyParentFolderId)) {
                            inside.add(item.id)
                            grew = true
                        }
                    }
                }
                const members = DBState.db.modules
                    .filter((module) => (module.folderId && inside.has(module.folderId)) || changed.some((item) => inside.has(item.id) && item.moduleIds?.includes(module.id)))
                    .map((module) => module.id)
                DBState.db.moduleActivationHistory = liftModulesToNewest(DBState.db.moduleActivationHistory, moduleFallbackOrders(), members)
            }
        }
        applyFolders(changed)
    }

    function folderColor(folder: PromptPresetFolder, indexes: number[]) {
        return listTitleColor(folder.titleColor, indexes.some((index) => hasMissingAssets(displayModules[index])))
    }

    let pairedModules = $derived(moduleLinks(DBState.db.modules, DBState.db.characters, DBState.db.nodeOnlyArchivedCharacters ?? []))

    // Files dragged in from outside onto the catalog import as modules, a CHARX
    // too (anywhere else it imports as a character). A link imports as this
    // page's Proton box imports it.
    const moduleFileDrop = new FileDropSurface({
        accepts: () => mode === 0,
        onDrop: (files) => importDroppedFiles(files, 'module'),
        onLink: (url) => importDroppedLink(url, 'module'),
    })
    $effect(() => moduleFileDrop.attachWindowReset())

    onDestroy(() => {
        refreshModules()
    })
</script>
<div
    bind:this={modulePageRoot}
    class="contents"
    role="region"
    aria-label={language.modules}
    ondragenter={moduleFileDrop.over}
    ondragover={moduleFileDrop.over}
    ondragleave={moduleFileDrop.leave}
    ondrop={moduleFileDrop.drop}
>
{#if mode === 0}
    {#snippet sortActions()}
        <div class="flex shrink-0 items-center gap-2">
            <!-- In a narrow list (the sidebar panel on a phone) the labels hide so the row fits. -->
            <ShButton size="sm" variant={moduleCatalogSort === 'registered' ? 'default' : 'outline'} onclick={() => setModuleCatalogSort('registered')} title="등록순" aria-label="등록순">
                <ListOrderedIcon /><span class="hidden @[20rem]/folders:inline">등록순</span>
            </ShButton>
            <ShButton size="sm" variant={moduleCatalogSort === 'recent' ? 'default' : 'outline'} onclick={() => setModuleCatalogSort('recent')} title="최근 활성화순" aria-label="최근순">
                <Clock3Icon /><span class="hidden @[20rem]/folders:inline">최근순</span>
            </ShButton>
            <!-- LEGACY-MODULE-FOLDERS -->
            <ShButton size="sm" variant={legacyModuleFolders ? 'default' : 'outline'} onclick={toggleLegacyModuleFolders} title="마이그레이션 전 9월 형식: 폴더는 한 단계, 자동 폴더([링크]·[링크2]·[프롬]·★와 링크 안의 [유사 후보]) 없이. 보기만 바뀌고 배치는 그대로" aria-label="구버전 폴더">
                <span>구버전 폴더</span>
            </ShButton>
        </div>
    {/snippet}

    <SettingPage title={language.modules}>
    <FileDropIndicator active={moduleFileDrop.active} icon={HardDriveUpload} label={`${language.importModule} · CHARX / RISUM / ${language.linkDropLabel}`} />

    <!-- LEGACY-MODULE-FOLDERS: pass a flattened drawing view to the catalog. -->
    <FolderedList
        bind:searchQuery={moduleSearchQuery}
        folderToolbarActions={sidePanel ? sortActions : undefined}
        searchActions={sidePanel ? undefined : sortActions}
        maxFolderDepth={legacyModuleFolders ? 1 : 5}
        flatFolderView={legacyModuleFolders}
        onItemMoveToFolder={legacyModuleFolders ? applyPlacements : undefined /* LEGACY-MODULE-FOLDERS */}
        folders={legacyFolderView?.folders ?? displayFolders}
        itemFolderIds={legacyFolderView?.itemFolderIds ?? displayModules.map(m => m.folderId)}
        itemSearchTexts={displayModules.map(m => `${m.name}\n${m.description ?? ''}`)}
        showItemCount
        storageKey="risu-module-folders-expanded-v3"
        defaultCollapsed
        newFoldersFirst
        rootItemsStandalone
        interleaveItems
        legacyInterleave={legacyModuleFolders /* LEGACY-MODULE-FOLDERS */}
        promotedItemIndex={promotedModuleIndex}
        promotedFolderId={promotedFolderId}
        favoriteItemIndexes={legacyModuleFolders ? undefined : favoriteModuleIndexes}
        activeItemIndexes={legacyModuleFolders ? undefined : activeModuleIndexes}
        selectedIndex={foundModuleIndex}
        reorderDisabled={legacyModuleFolders || moduleCatalogSort !== 'recent'}
        folderTitleColor={folderColor}
        onFolderColor={changeFolderColor}
        onFolderFavorite={toggleFolderFavorite}
        showFolderDelete
        showMenuCancel
        rowContextMenu
        rowHoldMenu={false}
        folderRenameLabel="폴더이름변경하기"
        onSelect={openEditor}
        onItemsChange={applyPlacements}
        onFoldersChange={applyFolders}
        onDelete={removeModule}
    >
        {#snippet actions()}
            <div class="flex flex-wrap items-center gap-2">
            <ShButton size="sm" onclick={() => {
                rememberListScroll()
                tempModule = { name: '', description: '', id: v4() }
                mode = 1
            }} title={language.createModule} aria-label={language.createModule}><PlusIcon /><span class="hidden @[20rem]/folders:inline">{language.createModule}</span></ShButton>
            <ShButton size="sm" variant="outline" onclick={() => importModuleFiles()} title={language.importModule} aria-label={language.importModule}><HardDriveUpload /><span class="hidden @[20rem]/folders:inline">{language.importModule}</span></ShButton>
            <ShButton size="sm" variant="outline" onclick={() => importModuleFromProtonDrive()} title={language.importFromProtonAsModule} aria-label={language.importFromProtonAsModule}><CloudDownloadIcon /></ShButton>
            <ShButton size="sm" variant="outline" onclick={() => importMCPModule()} title="MCP" aria-label="MCP"><Waypoints /></ShButton>
            </div>
        {/snippet}
        {#snippet folderLeadingActions(folder, indexes)}
            {#if folder.nodeOnlyLinkFolder}
                <!-- The [링크] folder (linkedModuleFolder.ts): the green chain its modules carry, on the folder. -->
                <span class="no-sort inline-flex shrink-0 text-emerald-500" role="img" aria-label="봇에 연결된 모듈 폴더" title="봇에 연결된 모듈 폴더"><Link2Icon size={14} strokeWidth={2.5} /></span>
            {:else if folder.nodeOnlyPresetFolder === 'orphans'}
                <!-- [프롬] › 프롬 없음 (presetModuleFolder.ts): modules whose prompt presets are all gone. -->
                <span class="no-sort inline-flex shrink-0 text-red-500" role="img" aria-label={language.presetModuleOrphans} title={language.presetModuleOrphans}><UnlinkIcon size={14} strokeWidth={2.5} /></span>
            {:else if folder.nodeOnlyPresetFolder}
                <!-- [프롬] and a preset's folder: orange, as the modules a preset turns on are drawn. -->
                <span class="no-sort inline-flex shrink-0 text-amber-500" role="img" aria-label={language.presetModuleFolder} title={language.presetModuleFolder}><Link2Icon size={14} strokeWidth={2.5} /></span>
            {/if}
            {#if indexes.some((index) => hasMissingAssets(displayModules[index]))}
                <span class="no-sort shrink-0" aria-label="에셋 누락" title="에셋 누락">❗</span>
            {/if}
        {/snippet}
        {#snippet folderActions(_folder, _indexes, shownIndexes)}
            {@const activeCount = shownIndexes.filter((index) => { const rmodule = displayModules[index]; return !!rmodule && (isGlobal(rmodule) || (sidePanel && isInChat(rmodule))) }).length}
            {@const chatCount = sidePanel ? shownIndexes.filter((index) => { const rmodule = displayModules[index]; return !!rmodule && !isGlobal(rmodule) && isInChat(rmodule) }).length : 0}
            {@const globalCount = activeCount - chatCount}
            <!-- Orange when a module inside is on by itself (the open bot's own, an
                 integrated one, or 🎨 with the bot's illustration on) the way its own
                 globe is drawn, unless one is global (the user's request, 2026-10-28). -->
            {@const autoCount = shownIndexes.filter((index) => {
                const rmodule = displayModules[index]
                return !!rmodule && !isGlobal(rmodule) && (isIntegrated(rmodule) || isBotModule(rmodule) || isIllustrationOn(rmodule) || isEditModeOn(rmodule))
            }).length}
            {@const folderGlobeLabel = sidePanel ? `${chatCount > 0 ? language.moduleSideChatOn : globalCount > 0 ? language.moduleSideGlobalOn : autoCount > 0 ? language.moduleSideAutomatic : language.moduleSideOff} (${activeCount}/${shownIndexes.length})${!currentChat() ? ` · ${language.moduleChatRequiresOpenChat}` : ''}` : `폴더 모듈 전체 활성화 (${activeCount}/${shownIndexes.length})${autoCount > 0 ? ` · 자동으로 켜짐 ${autoCount}개` : ''}`}
            <span class="no-sort shrink-0" use:tooltip={folderGlobeLabel}><button
                class="no-sort shrink-0 rounded-sm p-1 {sidePanel && !currentChat() ? 'cursor-not-allowed' : 'cursor-pointer'} {sidePanel && chatCount > 0 ? 'text-blue-500 bg-blue-500/15' : globalCount > 0 ? sidePanel ? 'text-blue-500 bg-blue-500/15' : 'text-emerald-500 bg-emerald-500/15' : autoCount > 0 ? 'text-amber-500 bg-amber-500/15 hover:text-primary' : 'text-textcolor2 hover:text-primary'}"
                title={folderGlobeLabel}
                aria-label={folderGlobeLabel}
                disabled={sidePanel && !currentChat()}
                onclick={(event) => { event.stopPropagation(); if (sidePanel) toggleFolderChat(shownIndexes); else toggleFolderGlobal(shownIndexes) }}
            >{#if sidePanel && chatCount > 0}<MessageSquareIcon size={17}/>{:else}<Globe size={17}/>{/if}</button></span>
        {/snippet}
        {#snippet folderCount(_folder, shownIndexes)}
            <!-- On / all, as the chat module menu shows it (the user's request, 2026-11-20: "N/47"); the same count as the globe. -->
            {@const activeCount = shownIndexes.filter((index) => { const rmodule = displayModules[index]; return !!rmodule && (isGlobal(rmodule) || (sidePanel && isInChat(rmodule))) }).length}
            {@const chatCount = sidePanel ? shownIndexes.filter((index) => { const rmodule = displayModules[index]; return !!rmodule && !isGlobal(rmodule) && isInChat(rmodule) }).length : 0}
            <span class="text-xs {chatCount > 0 ? 'text-blue-500' : activeCount > 0 ? 'text-emerald-500' : 'text-textcolor2'}">{activeCount > 0 ? `${activeCount}/` : ''}{shownIndexes.length}</span>
        {/snippet}
        {#snippet folderMenuItems(_folder, indexes)}
            {#if openBot && indexes.length > 0}
                {@const ids = folderModuleIds(indexes)}
                {@const linkedCount = ids.filter((id) => openBot.modules?.includes(id)).length}
                <ShDropdownMenuItem onSelect={() => toggleFolderBotLink(indexes)}>
                    {#if linkedCount === ids.length}<UnlinkIcon /><span>{language.moduleFolderBotUnlink.replace('{}', openBot.name || 'Unnamed')}</span>
                    {:else}<LinkIcon /><span>{language.moduleFolderBotLink.replace('{}', openBot.name || 'Unnamed').replace('{n}', `${linkedCount}/${ids.length}`)}</span>{/if}
                </ShDropdownMenuItem>
            {/if}
        {/snippet}
        {#snippet itemContent(index)}
            {@const rmodule = displayModules[index]}
            {@const source = moduleSource(rmodule)}
            {@const globeLabel = `${isGlobal(rmodule) ? language.enableGlobal : isBotModule(rmodule) ? language.moduleAutoForBot : isIllustrationOn(rmodule) ? language.moduleAutoForIllustration : isEditModeOn(rmodule) ? language.moduleAutoForEditMode : language.enableGlobal}${openBot ? ' · 꾹 누르면 지금 봇에 연결/해제' : ''}`}
            {#if rmodule.mcp}
                <Waypoints size={18} class="shrink-0 text-textcolor2" />
            {/if}
            <div class="flex flex-col min-w-0 grow" class:stored-module-muted={isColdModule(rmodule)} title={isColdModule(rmodule) ? language.moduleColdTitle : undefined}>
                <span class="truncate text-textcolor" style:color={listTitleColor(rmodule.titleColor, hasMissingAssets(rmodule))}>{#if hasMissingAssets(rmodule)}<span aria-label="에셋 누락" title="에셋 누락">❗</span> {/if}<PairedModuleMark link={pairedModules.get(rmodule.id)} />{#if hasNewMark(rmodule)}<NewMark class="mr-1" />{/if}{rmodule.favorite ? '★ ' : ''}{rmodule.name}</span>
                <span class="text-xs text-textcolor2 truncate">
                    <span
                        class:text-sky-300={source.label === '로컬'}
                        class:text-violet-300={source.label === '웹'}
                        class:text-emerald-300={source.label === '모바일'}
                        class:text-amber-300={source.label === '포켓'}
                        class:border-dashed={!source.recorded}
                        title={source.recorded ? `기록된 출처: ${source.label}` : '출처 기록 없음 · 기존 웹리스 기준'}
                    >[{source.label}]</span>
                    · 에셋 {moduleAssetCount(rmodule)}개{#if isColdModule(rmodule)} · {language.moduleColdBadge}{/if} · {rmodule.description || 'No description provided'}
                </span>
            </div>
            {#if sidePanel}
                <ShDropdownMenu bind:open={() => scopeMenus[rmodule.id] ?? false, (value) => { scopeMenus[rmodule.id] = value }}>
                    <ShDropdownMenuTrigger>
                        {#snippet child({ props })}
                            <span class="no-sort shrink-0" use:tooltip={sideScopeLabel(rmodule)}>
                                <button {...props} class="no-sort select-none [-webkit-touch-callout:none] shrink-0 p-1 rounded-sm {currentChat() || isGlobal(rmodule) || isBotModule(rmodule) ? 'cursor-pointer' : 'cursor-not-allowed'} {isGlobal(rmodule) ? 'text-blue-500 bg-blue-500/15' : isBotModule(rmodule) ? 'text-amber-500 bg-amber-500/15' : isInChat(rmodule) ? 'text-blue-500 bg-blue-500/15' : isIntegrated(rmodule) || isIllustrationOn(rmodule) || isEditModeOn(rmodule) ? 'text-amber-500 bg-amber-500/15 hover:text-primary' : 'text-textcolor2 hover:text-primary'}"
                                    use:moduleGlobeHold={{ tap: () => tapSideScope(rmodule), hold: () => { scopeMenus[rmodule.id] = true }, canHold: () => true }}
                                    onpointerdown={(event) => event.stopPropagation()}
                                    onpointerup={(event) => event.stopPropagation()}
                                    onclick={(event) => event.stopPropagation()}
                                    oncontextmenu={(event) => { event.preventDefault(); event.stopPropagation(); scopeMenus[rmodule.id] = true }}
                                    title={sideScopeLabel(rmodule)} aria-label={sideScopeLabel(rmodule)} aria-pressed={isGlobal(rmodule) || isBotModule(rmodule) || isInChat(rmodule)} data-scope-button>
                                    {#if !isGlobal(rmodule) && !isBotModule(rmodule) && isInChat(rmodule)}<MessageSquareIcon size={18}/>{:else}<Globe size={18}/>{/if}
                                </button>
                            </span>
                        {/snippet}
                    </ShDropdownMenuTrigger>
                    <ShDropdownMenuContent align="end" class="min-w-40">
                        <ShDropdownMenuItem disabled={!currentChat()} onSelect={() => { scopeMenus[rmodule.id] = false; toggleChatScope(rmodule.id) }}><MessageSquareIcon /><span>{language.moduleSideChat}</span>{#if isInChat(rmodule)}<CheckIcon class="ml-auto" />{/if}</ShDropdownMenuItem>
                        <ShDropdownMenuItem onSelect={() => { scopeMenus[rmodule.id] = false; toggleGlobal(rmodule) }}><Globe class="text-blue-500" /><span>{language.moduleSideGlobal}</span>{#if isGlobal(rmodule)}<CheckIcon class="ml-auto" />{/if}</ShDropdownMenuItem>
                        {#if openBot}<ShDropdownMenuItem onSelect={() => { scopeMenus[rmodule.id] = false; toggleBotLink(rmodule) }}><Globe class="text-amber-500" /><span>{language.moduleSideBot.replace('{}', openBot.name || 'Unnamed')}</span>{#if isBotModule(rmodule)}<CheckIcon class="ml-auto" />{/if}</ShDropdownMenuItem>{/if}
                    </ShDropdownMenuContent>
                </ShDropdownMenu>
            {:else}
                <!-- MODULE-BOT-LINK-MENU: globe hold links the open bot (user request, 2026-11-20). -->
                <button class="no-sort select-none [-webkit-touch-callout:none] shrink-0 p-1 cursor-pointer {isGlobal(rmodule) ? 'text-blue-500' : isIntegrated(rmodule) || isBotModule(rmodule) || isIllustrationOn(rmodule) || isEditModeOn(rmodule) ? 'text-amber-500 hover:text-primary' : 'text-textcolor2 hover:text-primary'}"
                    use:tooltip={globeLabel}
                    use:moduleGlobeHold={{ tap: () => toggleGlobal(rmodule), hold: () => toggleBotLink(rmodule), canHold: () => !!openBot }}
                    aria-label={globeLabel}>
                    <Globe size={18}/>
                </button>
            {/if}
        {/snippet}
        {#snippet itemMenu(index)}
            {@const rmodule = displayModules[index]}
            {#if !rmodule.mcp}
                <ShDropdownMenuItem onSelect={() => openEditor(index)}><SquarePen /><span>{language.edit}</span></ShDropdownMenuItem>
                <ShDropdownMenuItem onSelect={() => exportModuleAt(index)}><Share2Icon /><span>{language.download}</span></ShDropdownMenuItem>
            {/if}
            {#if openBot}
                <ShDropdownMenuItem onSelect={() => toggleBotLink(rmodule)}>
                    {#if openBot.modules?.includes(rmodule.id)}<UnlinkIcon /><span>{language.moduleBotUnlink.replace('{}', openBot.name || 'Unnamed')}</span>
                    {:else}<LinkIcon /><span>{language.moduleBotLink.replace('{}', openBot.name || 'Unnamed')}</span>{/if}
                </ShDropdownMenuItem>
            {/if}
            {#if pairedModules.get(rmodule.id)?.state === 'linked'}
                <ShDropdownMenuItem onSelect={() => findBotsOfModule(rmodule.id)}><UserSearchIcon /><span>{language.pairFindBot}</span></ShDropdownMenuItem>
            {/if}
            {#if protonLinkOf(rmodule)}
                <!-- The Proton link it was downloaded from, to fetch it again if it breaks. -->
                <ShDropdownMenuItem onSelect={() => copyProtonLink(protonLinkOf(rmodule))}><LinkIcon /><span>{language.protonLinkCopy}</span></ShDropdownMenuItem>
            {/if}
            <ShDropdownMenuItem onSelect={() => openItemInfo('module', rmodule.id)}><InfoIcon /><span>정보 (색·표시)</span></ShDropdownMenuItem>
            <!-- LEGACY-MODULE-FOLDERS: preserve folder sync without the later activation lift. -->
            <ShDropdownMenuItem onSelect={() => { rmodule.favorite = !rmodule.favorite; if (rmodule.favorite && !legacyModuleFolders) rememberActivation(rmodule.id); syncLinkedFolders() }}><StarIcon /><span>{rmodule.favorite ? '즐겨찾기 해제' : '즐겨찾기 (★ 폴더로)'}</span></ShDropdownMenuItem>
        {/snippet}
    </FolderedList>
    {#if DBState.db.modules.length === 0}
        <div class="text-textcolor2 p-3">{language.noModules}</div>
    {/if}

    </SettingPage>
{:else if mode === 1}
    <SettingPage title={language.createModule}>
    <ModuleMenu bind:currentModule={tempModule}/>
    <ShButton variant="primary" className="mt-6 w-full" onclick={() => {
        addModuleToDatabase(tempModule)
        notifySuccess(language.moduleCreated)
        void returnToModuleList()
    }}>{language.createModule}</ShButton>
    </SettingPage>
{:else if mode === 2}
    <SettingPage title={language.editModule}>
    {#if editingStored}
        <div class="mb-3 rounded-md border border-darkborderc bg-darkbg/40 px-3 py-2 text-sm text-textcolor2">{language.moduleColdEditorNote}</div>
    {/if}
    <ModuleMenu bind:currentModule={tempModule}/>
        <ShButton variant="primary" className="mt-6 w-full" onclick={async () => {
            DBState.db.modules[editModuleIndex] = cloneModuleDraft($state.snapshot(tempModule))
            notifySuccess(language.moduleUpdated)
            await returnToModuleList()
        }}>{language.editModule}</ShButton>
        <ShButton variant="outline" className="mt-2 w-full" disabled={converting} onclick={async () => {
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
        }}>{language.convertToCharacter}</ShButton>
    </SettingPage>
{/if}
</div>

<style>
    /* A stored module (moduleCold.svelte.ts), dimmed like a deactivated bot. */
    .stored-module-muted {
        opacity: 0.6;
    }
</style>
