<script lang="ts">
    import type { character, Message, StreamingDisplayOptimizationMode } from 'src/ts/storage/database.svelte';
    import { mount, onDestroy, tick, unmount } from 'svelte';
    import Chat from './Chat.svelte';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, DBState, ReloadChatPointer } from 'src/ts/stores.svelte';
    import { chatFoldedStateMessageIndex } from 'src/ts/globalApi.svelte';
    import { get } from 'svelte/store';
    import { scrollWithinContainer } from './scrollWithin';
    import { getChatAssetRenderWindow } from '../../ts/chatAssetWindow';
    import { captureChatViewportAnchor, getChatRoomIdentity, restoreChatViewportAnchor, type ChatViewportAnchor } from './chatViewportAnchor';
    
    const getCurrentChatRoomId = () => getChatRoomIdentity(currentCharacter);

    let {
        messages,
        currentCharacter,
        onReroll,
        onNextSwipe = () => {},
        unReroll,
        onDeleteSwipe = () => {},
        currentUsername,
        userIcon,
        loadPages,
        userIconPortrait,
        hasNewUnreadMessage = $bindable(false)
    }:{
        messages: Message[]
        currentCharacter: character
        onReroll: () => void
        onNextSwipe?: () => void
        unReroll: () => void
        onDeleteSwipe?: () => void
        currentUsername: string
        userIcon: string
        loadPages: number
        userIconPortrait?: boolean
        hasNewUnreadMessage?: boolean
    } = $props();

    let chatBody: HTMLDivElement;
    let hashes: Set<number> = new Set();
    type ChatInstance = {
        updateStreamingDisplay?: (state: {
            isOptimizedStreamingMessage: boolean
            streamingOptimizationMode: StreamingDisplayOptimizationMode
            rawStreamingText: string
        }) => void
    }
    let mountInstances: Map<number, ChatInstance> = new Map();

    //Non-cryptographic hash function to generate a unique hash for each message
    function hashCode(str:string):number {
        let hash = 0;
        for (let i = 0, len = str.length; i < len; i++) {
            let chr = str.charCodeAt(i);
            hash = (hash << 5) - hash + chr;
            hash |= 0; // Convert to 32bit integer
        }
        if(hash == 0){
            hash = 1; // Ensure hash is not zero
        }
        return hash;
    }

    const updateChatBody = () => {
        if(!chatBody){
            return
        }

        let nextHash = 0;
        let currentHashes: Set<number> = new Set();
        let charImage: ReturnType<typeof getCharImage> | undefined
        let userImage: ReturnType<typeof getCharImage> | undefined
        const getSenderImage = (role: string) => {
            if(role === 'user'){
                userImage ??= getCharImage(userIcon, 'css')
                return userImage
            }
            charImage ??= getCharImage(currentCharacter.image, 'css')
            return charImage
        }
        const simpleChar = createSimpleCharacter(currentCharacter);
        let loadStart = messages.length - 1
        let loadEnd = messages.length - loadPages
        const currentChat = currentCharacter.chats?.[currentCharacter.chatPage]
        const configuredPerformanceMode = DBState.db.streamingDisplayOptimizationMode ?? 'off';
        const performanceMode = currentChat?.isStreaming
            ? currentChat.activeStreamingDisplayOptimizationMode ?? configuredPerformanceMode
            : configuredPerformanceMode
        const activeStreamingIndex = performanceMode !== 'off' && currentChat?.isStreaming
            ? messages.length - 1
            : -1
        const assetRenderWindow = getChatAssetRenderWindow(
            messages,
            DBState.db.externalAssetRecentOutputs,
            currentChat?.firstMessageDisabled !== true,
        )

        // Find the last real (non-comment, non-disabled) char message index
        // Only show reroll if it's the actual last non-disabled message
        let lastRealCharIdx = -1;
        let lastNonDisabledIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (!messages[i].isComment && !messages[i].disabled) {
                lastNonDisabledIdx = i;
                break;
            }
        }
        if (lastNonDisabledIdx >= 0 && messages[lastNonDisabledIdx].role === 'char') {
            lastRealCharIdx = lastNonDisabledIdx;
        }

        if(chatFoldedStateMessageIndex.index !== -1){
            loadStart = chatFoldedStateMessageIndex.index
            loadEnd = Math.max(0, chatFoldedStateMessageIndex.index - loadPages)
        }

        const reloadPointerMap = get(ReloadChatPointer);

        for(let i=loadStart ; i >= loadEnd; i--){
            if(i < 0) break; // Prevent out of bounds
            const message = messages[i];
            const messageLargePortrait = message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false);
            const reloadPointer = reloadPointerMap[i] ?? 0;
            const isRerollTarget = i === lastRealCharIdx;
            const activeStreamingMessage = i === activeStreamingIndex && message.role === 'char';
            const resolveChatAssets = assetRenderWindow.messageIndices.has(i)
            const hashMessageData = activeStreamingMessage ? '' : message.data;
            let hashd = hashMessageData + (message.chatId ?? '') + i.toString() + messageLargePortrait.toString() + message.disabled?.toString() + reloadPointer.toString() + (message.swipeId ?? 0).toString() + (message.swipes?.length ?? 0).toString() + isRerollTarget.toString() + resolveChatAssets.toString();
            const currentHash = hashCode(hashd);
            currentHashes.add(currentHash);
            if(!hashes.has(currentHash)){
                const b = document.createElement('div');
                b.setAttribute('x-hashed', currentHash.toString());
                b.classList.add('chat-message-container');
                const swipes = message.swipes;
                const swipeId = message.swipeId ?? 0;
                const inst = mount(Chat, {
                    target: b,
                    props: {
                        message: message.data,
                        isLastMemory: false,
                        idx: i,
                        totalLength: messages.length,
                        img: resolveChatAssets ? getSenderImage(message.role) : '',
                        loadSenderImage: () => getSenderImage(message.role),
                        onReroll: onReroll,
                        onNextSwipe: i === lastRealCharIdx ? onNextSwipe : () => {},
                        unReroll: unReroll,
                        onDeleteSwipe: i === lastRealCharIdx ? onDeleteSwipe : () => {},
                        rerollIcon: i === lastRealCharIdx ? 'force' : false,
                        character: simpleChar,
                        largePortrait: message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false),
                        messageGenerationInfo: message.generationInfo,
                        role: message.role,
                        name: message.role === 'user' ? currentUsername : currentCharacter.name,
                        isComment: message.isComment ?? false,
                        disabled: message.disabled ?? false,
                        isOptimizedStreamingMessage: activeStreamingMessage,
                        streamingOptimizationMode: performanceMode,
                        rawStreamingText: message.data,
                        resolveChatAssets,
                        resolveSenderIcon: resolveChatAssets,
                        ...(i === lastRealCharIdx ? {
                            currentPage: (swipeId ?? 0) + 1,
                            totalPages: swipes?.length ?? 1,
                        } : {}),
                    },

                })
                mountInstances.set(currentHash, inst);
                const nextElement = nextHash === 0 ? null : chatBody.querySelector(`[x-hashed="${nextHash}"]`);
                if(nextElement){
                    chatBody.insertBefore(b, nextElement?.nextSibling);
                }
                else{
                    chatBody.prepend(b);
                }
            }
            else{
                mountInstances.get(currentHash)?.updateStreamingDisplay?.({
                    isOptimizedStreamingMessage: activeStreamingMessage,
                    streamingOptimizationMode: performanceMode,
                    rawStreamingText: message.data,
                })
            }
            nextHash = currentHash;

        }

        //@ts-expect-error Set<T> requires type arg, and Set.difference needs 'esnext' lib (polyfilled by Core-js)
        const toRemove:Set = hashes.difference(currentHashes);
        toRemove.forEach((hash) => {
            const inst = mountInstances.get(hash);
            if(inst){
                unmount(inst);
                mountInstances.delete(hash);
            }
            const element = chatBody.querySelector(`[x-hashed="${hash}"]`);
            if(element){
                chatBody.removeChild(element);
            }
        });

        hashes = currentHashes;
    };

    onDestroy(() => {
        console.log('Unmounting Chats');
        hashes.clear();
        mountInstances.forEach((inst) => {
            unmount(inst);
        });
        mountInstances.clear();
    })

    function checkIfAtBottom() {
        if (!chatBody || !chatBody.parentElement) return true;
        const sc = chatBody.parentElement;
        // The outer scroller is flex-col-reverse: 0 is the live tail and
        // scrolling into history makes scrollTop negative. Testing the newest
        // message's TOP falsely treats the beginning of a long reply as bottom.
        return Math.abs(sc.scrollTop) <= 100;
    }

    let pendingViewportAnchor: ChatViewportAnchor | null = null
    let viewportRestoreQueued = false
    let viewportRestoreEpoch = 0
    let newMessageScrollTimer: ReturnType<typeof setTimeout> | null = null

    /** Coalesce fast streaming updates around the first pre-update anchor. */
    function queueViewportRestore(anchor: ChatViewportAnchor) {
        const sc = chatBody?.parentElement
        if (!sc) return
        if (!pendingViewportAnchor || pendingViewportAnchor.roomId !== anchor.roomId) {
            pendingViewportAnchor = anchor
        }
        if (viewportRestoreQueued) return
        viewportRestoreQueued = true
        const epoch = ++viewportRestoreEpoch
        void tick().then(() => requestAnimationFrame(() => {
            viewportRestoreQueued = false
            const saved = pendingViewportAnchor
            pendingViewportAnchor = null
            if (!saved || epoch !== viewportRestoreEpoch) return
            if (saved.roomId !== getCurrentChatRoomId()) return
            const currentScroller = chatBody?.parentElement
            if (currentScroller) restoreChatViewportAnchor(chatBody, currentScroller, saved)
        }))
    }

    function scrollLatestIntoChatScreen() {
        if(!chatBody) return;
        const element = chatBody.firstElementChild as HTMLElement | null;
        const chatScreen = chatBody.parentElement;
        if(!element || !chatScreen) return;
        // The newest reply can be taller than the viewport. Aligning its start
        // made each output jump upward instead of staying near the live tail.
        scrollWithinContainer(element, chatScreen, { block: 'end', behavior: 'instant' });
    }

    export const scrollToLatestMessage = () => {
        if(!chatBody) return;
        hasNewUnreadMessage = false;
        scrollLatestIntoChatScreen();
    }

    let previousLength = 0;
    let previousChatRoomId: string | null = null;

    $effect(() => {
        void $ReloadChatPointer; // Make $effect track ReloadChatPointer changes
        if (newMessageScrollTimer !== null) {
            clearTimeout(newMessageScrollTimer)
            newMessageScrollTimer = null
        }
        const wasAtBottom = checkIfAtBottom();
        const currentChatRoomId = getCurrentChatRoomId();
        const isSameChat = currentChatRoomId === previousChatRoomId;
        // With auto-scroll disabled, even a reader currently at the tail has
        // asked for a stationary viewport while input/output grows.
        const sc = chatBody?.parentElement
        const anchor = sc && isSameChat && !(wasAtBottom && DBState.db.autoScrollToNewMessage)
            ? captureChatViewportAnchor(chatBody, sc, currentChatRoomId)
            : null
        updateChatBody()
        if (anchor) queueViewportRestore(anchor)
        else pendingViewportAnchor = null

        // Only auto-scroll if it's the same chat and new messages were added
        if(isSameChat && messages.length > previousLength){
            const lastMsg = messages[messages.length - 1];
            if(lastMsg && lastMsg.role === 'char' && DBState.db.autoScrollToNewMessage){
                if(wasAtBottom || DBState.db.alwaysScrollToNewMessage){
                    const scheduledRoomId = currentChatRoomId
                    newMessageScrollTimer = setTimeout(() => {
                        newMessageScrollTimer = null
                        // A delayed scroll must not drag the reader away after
                        // switching chats or manually scrolling into history.
                        if (getCurrentChatRoomId() !== scheduledRoomId) return
                        if (!DBState.db.alwaysScrollToNewMessage && !checkIfAtBottom()) return
                        scrollLatestIntoChatScreen()
                    }, 700);
                } else {
                    hasNewUnreadMessage = true;
                }
            }
        }
        previousLength = messages.length;
        previousChatRoomId = currentChatRoomId;
    })

    onDestroy(() => {
        if (newMessageScrollTimer !== null) clearTimeout(newMessageScrollTimer)
        viewportRestoreEpoch++
        pendingViewportAnchor = null
    })

</script>

<div class="flex flex-col-reverse" style="overflow-anchor: none" bind:this={chatBody}></div>
