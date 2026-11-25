<script lang="ts">
    import { onDestroy, onMount, tick, untrack } from "svelte";
    import { v4 } from "uuid";
    import { orderChatList, type ChatListItem } from "src/ts/chatListOrder";
    import { removeChatFolder } from "src/ts/chatFolderEdit";
    import Sortable from 'sortablejs/modular/sortable.core.esm.js';
    import { DownloadIcon, PencilIcon, HardDriveUploadIcon, MenuIcon, TrashIcon, SplitIcon, FolderPlusIcon, BookmarkCheckIcon, PackageIcon, CopyIcon, NotebookPenIcon, SearchIcon } from "@lucide/svelte";
    import ChatSearchPopup from './ChatSearchPopup.svelte';
    import Portal from '../UI/GUI/Portal.svelte';
    import type { SearchHit } from 'src/ts/gui/chatSearchSource';
    import { ScrollToMessageStore, MobileSideBar } from 'src/ts/stores.svelte';
    import MemoDialog from "./MemoDialog.svelte";
    import { chatTitleClass, chatTitleState, clearChatTitleManual, markChatTitleManual } from "src/ts/chatTitleState";
    import { retitleChatFromLastInput } from "src/ts/chatClone";

    import type { Chat, ChatFolder, character } from "src/ts/storage/database.svelte";
    import { newChatModelDefaults } from "src/ts/storage/database.svelte";
    import { ensureChatHydrated } from "src/ts/storage/chatStorage";
    import { DBState, ReloadGUIPointer } from 'src/ts/stores.svelte';
    import { selectedCharID, chatDeselected } from "src/ts/stores.svelte";
    import { getPaneView } from "src/ts/chatPanes.svelte";

    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import ChatReplyStatus from "./ChatReplyStatus.svelte";
    import ShButton from "../UI/GUI/ShButton.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";

    import { exportChat, importChat, exportAllChats } from "src/ts/characters";
    import { alertConfirm, alertError, alertSelect, alertStore, notifySuccess, notifyError, notifyInfo } from "src/ts/alert";
    import { get } from "svelte/store";
    import { chatGenKey, generationStates } from "src/ts/process/generationState";
    import { rerollPlaceholders } from "src/ts/gui/rerollPlaceholder";
    import { findRerollTargetIndex, hasUnseenSwipe } from "src/ts/chatSwipes";
    import { chatForCopyWhileAnswering, clearReplyInProgress, sendTurnOf } from "src/ts/chatCopySnapshot";
    import { findCharacterbyId, sleep, sortableOptions } from "src/ts/util";

    import { bookmarkListOpen, openModuleListStore } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import Toggles from "./Toggles.svelte";
    import PersonaBind from "./PersonaBind.svelte";
    import PromptBind from "./PromptBind.svelte";
    import ModelBind from "./ModelBind.svelte";
    import { changeChatTo, createChatCopyName, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { chatIndexAfterConfirm } from "src/ts/gui/afterConfirm";
    import { chatCopyNameFromLastInput, reissueMessageIds } from "src/ts/chatClone";
    import { copyFolderPersonaName, folderForChatCopy } from "src/ts/chatBranchFolder";
    import { copyChatDraft, seedChatDraft } from "src/ts/storage/chatDraft";
    import MemoryBind from "./MemoryBind.svelte";
    import { RISU_CHAT_ROOM_DRAG_TYPE } from "src/ts/dragTypes";
    import { serializeChatRoomDragPayload } from "src/ts/chatSplitPane";

    interface Props {
        chara: character;
    }

    let { chara = $bindable() }: Props = $props();

    // A copy taken while the chat is answering keeps the sent input as a
    // message and omits the pending reply (the user's 2026-11-10 change from
    // putting that input back in the box). Variables return to before the send
    // so a waiting-for-reply lock cannot persist in the copy. Before the input
    // is pushed, its text goes into the copy's box; rerolls restore the old reply.
    function copyableChat(chat: Chat): { chat: Chat, draft: { m: string, t: string } | null } {
        const snapshot = clearReplyInProgress($state.snapshot(chat) as Chat)
        const pending = get(generationStates).get(chatGenKey(chat.id))?.generationId
        const placeholder = get(rerollPlaceholders).get(chat.id)
        const turn = sendTurnOf(chat.id)
        if (!pending && !placeholder && !turn) return { chat: snapshot, draft: null }
        const input = chatForCopyWhileAnswering(snapshot, {
            pendingGenerationId: pending,
            placeholder: placeholder
                ? { index: placeholder.index, message: structuredClone($state.snapshot(placeholder.message)), trailing: placeholder.trailing ? structuredClone($state.snapshot(placeholder.trailing)) : undefined }
                : null,
            turn,
        })
        return { chat: snapshot, draft: input ? { m: input.input, t: input.translate } : null }
    }
    // Title colors: white automatic, green renamed, yellow renamed and answered
    // past since (chatTitleState.ts). Typing a name marks it renamed;
    // clearing it hands the title back to the last input.
    function titleTyped(chat: Chat) {
        markChatTitleManual(chara, chat.id)
    }
    // Enter ends the editing, as the pencil does, with the title saved (the
    // user's request, 2026-10-21). An Enter that ends an IME composition is not one.
    function finishTitleEdit(event: KeyboardEvent) {
        if (event.key !== 'Enter' || event.isComposing) return
        event.preventDefault()
        ;(event.currentTarget as HTMLInputElement).blur()
        editMode = false
    }
    // The newest reply has a page a reroll added that was not looked at yet.
    function newReplyUnseen(chat: Chat): boolean {
        const messages = chat.message ?? []
        return hasUnseenSwipe(messages[findRerollTargetIndex(messages)])
    }
    function titleCommitted(chat: Chat, value: string) {
        if (value.trim()) return
        clearChatTitleManual(chara, chat.id)
        const index = chara.chats.indexOf(chat)
        if (index >= 0 && !retitleChatFromLastInput(chara.chats, index) && !chara.chats[index].name.trim()) {
            chara.chats[index].name = 'New Chat'
        }
    }

    // The pane this list is drawn in (chatPanes.svelte.ts): its open chat is
    // the one highlighted, even while the other pane holds the selection.
    const view = getPaneView()
    const shownChatIndex = $derived(view.chatIndex)
    const deselectedHere = $derived(view.active && $chatDeselected)

    // Private bot/chat memos (MemoDialog); a dot on the button when any is written.
    let memoOpen = $state(false)
    const hasMemo = $derived(!!(chara?.nodeOnlyMemo?.trim() || chara?.chats?.[shownChatIndex]?.nodeOnlyMemo?.trim()))
    let editMode = $state(false)
    // CHAT-SEARCH (2026-11-22): open a search for this sidebar's bot.
    let searchOpen = $state(false)
    let searchBotId = chara.chaId
    async function openSearchHit(hit: SearchHit) {
        if (editMode || hit.botId !== chara.chaId) return
        const index = chara.chats.findIndex(chat => chat?.id === hit.chatId)
        if (index < 0) return
        changeChatTo(index)
        const loaded = await ensureChatHydrated(chara.chats, index, chara.chaId)
        if (!loaded || chara.chats[index]?._placeholder || chara.chatPage !== index) return
        const messages = chara.chats[index].message ?? []
        const found = hit.messageId ? messages.findIndex(message => message?.chatId === hit.messageId) : -1
        const target = found >= 0 ? found : hit.index
        if (target < 0 || target >= messages.length) return
        if ($MobileSideBar > 0) $MobileSideBar = 0
        await tick()
        ScrollToMessageStore.value = target
    }
    $effect(() => {
        if (chara.chaId === searchBotId) return
        searchOpen = false
        searchBotId = chara.chaId
    })

    // Safety net: chats whose folderId references a deleted folder would
    // otherwise be invisible (excluded from both the no-folder section and
    // any folder section). Render them in the no-folder section instead.
    // The server-side fix prevents new orphans; this guard rescues existing
    // ones until boot-time normalize touches the disk.
    const validFolderIds = $derived(
        new Set((chara.chatFolders ?? []).map(f => f.id).filter(Boolean))
    )
    const isOrphanFolder = (folderId: string | null | undefined): boolean =>
        folderId != null && !validFolderIds.has(folderId)

    // CHAT-LIST-RECENT (2026-11-22): streaming text is absent from the order key.
    const recentMode = $derived(DBState.db.nodeOnlyChatListRecent !== false)
    const orderInput = $derived(JSON.stringify({ bot: chara.chaId, chats: chara.chats.map(chat => [chat.id, chat.folderId, chat.lastDate]), folders: (chara.chatFolders ?? []).map(folder => [folder.id, folder.nodeOnlyParentFolderId]) }))
    const recentOrder = $derived.by(() => { orderInput; return untrack(() => orderChatList(chara.chats, chara.chatFolders ?? [])) })
    const folderItemsFor = (index: number): ChatListItem[] => recentMode ? recentOrder.folderItems[index]
        : [...recentOrder.folderItems[index].filter(item => item.kind === 'folder').sort((a, b) => a.index - b.index),
            ...chara.chats.flatMap((chat, i): ChatListItem[] => chat.folderId === chara.chatFolders[index].id ? [{ kind: 'chat', index: i }] : [])]
    let chatsStb: Sortable[] = []
    let folderStb: Sortable = null

    let folderEles: HTMLDivElement = $state()
    let listEle: HTMLDivElement = $state()
    let sorted = $state(0)
    let opened = 0
    // CHAT-LIST-RESIZE (2026-11-25): save a device-local list maximum.
    const heightKey = 'pocketrisu:chat-list-max-height'
    const clampHeight = (height: number) => Math.max(160, Math.min(height, Math.max(160, window.innerHeight - 120)))
    let listHeight = $state(320)
    let resizeStart: { pointerId: number; y: number; height: number; moved: boolean } | null = null
    let lastGripTap = 0
    function saveListHeight(height: number) {
        listHeight = clampHeight(height)
        try { localStorage.setItem(heightKey, String(listHeight)) } catch {}
    }
    function gripDown(event: PointerEvent) {
        event.stopPropagation()
        event.preventDefault()
        const now = Date.now()
        if (now - lastGripTap < 350) {
            lastGripTap = 0
            saveListHeight(320)
            return
        }
        resizeStart = { pointerId: event.pointerId, y: event.clientY, height: listHeight, moved: false }
        event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId)
    }
    function gripMove(event: PointerEvent) {
        if (!resizeStart || resizeStart.pointerId !== event.pointerId) return
        const delta = event.clientY - resizeStart.y
        if (Math.abs(delta) > 3) resizeStart.moved = true
        listHeight = clampHeight(resizeStart.height + delta)
    }
    function gripUp(event: PointerEvent) {
        if (!resizeStart || resizeStart.pointerId !== event.pointerId) return
        if (!resizeStart.moved) lastGripTap = Date.now()
        else { lastGripTap = 0; saveListHeight(listHeight) }
        resizeStart = null
    }

    function beginChatRoomDrag(event: DragEvent, chat: Chat) {
        if (editMode || !event.dataTransfer || !chara.chaId || !chat.id) {
            event.preventDefault()
            return
        }
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData(RISU_CHAT_ROOM_DRAG_TYPE, serializeChatRoomDragPayload({
            characterId: chara.chaId,
            chatId: chat.id,
        }))
        event.dataTransfer.setData('text/plain', `${chara.name ?? ''} / ${chat.name ?? ''}`)
    }

    const createStb = () => {
        if (recentMode) {
            // The list itself is the top-level drop target (querySelectorAll skips it).
            for (const container of [listEle, ...listEle.querySelectorAll<HTMLElement>('.risu-chat')]) {
                chatsStb.push(new Sortable(container, {
                    group: 'chats', draggable: '>[data-risu-chat-idx]', filter: '.no-sort',
                    onAdd: event => {
                        const index = Number((event.item as HTMLElement).dataset.risuChatIdx)
                        const folder = (event.to as HTMLElement).closest<HTMLElement>('[data-risu-chat-folder-idx]')
                        const folderIndex = folder ? Number(folder.dataset.risuChatFolderIdx) : -1
                        const next = folderIndex >= 0 ? chara.chatFolders[folderIndex]?.id ?? null : null
                        event.item.remove()
                        if (Number.isInteger(index) && chara.chats[index]) { chara.chats[index].folderId = next; void requestImmediateSave() }
                        sorted += 1
                        void tick().then(() => recreateStb())
                    },
                    onEnd: event => {
                        if (event.from !== event.to) return // onAdd restores cross-container moves.
                        sorted += 1
                        void tick().then(() => recreateStb())
                    },
                    ...sortableOptions, sort: false,
                }))
            }
            return
        }
        for (let chat of listEle.querySelectorAll('.risu-chat')) {
            chatsStb.push(new Sortable(chat, {
                group: 'chats',
                draggable: '>[data-risu-chat-idx]',
                onEnd: async (event) => {
                    const currentChatPage = chara.chatPage
                    const newChats: Chat[] = []

                    // const chats: HTMLElement = event.to
                    // chats.querySelectorAll()
                    
                    listEle.querySelectorAll('[data-risu-chat-folder-idx]').forEach(folder => {
                        const folderIdx = parseInt(folder.getAttribute('data-risu-chat-folder-idx'))
                        folder.querySelectorAll('[data-risu-chat-idx]').forEach(chatInFolder => {
                            if (chatInFolder.closest('[data-risu-chat-folder-idx]') !== folder) return
                            const chatIdx = parseInt(chatInFolder.getAttribute('data-risu-chat-idx'))
                            const newChat = chara.chats[chatIdx]
                            newChat.folderId = chara.chatFolders[folderIdx].id
                            newChats.push(newChat)
                        })
                    })

                    listEle.querySelectorAll('[data-risu-chat-idx]').forEach(chatEle => {
                        const idx = parseInt(chatEle.getAttribute('data-risu-chat-idx'))
                        const newChat = chara.chats[idx]
                        if (newChats.includes(newChat) == false) {
                            if (newChat.folderId != null)
                                newChat.folderId = null
                            newChats.push(newChat)
                        }
                    })

                    changeChatTo(newChats.indexOf(chara.chats[currentChatPage]))
                    chara.chats = newChats

                    try {
                        this.destroy()
                    } catch (e) {}
                    sorted += 1
                    await sleep(1)
                    createStb()
                },
                ...sortableOptions
            }))
        }
        folderStb = Sortable.create(folderEles, {
            group: 'folders',
            onEnd: async (event) => {
                const newFolders: ChatFolder[] = []
                const newChats: Chat[] = []
                const folders: HTMLElement[] = Array.from<HTMLElement>(event.to.children)

                const currentChatPage = chara.chatPage

                folders.forEach(folder => {
                    const folderIdx = parseInt(folder.getAttribute('data-risu-chat-folder-idx'))
                    newFolders.push(chara.chatFolders[folderIdx])

                    folder.querySelectorAll('[data-risu-chat-idx]').forEach(chatEle => {
                        if (chatEle.closest('[data-risu-chat-folder-idx]') !== folder) return
                        const idx = parseInt(chatEle.getAttribute('data-risu-chat-idx'))
                        newChats.push(chara.chats[idx])
                    })
                })

                listEle.querySelectorAll('[data-risu-chat-idx]').forEach(chatEle => {
                    const idx = parseInt(chatEle.getAttribute('data-risu-chat-idx'))
                    if (newChats.includes(chara.chats[idx]) == false) {
                        newChats.push(chara.chats[idx])
                    }
                })
                
                chara.chatFolders = [...newFolders, ...chara.chatFolders.filter(folder => !newFolders.includes(folder))]
                changeChatTo(newChats.indexOf(chara.chats[currentChatPage]))
                chara.chats = newChats
                try {
                    folderStb.destroy()
                } catch (e) {}
                sorted += 1
                await sleep(1)
                createStb()
            },
            draggable: '>[data-risu-chat-folder-idx]',
            ...sortableOptions
        })
    }

    function recreateStb() {
        for (const stb of chatsStb) { try { stb.destroy() } catch {} }
        chatsStb = []
        if (folderStb) { try { folderStb.destroy() } catch {} }
        folderStb = null
        if (listEle) createStb()
    }
    $effect(() => {
        if (recentMode) orderInput
        void tick().then(() => { if (listEle) recreateStb() })
    })
    onMount(() => {
        listHeight = clampHeight(320)
        try {
            const stored = Number(localStorage.getItem(heightKey))
            if (Number.isFinite(stored) && stored > 0) listHeight = clampHeight(stored)
        } catch {}
    })

    onDestroy(() => {
        if (folderStb) {
            try {
                folderStb.destroy()
            } catch (error) {}
        }
        chatsStb.map(stb => {
            try {
                stb.destroy()
            } catch (error) {}
        })
    })
</script>
<div class="flex flex-col w-full">
    <ShButton className="relative bottom-2 w-full" onclick={() => {
        const len = chara.chats.length
        let chats = chara.chats
        const newChat = {
            // CHAT-LIST-RECENT (2026-11-22): creation time is catalog recency.
            message:[] as any[], note:'', name:`New Chat ${len + 1}`, localLore:[] as any[], fmIndex: -1, id: v4(), lastDate: Date.now(),
            ...newChatModelDefaults()
        }
        chats.unshift(newChat)
        chara.chats = chats
        changeChatTo(0)
        void requestImmediateSave()
        $ReloadGUIPointer += 1
    }}>{language.newChat}</ShButton>

    {#snippet folderRow(folder: ChatFolder, i: number)}
            <div data-risu-chat-folder-idx={i}
                class="flex flex-col min-w-0 mb-2 border border-darkborderc bg-selected/30 cursor-pointer rounded-md">
                <!-- folder header -->
                <button
                    onclick={() => {
                        if(!editMode) {
                            chara.chatFolders[i].folded = !folder.folded
                            $ReloadGUIPointer += 1
                        }
                    }}
                    class="flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
                    class:bg-red-900={folder.color === 'red'}
                    class:bg-yellow-900={folder.color === 'yellow'}
                    class:bg-green-900={folder.color === 'green'}
                    class:bg-blue-900={folder.color === 'blue'}
                    class:bg-indigo-900={folder.color === 'indigo'}
                    class:bg-purple-900={folder.color === 'purple'}
                    class:bg-pink-900={folder.color === 'pink'}
                >
                    {#if editMode}
                        <TextInput bind:value={chara.chatFolders[i].name} className="grow min-w-0" padding={false} onkeydown={finishTitleEdit}/>
                    {:else}
                        <span>{folder.name}</span>
                    {/if}
                    <div class="grow flex justify-end">
                        <div role="button" tabindex="0" onkeydown={(e) => {
                            if(e.key === 'Enter'){
                                e.currentTarget.click()
                            }
                        }} class="text-textcolor2 hover:text-primary mr-1 cursor-pointer" onclick={async (e) => {
                            e.stopPropagation()
                            const target = folder
                            const sel = parseInt(await alertSelect([language.changeFolderColor, language.cancel]))
                            switch (sel) {
                                case 0:
                                    const colors = ["red","green","blue","yellow","indigo","purple","pink","default"]
                                    const sel = parseInt(await alertSelect(colors))
                                    if (Number.isInteger(sel) && sel >= 0 && sel < colors.length) target.color = colors[sel]
                                    break
                            }
                        }}>
                            <MenuIcon size={18}/>
                        </div>
                        <div role="button" tabindex="0" onkeydown={(e) => {
                            if(e.key === 'Enter'){
                                e.currentTarget.click()
                            }
                        }} class="text-textcolor2 hover:text-primary mr-1 cursor-pointer" onclick={() => {
                            editMode = !editMode
                        }}>
                            <PencilIcon size={18}/>
                        </div>
                        <div role="button" tabindex="0" onkeydown={(e) => {
                            if(e.key === 'Enter'){
                                e.currentTarget.click()
                            }
                        }} class="text-textcolor2 hover:text-red-400 cursor-pointer" onclick={async (e) => {
                            e.stopPropagation()
                            // CHAT-FOLDER-DELETE-BY-ID (2026-11-25): the snippet's folder is a getter; it moves after the splice.
                            const target = folder
                            const d = await alertConfirm(`${language.removeConfirm}${target.name}`)
                            if (d && removeChatFolder(chara.chatFolders, chara.chats, target)) {
                                $ReloadGUIPointer += 1
                                void requestImmediateSave()
                            }
                        }}>
                            <TrashIcon size={18}/>
                        </div>
                    </div>
                </button>
                <!-- CHAT-FOLDER-NESTING (2026-11-25): each point folder displays its child folders and own chats. -->
                <div class="risu-chat flex flex-col w-full text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md {folder.folded ? 'hidden' : ''}">
                    {#if folderItemsFor(i).length == 0}
                    <span class="no-sort flex justify-center text-textcolor2">Empty</span>
                    <div></div>
                    {:else}
                    {#each folderItemsFor(i) as item (item.kind + ':' + item.index)}
                    {#if item.kind === 'folder'}
                        <div class="ml-2 min-w-0 border-l border-darkborderc pl-1">{@render folderRow(chara.chatFolders[item.index], item.index)}</div>
                    {:else}
                    {@const chatIdx = item.index}
                    {@const chat = chara.chats[chatIdx]}
                    <button data-risu-chat-idx={chatIdx} draggable={!editMode} ondragstart={(event) => beginChatRoomDrag(event, chat)} onclick={() => {
                        if(!editMode){
                            changeChatTo(chatIdx)
                        }
                    }} class="risu-chats flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"class:bg-selected={chatIdx === shownChatIndex && !deselectedHere}>
                        {#if editMode}
                            <TextInput deferred bind:value={chat.name} className="grow min-w-0" padding={false} oninput={() => titleTyped(chat)} onchange={(e) => titleCommitted(chat, e.currentTarget.value)} onkeydown={finishTitleEdit}/>
                        {:else}
                            <span class={chatTitleClass(chatTitleState(chara, chat.id))}>{chat.name}</span>
                        {/if}
                        <div class="grow flex justify-end items-center">
                            <ChatReplyStatus chatId={chat.id} current={chatIdx === shownChatIndex && !deselectedHere} unseen={chatIdx === shownChatIndex && newReplyUnseen(chat)} />
                            <div role="button" tabindex="0" onkeydown={(e) => {
                                if(e.key === 'Enter'){
                                    e.currentTarget.click()
                                }
                            }} class="text-textcolor2 hover:text-primary mr-1 cursor-pointer" onclick={async (e) => {
                                e.stopPropagation()
                                const owner = chara
                                const target = chat
                                const confirmed = await alertConfirm(`${language.copyChatConfirm}${target.name}`)
                                if(!confirmed || owner !== chara) return
                                // The row's `chat` is read again by position after the question.
                                const chatIdx = chatIndexAfterConfirm(chara.chats, target)
                                if(chatIdx < 0) return
                                if(chara.chats[chatIdx]?._placeholder){
                                    await ensureChatHydrated(chara.chats, chatIdx, (chara as character).chaId)
                                }
                                if(owner !== chara) return
                                const hydratedIdx = chatIndexAfterConfirm(chara.chats, target)
                                if(hydratedIdx < 0) return
                                if(chara.chats[hydratedIdx]?._placeholder){
                                    alertError('Failed to load chat data.')
                                    return
                                }
                                const copied = copyableChat(chara.chats[hydratedIdx])
                                const newChat = reissueMessageIds(copied.chat, chara.chats[hydratedIdx].message.map(m => m.chatId))
                                newChat.name = chatCopyNameFromLastInput(newChat.message, chara.chats.map((c) => c.name))
                                    ?? createChatCopyName(newChat.name, 'Copy')
                                newChat.id = v4()
                                newChat.lastDate = Date.now()
                                newChat.folderId = folderForChatCopy(chara, chara.chats[hydratedIdx], newChat.message.length, DBState.db.createFolderOnBranch, v4, copyFolderPersonaName(DBState.db, chara.chats[hydratedIdx]))
                                // The unsent text in the input goes along (the user's request, 2026-10-10);
                                // before a send pushes its input, that input goes too.
                                if (copied.draft) seedChatDraft((chara as character).chaId, newChat.id, copied.draft)
                                else copyChatDraft((chara as character).chaId, chara.chats[hydratedIdx].id, newChat.id)
                                // Right under the chat it copies, not at the top (the user's request, 2026-10-19).
                                chara.chats.splice(hydratedIdx + 1, 0, newChat)
                                changeChatTo(hydratedIdx + 1)
                                chara.chats = chara.chats
                                void requestImmediateSave()
                                notifySuccess(language.copyChatSuccess)
                            }}>
                                <CopyIcon size={18}/>
                            </div>
                            <div role="button" tabindex="0" onkeydown={(e) => {
                                if(e.key === 'Enter'){
                                    e.currentTarget.click()
                                }
                            }} class="text-textcolor2 hover:text-primary mr-1 cursor-pointer" onclick={() => {
                                editMode = !editMode
                            }}>
                                <PencilIcon size={18}/>
                            </div>
                            <div role="button" tabindex="0" onkeydown={(e) => {
                                if(e.key === 'Enter'){
                                    e.currentTarget.click()
                                }
                            }} class="text-textcolor2 hover:text-primary mr-1 cursor-pointer" onclick={async (e) => {
                                e.stopPropagation()
                                exportChat(chara.chats.indexOf(chat))
                            }}>
                                <DownloadIcon size={18}/>
                            </div>
                            <div role="button" tabindex="0" onkeydown={(e) => {
                                if(e.key === 'Enter'){
                                    e.currentTarget.click()
                                }
                            }} class="text-textcolor2 hover:text-red-400 cursor-pointer" onclick={async (e) => {
                                e.stopPropagation()
                                if(chara.chats.length === 1){
                                    notifyError(language.errors.onlyOneChat)
                                    return
                                }
                                const owner = chara
                                const target = chat
                                const d = await alertConfirm(`${language.removeConfirm}${target.name}`)
                                // The list (or the pane's bot) can change while the question is open.
                                const at = d && owner === chara ? chatIndexAfterConfirm(owner.chats, target) : -1
                                if(at >= 0 && owner.chats.length > 1){
                                    changeChatTo(0)
                                    $ReloadGUIPointer += 1
                                    let chats = owner.chats
                                    chats.splice(at, 1)
                                    owner.chats = chats
                                    void requestImmediateSave()
                                }
                            }}>
                                <TrashIcon size={18}/>
                            </div>
                        </div>
                    </button>
                    {/if}
                    {/each}
                    {/if}
                </div>
            </div>
    {/snippet}
    {#snippet looseRow(chat: Chat, i: number)}
            <button data-risu-chat-idx={i} draggable={!editMode} ondragstart={(event) => beginChatRoomDrag(event, chat)} onclick={() => {
                if(!editMode){
                    changeChatTo(i)
                }
            }}
            class="flex items-center text-textcolor border-solid border-0 border-darkborderc p-2 cursor-pointer rounded-md"
            class:bg-selected={i === shownChatIndex && !deselectedHere}>
                {#if editMode}
                    <TextInput deferred bind:value={chara.chats[i].name} className="grow min-w-0" padding={false} oninput={() => titleTyped(chat)} onchange={(e) => titleCommitted(chat, e.currentTarget.value)} onkeydown={finishTitleEdit}/>
                {:else}
                    <span class={chatTitleClass(chatTitleState(chara, chat.id))}>{chat.name}</span>
                {/if}
                <div class="grow flex justify-end items-center">
                    <ChatReplyStatus chatId={chat.id} current={i === shownChatIndex && !deselectedHere} unseen={i === shownChatIndex && newReplyUnseen(chat)} />
                    <div role="button" tabindex="0" onkeydown={(e) => {
                        if(e.key === 'Enter'){
                            e.currentTarget.click()
                        }
                    }} class="text-textcolor2 hover:text-primary mr-1 cursor-pointer" onclick={async (e) => {
                        e.stopPropagation()
                        const owner = chara
                        const target = chat
                        const confirmed = await alertConfirm(`${language.copyChatConfirm}${target.name}`)
                        if(!confirmed || owner !== chara) return
                        // The list may have changed while waiting (the row's `chat` is read again by position).
                        const i = chatIndexAfterConfirm(chara.chats, target)
                        if(i < 0) return
                        if(chara.chats[i]?._placeholder){
                            await ensureChatHydrated(chara.chats, i, (chara as character).chaId)
                        }
                        if(owner !== chara) return
                        const hydratedIdx = chatIndexAfterConfirm(chara.chats, target)
                        if(hydratedIdx < 0) return
                        if(chara.chats[hydratedIdx]?._placeholder){
                            alertError('Failed to load chat data.')
                            return
                        }
                        const copied = copyableChat(chara.chats[hydratedIdx])
                        const newChat = reissueMessageIds(copied.chat, chara.chats[hydratedIdx].message.map(m => m.chatId))
                        newChat.name = chatCopyNameFromLastInput(newChat.message, chara.chats.map((c) => c.name))
                            ?? createChatCopyName(newChat.name, 'Copy')
                        newChat.id = v4()
                                newChat.lastDate = Date.now()
                        newChat.folderId = folderForChatCopy(chara, chara.chats[hydratedIdx], newChat.message.length, DBState.db.createFolderOnBranch, v4, copyFolderPersonaName(DBState.db, chara.chats[hydratedIdx]))
                        // The unsent text in the input goes along (the user's request, 2026-10-10);
                        // before a send pushes its input, that input goes too.
                        if (copied.draft) seedChatDraft((chara as character).chaId, newChat.id, copied.draft)
                        else copyChatDraft((chara as character).chaId, chara.chats[hydratedIdx].id, newChat.id)
                        // Right under the chat it copies, not at the top (the user's request, 2026-10-19).
                        chara.chats.splice(hydratedIdx + 1, 0, newChat)
                        changeChatTo(hydratedIdx + 1)
                        chara.chats = chara.chats
                        void requestImmediateSave()
                        notifySuccess(language.copyChatSuccess)
                    }}>
                        <CopyIcon size={18}/>
                    </div>
                    <div role="button" tabindex="0" onkeydown={(e) => {
                        if(e.key === 'Enter'){
                            e.currentTarget.click()
                        }
                    }} class="text-textcolor2 hover:text-primary mr-1 cursor-pointer" onclick={() => {
                        editMode = !editMode
                    }}>
                        <PencilIcon size={18}/>
                    </div>
                    <div role="button" tabindex="0" onkeydown={(e) => {
                        if(e.key === 'Enter'){
                            e.currentTarget.click()
                        }
                    }} class="text-textcolor2 hover:text-primary mr-1 cursor-pointer" onclick={async (e) => {
                        e.stopPropagation()
                        exportChat(i)
                    }}>
                        <DownloadIcon size={18}/>
                    </div>
                    <div role="button" tabindex="0" onkeydown={(e) => {
                        if(e.key === 'Enter'){
                            e.currentTarget.click()
                        }
                    }} class="text-textcolor2 hover:text-red-400 cursor-pointer" onclick={async (e) => {
                        e.stopPropagation()
                        if(chara.chats.length === 1){
                            notifyError(language.errors.onlyOneChat)
                            return
                        }
                        const owner = chara
                        const target = chat
                        const d = await alertConfirm(`${language.removeConfirm}${target.name}`)
                        // The list (or the pane's bot) can change while the question is open.
                        const at = d && owner === chara ? chatIndexAfterConfirm(owner.chats, target) : -1
                        if(at >= 0 && owner.chats.length > 1){
                            changeChatTo(0)
                            $ReloadGUIPointer += 1
                            let chats = owner.chats
                            chats.splice(at, 1)
                            owner.chats = chats
                            void requestImmediateSave()
                        }
                    }}>
                        <TrashIcon size={18}/>
                    </div>
                </div>
            </button>
    {/snippet}
    <!-- CHAT-LIST-RECENT (2026-11-22): mixed display order. -->
    {#if recentMode}
    {#key sorted}
    <!-- pb-6: room under the last item to drop a chat out of its folder when no chat is loose. -->
    <div class="risu-chat flex flex-col mt-2 pb-6 overflow-y-auto" style:max-height="{listHeight}px" bind:this={listEle}>
        {#each recentOrder.items as item (item.kind + ':' + item.index)}
            {#if item.kind === 'folder'}
                {@render folderRow(chara.chatFolders[item.index], item.index)}
            {:else}
                {@render looseRow(chara.chats[item.index], item.index)}
            {/if}
        {/each}
    </div>
    {/key}
    {:else}
    {#key sorted}
    <div class="flex flex-col mt-2 overflow-y-auto" style:max-height="{listHeight}px" bind:this={listEle}>
        <!-- folder div -->
        <div class="flex flex-col" bind:this={folderEles}>
            <!-- chat folder -->
            {#each chara.chatFolders as folder, i}
                {#if recentOrder.folderParents[i] === null}{@render folderRow(folder, i)}{/if}
            {/each}
        </div>
        <!-- chat without folder div -->
        <div class="risu-chat flex flex-col">
            {#each chara.chats as chat, i}
            {#if chat.folderId == null || isOrphanFolder(chat.folderId)}
                {@render looseRow(chat, i)}
            {/if}
            {/each}
        </div>
    </div>
    {/key}
    {/if}
    <div class="flex justify-end pr-1">
        <button type="button" class="h-5 w-6 cursor-nwse-resize text-textcolor2 touch-none select-none"
            aria-label="Resize chat list" title="Resize chat list"
            onpointerdown={gripDown} onpointermove={gripMove} onpointerup={gripUp} onpointercancel={gripUp}
            ondragstart={(event) => event.preventDefault()}>
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M18 5 5 18M18 10l-8 8M18 15l-3 3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
    </div>
    {#if searchOpen}
        <Portal><ChatSearchPopup chara={chara} close={() => { searchOpen = false }} open={openSearchHit} /></Portal>
    {/if}

    <div class="border-t border-selected mt-2">
        <div class="flex mt-2 ml-2 items-center">
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                exportAllChats()
            }}>
                <DownloadIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                importChat()
            }}>
                <HardDriveUploadIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                editMode = !editMode
            }}>
                <PencilIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" title={language.branchGraphTitle} aria-label={language.branchGraphTitle} onclick={() => {
                alertStore.set({
                  type: "branches",
                  msg: ""
                })
            }}>
                <SplitIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                $bookmarkListOpen = true;
            }}>
                <BookmarkCheckIcon size={18}/>
            </button>
            <button class="relative text-textcolor2 hover:text-primary mr-2 cursor-pointer" title={language.memoTitle} aria-label={language.memoTitle} onclick={() => { memoOpen = true }}>
                <NotebookPenIcon size={18}/>
                {#if hasMemo}<span class="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary" aria-hidden="true"></span>{/if}
            </button>
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" title={language.search} aria-label={language.search} onclick={() => { searchOpen = true }}>
                <SearchIcon size={18}/>
            </button>
            <button class="shrink-0 ml-auto text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                if (!chara.chatFolders) {
                    chara.chatFolders = []
                }
                const folders = chara.chatFolders
                const length = chara.chatFolders.length
                folders.unshift({
                    id: v4(),
                    name: `New Folder ${length + 1}`,
                    folded: false,
                })
                chara.chatFolders = folders
                $ReloadGUIPointer += 1
            }}>
                <FolderPlusIcon size={18}/>
            </button>
        </div>

        {#if view.character?.chaId !== '§playground' && !deselectedHere}
            {#if DBState.db.showModelInSidebar}
                <ModelBind />
            {/if}
            {#if DBState.db.showPresetInSidebar}
                <PromptBind />
            {/if}
            {#if DBState.db.showPersonaInSidebar}
                <PersonaBind />
            {/if}
            <MemoryBind />
            <Toggles bind:chara={chara} noContainer />
            <ShButton className="w-full mt-2" onclick={() => {
                const char = DBState.db.characters[$selectedCharID]
                if (!char) return
                char.chats[char.chatPage].modules ??= []
                openModuleListStore.set(true)
            }}>
                <PackageIcon size={16} class="shrink-0" />
                <span class="truncate">{language.modules}</span>
            </ShButton>
        {/if}
    </div>
</div>
{#if memoOpen}
    <MemoDialog bind:chara close={() => { memoOpen = false }} />
{/if}
