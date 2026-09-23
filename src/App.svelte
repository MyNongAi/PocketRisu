<script lang="ts">
    import { DynamicGUI, settingsOpen, sideBarClosing, sideBarStore, openPresetList, openCharacterManager, openModelPresetList, openModelProfileBrowser, openPersonaList, personaSelectCallback, openMemoryPresetList, memoryPresetSelectCallback, openThemePresetList, MobileGUI, loadedStore, alertStore, LoadingStatusState, bookmarkListOpen, popupStore, popUpEditorStore } from './ts/stores.svelte';
    import Sidebar from './lib/SideBars/Sidebar.svelte';
    import { DBState, selectedCharID } from './ts/stores.svelte';
    import ChatScreen from './lib/ChatScreens/ChatScreen.svelte';
    import AlertComp from './lib/Others/AlertComp.svelte';
    import RealmPopUp from './lib/UI/Realm/RealmPopUp.svelte';
    import FolderSettingsDialog from './lib/CharacterManager/FolderSettingsDialog.svelte';
    import { showRealmInfoStore } from './ts/characterCards';
    import SavePopupIconComp from './lib/Others/SavePopupIcon.svelte';
    import { ArrowLeft, ArrowUpIcon, GlobeIcon, PlusIcon } from '@lucide/svelte';
    import { hypaV3ModalOpen, hypaV3ProgressStore } from "./ts/stores.svelte";
    import { assetViewerStore } from './ts/assetViewer.svelte';
    import { protonBrowserState } from './ts/protonBrowser.svelte';
    import PluginAlertModal from './lib/Others/PluginAlertModal.svelte';
    import LazyComponent from './lib/Others/LazyComponent.svelte';
    import UpdatePopup from './lib/Others/UpdatePopup.svelte';
    import SupportDialog from './lib/Others/SupportDialog.svelte';
    import BootBackupPrompt from './lib/Others/BootBackupPrompt.svelte';
    import PopupList from './lib/UI/PopupList.svelte';
    import LoadingOverlay from './lib/Others/LoadingOverlay.svelte';
    import Toaster from './lib/UI/GUI/Toaster.svelte';
    import RequestStatusToaster from './lib/UI/GUI/RequestStatusToaster.svelte';
    import ImportProgressToaster from './lib/UI/GUI/ImportProgressToaster.svelte';
    import sendSound from './etc/send.mp3'
    import { RISU_APP_INTERNAL_DRAG_TYPE, RISU_CHAT_ROOM_DRAG_TYPE, RISU_SIDEBAR_DRAG_TYPE } from './ts/dragTypes';
    import { importDroppedFiles } from './ts/dropImport';
    import { isEmbeddedRisuPane, parseChatRoomDragPayload, splitChatOpen } from './ts/chatSplitPane';
    import { changeChatTo } from './ts/globalApi.svelte';

    let aprilFools = $state(new Date().getMonth() === 3 && new Date().getDate() === 1)
    let aprilFoolsPage = $state(0)
    let keepingSessionAlive = $state(false)
    let legacyGridOpen = $state(false)
    let LegacyGridComponent = $state<any>(null)

    const settingsLoader = () => import('./lib/Setting/Settings.svelte')
    const characterManagerLoader = () => import('./lib/CharacterManager/CharacterManager.svelte')
    const botPresetLoader = () => import('./lib/Setting/botpreset.svelte')
    const modelPresetLoader = () => import('./lib/Setting/modelpreset.svelte')
    const modelProfileBrowserLoader = () => import('./lib/Setting/modelProfileBrowser.svelte')
    const themePresetLoader = () => import('./lib/Setting/themepreset.svelte')
    const personaLoader = () => import('./lib/Setting/listedPersona.svelte')
    const memoryPresetLoader = () => import('./lib/Setting/listedMemoryPreset.svelte')
    const mobileHeaderLoader = () => import('./lib/Mobile/MobileHeader.svelte')
    const mobileBodyLoader = () => import('./lib/Mobile/MobileBody.svelte')
    const mobileFooterLoader = () => import('./lib/Mobile/MobileFooter.svelte')
    const bookmarkLoader = () => import('./lib/Others/BookmarkList.svelte')
    const hypaModalLoader = () => import('./lib/Others/HypaV3Modal.svelte')
    const hypaProgressLoader = () => import('./lib/Others/HypaV3Progress.svelte')
    const popupEditorLoader = () => import('./lib/Others/PopupEditor.svelte')
    const assetViewerLoader = () => import('./lib/Others/AssetViewer.svelte')
    const protonBrowserLoader = () => import('./lib/Others/ProtonFolderBrowser.svelte')

    function openLegacyGrid() {
        openCharacterManager.set(false)
        void (async () => {
            LegacyGridComponent ??= (await import('./lib/Others/GridCatalog.svelte')).default
            legacyGridOpen = true
        })()
    }

    const getMainDropEffect = (e:DragEvent): DataTransfer['dropEffect'] => {
        const types = Array.from(e.dataTransfer?.types ?? [])
        if(types.includes(RISU_CHAT_ROOM_DRAG_TYPE)){
            return isEmbeddedRisuPane ? 'copy' : 'none'
        }
        if(types.includes(RISU_SIDEBAR_DRAG_TYPE)){
            return 'none'
        }
        if(types.includes(RISU_APP_INTERNAL_DRAG_TYPE)){
            return 'none'
        }
        return types.includes('Files') ? 'copy' : 'none'
    }

    const markAppInternalDrag = (e:DragEvent) => {
        e.dataTransfer?.setData(RISU_APP_INTERNAL_DRAG_TYPE, 'true')
    }

    const openDroppedChatRoom = (e: DragEvent): boolean => {
        if (!isEmbeddedRisuPane || !e.dataTransfer?.types.includes(RISU_CHAT_ROOM_DRAG_TYPE)) return false
        const payload = parseChatRoomDragPayload(e.dataTransfer.getData(RISU_CHAT_ROOM_DRAG_TYPE))
        if (!payload) return true
        const characterIndex = DBState.db.characters.findIndex((character) => character.chaId === payload.characterId)
        if (characterIndex < 0) return true
        const character = DBState.db.characters[characterIndex]
        if (!character.chats.some((chat) => chat.id === payload.chatId)) return true
        selectedCharID.set(characterIndex)
        changeChatTo(payload.chatId)
        return true
    }

    const captureLegacyModuleDrop = async (e: DragEvent) => {
        const types = Array.from(e.dataTransfer?.types ?? [])
        if(
            types.includes(RISU_APP_INTERNAL_DRAG_TYPE)
            || types.includes(RISU_SIDEBAR_DRAG_TYPE)
            || !e.dataTransfer?.files.length
        ) return

        const files = Array.from(e.dataTransfer.files)
        // A dedicated image/persona drop target may stop bubbling. Capture a
        // pure RISUM batch first so the legacy module format truly works from
        // anywhere without stealing mixed/image drops from those editors.
        if(!files.every((file) => file.name.toLocaleLowerCase().endsWith('.risum'))) return
        e.preventDefault()
        e.stopPropagation()
        await importDroppedFiles(files)
    }

</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main class="flex bg-bg w-full h-full max-w-100vw text-textcolor" ondropcapture={captureLegacyModuleDrop} ondragover={(e) => {
    const dropEffect = getMainDropEffect(e)
    e.preventDefault()
    e.dataTransfer.dropEffect = dropEffect
}} ondragstart={markAppInternalDrag} ondrop={async (e) => {
    e.preventDefault()
    if (openDroppedChatRoom(e)) return
    const types = Array.from(e.dataTransfer.types ?? [])
    if (types.includes(RISU_APP_INTERNAL_DRAG_TYPE) || types.includes(RISU_SIDEBAR_DRAG_TYPE)) {
        return
    }
    if (e.dataTransfer.files.length === 0) {
        return
    }
    await importDroppedFiles(Array.from(e.dataTransfer.files))
}} onclick={() => {
    if(keepingSessionAlive){
        return
    }

    const aliveMode = DBState?.db?.keepSessionAlive
    switch(aliveMode){
        case 'pip':{

            break
        }
        case 'sound':{
            console.log("Starting silent audio to keep session alive")
            const silentAudio = new Audio(sendSound);
            silentAudio.loop = true;
            silentAudio.volume = 0.000001;
            silentAudio.play();
            keepingSessionAlive = true;
            break
        }
    }

}}>
    {#if aprilFools}

        <div class="bg-[#212121] w-full h-screen min-h-screen text-black flex relative">
            <div class="w-full max-w-3xl mx-auto py-8 px-4 flex justify-center items-center">
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="flex flex-col w-full items-center text-[#bbbbbb]">
                    {#if aprilFoolsPage === 0}
                        <h1 class="text-3xl text-white font-bold mb-6">What can I help you?</h1>
                        <div class="resize-none relative w-full bg-[#303030] rounded-3xl h-[110px] mb-6 text-[#bbbbbb]" placeholder="Ask me" onkeydown={(e) => {
                            if(e.key === 'Enter'){
                                aprilFoolsPage = 1
                            }
                        }}>
                            <textarea class="absolute top-0 left-0 w-full placeholder-[#bbbbbb] rounded-3xl h-full p-4 bg-transparent resize-none" placeholder="Ask me"></textarea>
                            <div class="absolute bottom-2 left-4 flex gap-1.5">
                                <button class="p-2 rounded-full border border-[#bbbbbb30]">
                                    <PlusIcon size={18} color="#bbbbbb" />
                                </button>
                                <button class="p-2 rounded-full border border-[#bbbbbb30]">
                                    <GlobeIcon size={18} color="#bbbbbb" />
                                </button>
                                
                            </div>
                            <div class="absolute bottom-2 right-4 flex">
                                <button class="p-2 rounded-full bg-[#bbbbbb]">
                                    <ArrowUpIcon size={18} color="#00000080" />
                                </button>
                            </div>
                        </div>
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <div class="flex gap-1.5" onclick={() => {
                            aprilFoolsPage = 1
                        }}>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                <span class="text-[#bbbbbb]">🔍</span>
                                Search
                            </button>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                <span class="text-[#bbbbbb]">🎮</span>
                                Games
                            </button>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                <span class="text-[#bbbbbb]">🎨</span>
                                Roleplay
                            </button>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                More
                            </button>
                        </div>
                    {:else}
                    <h1 class="text-3xl text-white font-bold mb-6">
                        We do not have search results.
                    </h1>
                    <p class="text-[#bbbbbb] mb-6">
                        <!-- svelte-ignore a11y_missing_attribute -->
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        Go to <a class="text-blue-500 cursor-pointer" onclick={() => {
                            aprilFoolsPage = 0
                            aprilFools = false
                        }}>
                            PocketRisu  
                        </a>
                    </p>

                    {/if}
                </div>
            </div>
            <span class="absolute top-4 left-4 font-bold text-[#bbbbbb] text-md md:text-lg">RisyGTP-9</span>
        </div>
    {:else if !$loadedStore}
        <div class="w-full h-full flex justify-center items-center text-textcolor text-xl bg-gray-900 flex-col">
            <div class="flex flex-row items-center">
                <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-textcolor" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                <span>Loading...</span>
            </div>

            <span class="text-sm mt-2 text-textcolor2">{LoadingStatusState.text}</span>
        </div>
    {:else if $settingsOpen}
        <LazyComponent loader={settingsLoader} />
    {:else if $MobileGUI}
        <div class="w-full h-full flex flex-col">
            <LazyComponent loader={mobileHeaderLoader} />
            <LazyComponent loader={mobileBodyLoader} />
            <LazyComponent loader={mobileFooterLoader} />
        </div>
    {:else}
        {#if legacyGridOpen && LegacyGridComponent}
            <LegacyGridComponent endGrid={() => { legacyGridOpen = false }} />
        {:else}
        {#if (!$DynamicGUI)}
            {#if $splitChatOpen || isEmbeddedRisuPane}
                <div
                    class="split-workspace-sidebar fixed left-0 top-0 z-30 flex h-full"
                    class:pointer-events-none={!$sideBarStore}
                >
                    <Sidebar hidden={!$sideBarStore} {openLegacyGrid} />
                    {#if $sideBarStore}
                        <button
                            type="button"
                            class="mt-3 flex h-12 w-12 shrink-0 items-center justify-center rounded-r-md border border-l-0 border-transparent bg-darkbg text-textcolor transition-colors hover:border-neutral-200"
                            aria-label="사이드바 닫기"
                            title="사이드바 닫기"
                            onclick={() => sideBarClosing.set(true)}
                        >
                            <ArrowLeft />
                        </button>
                    {/if}
                </div>
            {:else}
                <Sidebar hidden={!$sideBarStore} {openLegacyGrid} />
            {/if}
        {:else}
            <div class="top-0 w-full h-full left-0 z-30 flex flex-row items-center" class:fixed={$sideBarStore} class:hidden={!$sideBarStore} >
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <Sidebar hidden={false} {openLegacyGrid} />
            </div>
        {/if}
        <ChatScreen />
        {#if $openCharacterManager}
            <LazyComponent loader={characterManagerLoader} />
        {/if}
        {/if}
    {/if}
    <AlertComp />
    {#if $showRealmInfoStore}
        <RealmPopUp bind:openedData={$showRealmInfoStore} />
    {/if}
    <FolderSettingsDialog />
    {#if $openPresetList}
        <LazyComponent loader={botPresetLoader} props={{ close: () => {$openPresetList = false} }} />
    {/if}
    {#if $openModelPresetList}
        <LazyComponent loader={modelPresetLoader} props={{ close: () => {$openModelPresetList = false} }} />
    {/if}
    {#if $openModelProfileBrowser}
        <LazyComponent loader={modelProfileBrowserLoader} props={{ close: () => {$openModelProfileBrowser = false} }} />
    {/if}
    {#if $openThemePresetList}
        <LazyComponent loader={themePresetLoader} props={{ close: () => {$openThemePresetList = false} }} />
    {/if}
    {#if $openPersonaList}
        <LazyComponent loader={personaLoader} props={{ close: () => {$openPersonaList = false; $personaSelectCallback = null}, onSelect: $personaSelectCallback }} />
    {/if}
    {#if $openMemoryPresetList}
        <LazyComponent loader={memoryPresetLoader} props={{ close: () => {$openMemoryPresetList = false; $memoryPresetSelectCallback = null}, onSelect: $memoryPresetSelectCallback }} />
    {/if}
    {#if $bookmarkListOpen}
        <LazyComponent loader={bookmarkLoader} />
    {/if}
    {#if $hypaV3ModalOpen}
        <LazyComponent loader={hypaModalLoader} />
    {/if}
    <SavePopupIconComp />
    {#if $hypaV3ProgressStore.open}
        <LazyComponent loader={hypaProgressLoader} />
    {/if}
    <PluginAlertModal />
    <LoadingOverlay />
    <UpdatePopup />
    <SupportDialog />
    <BootBackupPrompt />
    {#if popupStore.children}
        <PopupList />
    {/if}
    {#if popUpEditorStore.open}
        <LazyComponent loader={popupEditorLoader} />
    {/if}
    {#if assetViewerStore.open}
        <LazyComponent loader={assetViewerLoader} />
    {/if}
    {#if protonBrowserState.open}
        <LazyComponent loader={protonBrowserLoader} />
    {/if}
    <Toaster />
    <RequestStatusToaster />
    <ImportProgressToaster />
</main>
