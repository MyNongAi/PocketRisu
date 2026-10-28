<script lang="ts">
    import { untrack } from 'svelte';
    import { getCustomBackground, getEmotion } from "../../ts/util";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { CharEmotion, openModuleListStore } from "../../ts/stores.svelte";
    import ResizeBox from './ResizeBox.svelte'
    import DefaultChatScreen from "./DefaultChatScreen.svelte";
    import defaultWallpaper from '../../etc/bg.jpg'
    import ChatList from "../Others/ChatList.svelte";
    import TransitionImage from "./TransitionImage.svelte";
    import BackgroundDom from "./BackgroundDom.svelte";
    import SideBarArrow from "../UI/GUI/SideBarArrow.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";
    import { BackLayerRank, useBackLayer } from 'src/ts/gui/backLayers.svelte';
    import { hideFloatingBotControls } from 'src/ts/gui/floatingBotControls';
    import { wholeBotAssets } from 'src/ts/gui/wholeAssets';
    import { paneView, setPaneContext, type PaneId } from 'src/ts/chatPanes.svelte';
    import { activatePane } from 'src/ts/paneActivation';
    import { setPaneOverlayOpen } from 'src/ts/splitLayout.svelte';

    // Which pane of the split this is (chatPanes.svelte.ts); 'main' without one.
    let { pane = 'main' }: { pane?: PaneId } = $props()
    // svelte-ignore state_referenced_locally
    const view = paneView(pane)
    setPaneContext(view)
    // A touch or focus inside makes this pane the selected chat before the
    // touch's own action runs, so the action acts on what it shows.
    const takeSelection = () => { activatePane(view.pane) }
    let openChatList = $state(false)
    let openModuleList = $state(false)
    useBackLayer(BackLayerRank.Popup, () => openChatList, () => { openChatList = false })
    useBackLayer(BackLayerRank.Popup, () => openModuleList && !openChatList, () => { openModuleList = false })

    // The module menu edits the selected chat, so the pane holding the
    // selection opens it: both panes took the request, the main one first,
    // and the side pane's button opened it over the left chat (2026-10-22
    // split review). A narrow split's own overlay over the pane is closed so
    // the menu shows.
    $effect(() => {
        if ($openModuleListStore && view.active) {
            openModuleList = true
            openModuleListStore.set(false)
            untrack(() => setPaneOverlayOpen(view.pane, false))
        }
    })
    // Left open, it would go on editing whatever the other pane then selects.
    $effect(() => {
        if (!view.active) untrack(() => { openModuleList = false })
    })

    const wallPaper = `background: url(${defaultWallpaper})`
    const externalStyles = 
            ("background: " + (DBState.db.textScreenColor ? (DBState.db.textScreenColor + '80') : "rgba(0,0,0,0.8)") + ';\n')
        +   (DBState.db.textBorder ? "text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;" : '')
        +   (DBState.db.textScreenRounded ? "border-radius: 2rem; padding: 1rem;" : '')
        +   (DBState.db.textScreenBorder ? `border: 0.3rem solid ${DBState.db.textScreenBorder};` : '')
    let bgImg= $state('')
    let lastBg = $state('')
    $effect.pre(() => {
        (async () =>{
            if(DBState.db.customBackground !== lastBg){
                lastBg = DBState.db.customBackground
                bgImg = await getCustomBackground(DBState.db.customBackground)
            }
        })()
    });
</script>

<!-- `isolate` keeps bot HTML/CSS z-index inside the chat layer. The PC
     split's second workspace sits beside the whole left side now
     (SplitWorkspace in App), so settings no longer unmount it. -->
<div class="grow h-full min-w-0 flex relative" data-chat-pane={view.pane} onpointerdowncapture={takeSelection} onfocusincapture={takeSelection} use:hideFloatingBotControls={!!view.character?.nodeOnlyHideFloatingButtons} use:wholeBotAssets={!!view.character?.nodeOnlyWholeAssets}>
<section
    class="grow h-full min-w-0 relative"
>
{#if DBState.db.theme === 'waifu'}
    <div class="isolate grow h-full flex justify-center relative" style="{bgImg.length < 4 ? wallPaper : bgImg}">
        <SideBarArrow />
        <BackgroundDom />
        {#if view.characterIndex >= 0}
            {#if view.character?.viewScreen !== 'none'}
                <div class="h-full mr-10 flex justify-end halfw" style:width="{42 * (DBState.db.waifuWidth2 / 100)}rem">
                    <TransitionImage classType="waifu" src={getEmotion(DBState.db, $CharEmotion, 'plain')}/>
                </div>
            {/if}
        {/if}
        <div class="h-full w-2xl" style:width="{42 * (DBState.db.waifuWidth / 100)}rem" class:halfwp={view.characterIndex >= 0 && view.character?.viewScreen !== 'none'}>
            <DefaultChatScreen customStyle={`${externalStyles}backdrop-filter: blur(4px);`} bind:openChatList bind:openModuleList/>
        </div>
    </div>
{:else if DBState.db.theme === 'waifuMobile'}
    <div class="isolate grow h-full relative" style={bgImg.length < 4 ? wallPaper : bgImg}>
        <SideBarArrow />
        <BackgroundDom />
        <div class="w-full absolute z-10 bottom-0 left-0"
            class:per33={view.characterIndex >= 0 && view.character?.viewScreen !== 'none'}
            class:h-full={!(view.characterIndex >= 0 && view.character?.viewScreen !== 'none')}
        >
            <DefaultChatScreen customStyle={`${externalStyles}backdrop-filter: blur(4px);`} bind:openChatList bind:openModuleList/>
        </div>
        {#if view.characterIndex >= 0}
            {#if view.character?.viewScreen !== 'none'}
                <div class="h-full w-full absolute bottom-0 left-0 max-w-full">
                    <TransitionImage classType="mobile" src={getEmotion(DBState.db, $CharEmotion, 'plain')}/>
                </div>
            {/if}
        {/if}
    </div>
{:else}
    <div class="isolate grow h-full min-w-0 relative justify-center flex">
        <SideBarArrow />
        <BackgroundDom />
        <div style={bgImg} class="h-full w-full" class:max-w-6xl={DBState.db.classicMaxWidth}>
            {#if view.characterIndex >= 0}
                {#if view.character?.viewScreen !== 'none' && (!view.character?.inlayViewScreen)}
                    <ResizeBox />
                {/if}
            {/if}
            <DefaultChatScreen customStyle={bgImg.length > 2 ? `${externalStyles}`: ''} bind:openChatList bind:openModuleList/>
        </div>
    </div>
{/if}
</section>
</div>
{#if openChatList}
    <ChatList close={() => {openChatList = false}}/>
{:else if openModuleList}
    <ModuleChatMenu close={() => {openModuleList = false}}/>
{/if}

<style>
    .halfw{
        max-width: calc(50% - 5rem);
    }
    .halfwp{
        max-width: calc(50% - 5rem);
    }
    .per33{
        height: 33.333333%;
    }

</style>
