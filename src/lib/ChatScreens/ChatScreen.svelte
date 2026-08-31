<script lang="ts">
    import { getCustomBackground, getEmotion } from "../../ts/util";
    
    import { DBState, MobileGUI } from 'src/ts/stores.svelte';
    import { CharEmotion, selectedCharID, openModuleListStore } from "../../ts/stores.svelte";
    import ResizeBox from './ResizeBox.svelte'
    import DefaultChatScreen from "./DefaultChatScreen.svelte";
    import defaultWallpaper from '../../etc/bg.jpg'
    import ChatList from "../Others/ChatList.svelte";
    import TransitionImage from "./TransitionImage.svelte";
    import BackgroundDom from "./BackgroundDom.svelte";
    import SideBarArrow from "../UI/GUI/SideBarArrow.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";
    import SecondaryChatPanel from './SecondaryChatPanel.svelte';
    import { clampSplitWidth, isEmbeddedRisuPane, splitChatOpen, splitChatWidth } from 'src/ts/chatSplitPane';
    import { onDestroy, onMount } from 'svelte';
    let openChatList = $state(false)
    let openModuleList = $state(false)
    let splitRoot: HTMLDivElement | null = $state(null)
    let stopSplitResize: (() => void) | null = null

    function beginSplitResize(event: PointerEvent) {
        if (!splitRoot) return
        event.preventDefault()
        const pointerId = event.pointerId
        const handle = event.currentTarget as HTMLElement
        handle.setPointerCapture?.(pointerId)

        const move = (moveEvent: PointerEvent) => {
            if (!splitRoot) return
            const rect = splitRoot.getBoundingClientRect()
            splitChatWidth.set(clampSplitWidth(rect.right - moveEvent.clientX, rect.width))
        }
        const stop = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', stop)
            window.removeEventListener('pointercancel', stop)
            stopSplitResize = null
        }
        stopSplitResize?.()
        stopSplitResize = stop
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
    }

    onDestroy(() => stopSplitResize?.())
    onMount(() => {
        const clampStoredWidth = () => {
            if (!splitRoot) return
            splitChatWidth.update((width) => clampSplitWidth(width, splitRoot?.clientWidth ?? window.innerWidth))
        }
        clampStoredWidth()
        window.addEventListener('resize', clampStoredWidth)
        return () => window.removeEventListener('resize', clampStoredWidth)
    })

    $effect(() => {
        if ($openModuleListStore) {
            openModuleList = true
            openModuleListStore.set(false)
        }
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

<!-- `isolate` keeps bot HTML/CSS z-index inside the chat layer; the outer
     wrapper additionally owns the optional second workspace. -->
<div class="grow h-full min-w-0 flex relative" bind:this={splitRoot}>
<section class="grow h-full min-w-0 relative">
{#if DBState.db.theme === 'waifu'}
    <div class="isolate grow h-full flex justify-center relative" style="{bgImg.length < 4 ? wallPaper : bgImg}">
        <SideBarArrow />
        <BackgroundDom />
        {#if $selectedCharID >= 0}
            {#if DBState.db.characters[$selectedCharID].viewScreen !== 'none'}
                <div class="h-full mr-10 flex justify-end halfw" style:width="{42 * (DBState.db.waifuWidth2 / 100)}rem">
                    <TransitionImage classType="waifu" src={getEmotion(DBState.db, $CharEmotion, 'plain')}/>
                </div>
            {/if}
        {/if}
        <div class="h-full w-2xl" style:width="{42 * (DBState.db.waifuWidth / 100)}rem" class:halfwp={$selectedCharID >= 0 && DBState.db.characters[$selectedCharID].viewScreen !== 'none'}>
            <DefaultChatScreen customStyle={`${externalStyles}backdrop-filter: blur(4px);`} bind:openChatList bind:openModuleList/>
        </div>
    </div>
{:else if DBState.db.theme === 'waifuMobile'}
    <div class="isolate grow h-full relative" style={bgImg.length < 4 ? wallPaper : bgImg}>
        <SideBarArrow />
        <BackgroundDom />
        <div class="w-full absolute z-10 bottom-0 left-0"
            class:per33={$selectedCharID >= 0 && DBState.db.characters[$selectedCharID].viewScreen !== 'none'}
            class:h-full={!($selectedCharID >= 0 && DBState.db.characters[$selectedCharID].viewScreen !== 'none')}
        >
            <DefaultChatScreen customStyle={`${externalStyles}backdrop-filter: blur(4px);`} bind:openChatList bind:openModuleList/>
        </div>
        {#if $selectedCharID >= 0}
            {#if DBState.db.characters[$selectedCharID].viewScreen !== 'none'}
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
            {#if $selectedCharID >= 0}
                {#if DBState.db.characters[$selectedCharID].viewScreen !== 'none' && (!(DBState.db.characters[$selectedCharID] as import('src/ts/storage/database.svelte').character).inlayViewScreen)}
                    <ResizeBox />
                {/if}
            {/if}
            <DefaultChatScreen customStyle={bgImg.length > 2 ? `${externalStyles}`: ''} bind:openChatList bind:openModuleList/>
        </div>
    </div>
{/if}
</section>
{#if $splitChatOpen && !$MobileGUI && !isEmbeddedRisuPane}
    <div
        class="split-chat-divider h-full w-1.5 shrink-0 cursor-col-resize bg-darkborderc transition-colors hover:bg-primary"
        role="separator"
        aria-label="Resize split chat"
        aria-orientation="vertical"
        onpointerdown={beginSplitResize}
    ></div>
    <div class="h-full min-w-0 shrink-0" style:width={`${$splitChatWidth}px`}>
        <SecondaryChatPanel />
    </div>
{/if}
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

    .split-chat-divider {
        touch-action: none;
    }
</style>
