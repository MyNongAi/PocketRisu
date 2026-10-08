<script lang="ts">
    import type { character, Message, StreamingDisplayOptimizationMode } from 'src/ts/storage/database.svelte';
    import { hasBrowsableSwipes } from 'src/ts/chatSwipes';
    import { inputEchoKey, previousInputIndex } from 'src/ts/gui/inputEcho';
    import { mount, onDestroy, tick, unmount } from 'svelte';
    import Chat from './Chat.svelte';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, DBState, selectedCharID, ReloadChatPointer } from 'src/ts/stores.svelte';
    import { chatFoldedStateMessageIndex } from 'src/ts/globalApi.svelte';
    import { get } from 'svelte/store';
    import { getChatAssetRenderWindow } from '../../ts/chatAssetWindow';
    import { isAtTail, revealScrollTop, shouldFollowTail, shouldRevealAddedMessage } from './chatViewport';
    import { chatGenKey, isChatGenerating } from 'src/ts/process/generationState';
    import { rerollPlaceholderShows, rerollPlaceholders, stepRerollPlaceholderSwipe } from 'src/ts/gui/rerollPlaceholder';
    
    const getCurrentChatRoomId = () => {
        const charId = get(selectedCharID);
        if (charId < 0) return null;
        const char = DBState.db.characters[charId];
        if (!char) return null;
        return char.chats?.[char.chatPage]?.id ?? null;
    };

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
        onNextSwipe?: (index?: number) => void
        unReroll: (index?: number) => void
        onDeleteSwipe?: (index?: number) => void
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
        updateRerollTarget?: (state: {
            rerollIcon: boolean|'dynamic'|'force'
            swipeOnly: boolean
            onNextSwipe: () => void
            onDeleteSwipe: () => void
            unReroll: () => void
            currentPage: number
            totalPages: number
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

    // The newest reply gets the full reroll controls; an older reply with
    // swipes gets only the arrows (and swipe delete) to browse them.
    const rerollTargetState = (message: Message, isRerollTarget: boolean, index: number) => isRerollTarget || hasBrowsableSwipes(message) ? {
        rerollIcon: 'force' as const,
        swipeOnly: !isRerollTarget,
        onNextSwipe: () => onNextSwipe(index),
        onDeleteSwipe: () => onDeleteSwipe(index),
        unReroll: () => unReroll(index),
        currentPage: (message.swipeId ?? 0) + 1,
        totalPages: message.swipes?.length ?? 1,
    } : {
        rerollIcon: false as const,
        swipeOnly: false,
        onNextSwipe: () => {},
        onDeleteSwipe: () => {},
        unReroll: () => {},
        currentPage: 1,
        totalPages: 1,
    };

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


        // The old reply while it is rerolled (gui/rerollPlaceholder.ts): drawn
        // as the newest message, in place of the new reply's empty stream
        // start, until the new reply has text. Only its swipe arrows act.
        const placeholder = currentChat?.id ? get(rerollPlaceholders).get(currentChat.id) : undefined
        const placeholderIndex = placeholder && rerollPlaceholderShows(messages, placeholder) ? placeholder.index : -1
        if (placeholder && placeholderIndex >= 0) {
            const placeholderChatId = placeholder.chatId
            const message = placeholder.message as Message
            const echoIndex = previousInputIndex(messages, Math.min(placeholderIndex, messages.length))
            const echoText = echoIndex >= 0 ? (messages[echoIndex].data ?? '') : ''
            const currentHash = hashCode(['reroll-placeholder', placeholderChatId, placeholderIndex, message.swipeId ?? 0, message.swipes?.length ?? 0, echoText, message.data].join('\u0000'))
            currentHashes.add(currentHash)
            if (!hashes.has(currentHash)) {
                const previous = chatBody.querySelector<HTMLElement>(`:scope > [data-chat-slot="${placeholderIndex}"]`)
                const previousHeight = previous?.offsetHeight ?? 0
                const b = document.createElement('div')
                b.setAttribute('x-hashed', currentHash.toString())
                b.dataset.chatSlot = placeholderIndex.toString()
                b.classList.add('chat-message-container')
                const hold = { rendered: false, release: () => {} }
                const browsable = hasBrowsableSwipes(message)
                const inst = mount(Chat, {
                    target: b,
                    props: {
                        message: message.data,
                        messageKey: '',
                        previousInput: echoText,
                        previousInputKey: echoIndex >= 0 ? inputEchoKey(messages[echoIndex], echoIndex) : '',
                        previousInputIndex: echoIndex,
                        isLastMemory: false,
                        idx: placeholderIndex,
                        totalLength: messages.length,
                        img: getSenderImage('char'),
                        loadSenderImage: () => getSenderImage('char'),
                        onReroll: () => {},
                        rerollIcon: browsable ? 'force' : false,
                        swipeOnly: true,
                        onNextSwipe: () => { stepRerollPlaceholderSwipe(placeholderChatId, 1) },
                        unReroll: () => { stepRerollPlaceholderSwipe(placeholderChatId, -1) },
                        onDeleteSwipe: () => {},
                        currentPage: (message.swipeId ?? 0) + 1,
                        totalPages: message.swipes?.length ?? 1,
                        character: simpleChar,
                        largePortrait: (currentCharacter as character).largePortrait ?? false,
                        messageGenerationInfo: message.generationInfo,
                        role: 'char',
                        name: currentCharacter.name,
                        isComment: false,
                        disabled: false,
                        resolveChatAssets: true,
                        resolveSenderIcon: true,
                        onBodyRendered: () => { hold.rendered = true; hold.release() },
                        placeholder: true,
                    },
                })
                mountInstances.set(currentHash, inst)
                chatBody.prepend(b)
                if (!hold.rendered) hold.release = holdHeight(b, previousHeight)
            }
            nextHash = currentHash
        }

        for(let i=loadStart ; i >= loadEnd; i--){
            if(i < 0) break; // Prevent out of bounds
            if(i === placeholderIndex) continue; // the empty stream start the old reply stands in for
            const message = messages[i];
            const messageLargePortrait = message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false);
            const isRerollTarget = i === lastRealCharIdx;
            const activeStreamingMessage = i === activeStreamingIndex && message.role === 'char';
            const resolveChatAssets = assetRenderWindow.messageIndices.has(i)
            const hashMessageData = activeStreamingMessage ? '' : message.data;
            // The input a reply answers is echoed under it; a changed input remounts the reply.
            const echoIndex = message.role === 'char' ? previousInputIndex(messages, i) : -1;
            const echoText = echoIndex >= 0 ? (messages[echoIndex].data ?? '') : '';
            // A reload signal (an HTML button's trigger, reloadChat, v2UpdateChatAt)
            // is not part of the hash: the message re-renders in place
            // (Chat.svelte), as before upstream's "New chat loading"
            // (2025-06-07). Rebuilding it swapped the whole element under the
            // reader, and the browser's scroll anchoring then moved the view
            // by the size of the panel the button opened. The role is, since
            // a role switch (playground) needs the new sender.
            let hashd = (echoIndex >= 0 ? echoText + '\u0000' : '') + hashMessageData + (message.chatId ?? '') + i.toString() + (message.role ?? '') + messageLargePortrait.toString() + message.disabled?.toString() + (message.swipeId ?? 0).toString() + (message.swipes?.length ?? 0).toString() + resolveChatAssets.toString();
            const currentHash = hashCode(hashd);
            currentHashes.add(currentHash);
            if(!hashes.has(currentHash)){
                // Streamed text changes the hash every chunk, so the streaming
                // message is remounted each time. Its replacement renders its
                // body asynchronously; hold the old height meanwhile so the
                // transcript never collapses under the reader for a frame.
                const previous = chatBody.querySelector<HTMLElement>(`:scope > [data-chat-slot="${i}"]`);
                const previousHeight = previous?.offsetHeight ?? 0;
                const b = document.createElement('div');
                b.setAttribute('x-hashed', currentHash.toString());
                b.dataset.chatSlot = i.toString();
                if (message.chatId) b.dataset.chatId = message.chatId;
                b.classList.add('chat-message-container');
                const hold = { rendered: false, release: () => {} };
                const inst = mount(Chat, {
                    target: b,
                    props: {
                        message: message.data,
                        messageKey: inputEchoKey(message, i),
                        previousInput: echoText,
                        previousInputKey: echoIndex >= 0 ? inputEchoKey(messages[echoIndex], echoIndex) : '',
                        previousInputIndex: echoIndex,
                        isLastMemory: false,
                        idx: i,
                        totalLength: messages.length,
                        img: resolveChatAssets ? getSenderImage(message.role) : '',
                        loadSenderImage: () => getSenderImage(message.role),
                        onReroll: onReroll,
                        unReroll: unReroll,
                        ...rerollTargetState(message, isRerollTarget, i),
                        character: simpleChar,
                        largePortrait: messageLargePortrait,
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
                        onBodyRendered: () => { hold.rendered = true; hold.release(); },
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
                if (!hold.rendered) hold.release = holdHeight(b, previousHeight);
            }
            else{
                const inst = mountInstances.get(currentHash)
                inst?.updateStreamingDisplay?.({
                    isOptimizedStreamingMessage: activeStreamingMessage,
                    streamingOptimizationMode: performanceMode,
                    rawStreamingText: message.data,
                })
                // A message that stopped being the reroll target must also drop its
                // swipe-delete control: onDeleteSwipe acts on the current last message.
                inst?.updateRerollTarget?.(rerollTargetState(message, isRerollTarget, i))
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

    // ── Viewport ─────────────────────────────────────────────────────────────
    // The scroller (DefaultChatScreen's .default-chat-screen) is top-origin:
    // scrollTop 0 is the oldest loaded message and the live tail is at the far
    // end. Text streaming into the newest reply therefore grows BELOW what the
    // reader is looking at and cannot move it, so nothing here has to put the
    // view back afterwards. (The upstream flex-col-reverse scroller measured
    // from the bottom: every streamed chunk, and every remount of the
    // streaming message, shifted the whole transcript under the reader.)
    //
    // The view scrolls by itself only when:
    // - a chat is opened: it starts at its tail, which stays pinned while
    //   bodies and images finish rendering, until the reader scrolls, taps or
    //   types;
    // - a message is added: if the reader was at the tail (or sent it), the
    //   view moves once to show where it starts, never past its first line;
    // - the reader is at the tail and the viewport or composer resizes (the
    //   mobile keyboard opening, a growing input), so the tail stays in view;
    // - "auto-scroll to new message" is on and the reader is at the tail.
    const getScroller = () => chatBody?.parentElement ?? null

    function checkIfAtBottom() {
        const sc = getScroller()
        return !sc || isAtTail(sc)
    }

    function scrollToTail() {
        const sc = getScroller()
        if (sc) sc.scrollTop = sc.scrollHeight
    }

    /** Toward the tail, but never past the newest message's first line. */
    function revealNewestMessage() {
        const sc = getScroller()
        if (!sc) return
        const newest = chatBody.firstElementChild as HTMLElement | null
        const newestTop = newest
            ? sc.scrollTop + newest.getBoundingClientRect().top - sc.getBoundingClientRect().top
            : sc.scrollHeight
        sc.scrollTop = revealScrollTop(sc, newestTop)
    }

    /** Keep a remounted message at its previous height until its body has
     *  rendered (the caller releases it then, Chat's onBodyRendered) or grown
     *  that tall, or 1.5 s at most. Waiting for the old height alone left a
     *  gap under a shorter swipe for the whole 1.5 s, and then the view
     *  jumped (the user's report, 2026-10-09). Returns the release. */
    function holdHeight(el: HTMLElement, height: number): () => void {
        if (height <= 0) return () => {}
        el.style.minHeight = `${height}px`
        let released = false
        const contentHeight = () => {
            let total = 0
            for (const child of Array.from(el.children)) total += (child as HTMLElement).offsetHeight
            return total
        }
        const release = () => {
            if (released) return
            released = true
            observer.disconnect()
            clearTimeout(timer)
            el.style.minHeight = ''
        }
        const observer = new ResizeObserver(() => {
            if (contentHeight() >= height - 1) release()
        })
        for (const child of Array.from(el.children)) observer.observe(child)
        const timer = setTimeout(release, 1500)
        return release
    }

    let pinnedToTail = false
    // The "just opened" pin follows the tail while the chat first renders
    // (images and inlays arriving); after that a card's own animation (a
    // banner that grows and shrinks) must not drag the view along.
    const OPEN_PIN_MS = 3000
    let pinnedAt = 0

    /** A reply is being written into this chat right now. */
    function generatingHere(): boolean {
        const chat = currentCharacter?.chats?.[currentCharacter.chatPage]
        return !!chat?.isStreaming || isChatGenerating(chatGenKey(chat?.id))
    }
    // The message at the top of the view and how far its top sits from the
    // view's top, as of the reader's last scroll. A message whose content
    // changes after it rendered (a late image inlay, a trigger from an HTML
    // button, a reroll pointer) is remounted; that, or anything above the
    // reader changing height, must not move what they are reading. Resize
    // observer callbacks run after layout and before the scroll events a
    // shift causes, so this is still the pre-change position when they do.
    // `line` is the element at the reader's line inside that message (a
    // paragraph, a panel): a card's header that grows, shrinks or animates
    // above it, in the same message, must not move it either. Anchored to
    // the message's top, an animated banner shook the text being read by
    // its full height change on every frame. When a re-render replaces it,
    // the message's top is the fallback.
    type ReaderAnchor = { chatId: string | null, slot: string, offsetTop: number, roomId: string | null, line: HTMLElement | null, lineOffsetTop: number }
    let readerAnchor: ReaderAnchor | null = null
    let readerAnchorFrame = 0
    // Blank space kept under the newest message so the view need not move
    // when the transcript gets shorter below the reader (stepping back to a
    // shorter swipe of the last reply): without it the browser clamps the
    // scroll position and the view jumps up. It shrinks as the reader
    // scrolls up away from it and goes when a message is added or the chat
    // changes.
    let tailSlack = 0

    function setTailSlack(px: number) {
        tailSlack = Math.max(0, Math.round(px))
        if (chatBody) chatBody.style.paddingBottom = tailSlack ? `${tailSlack}px` : ''
    }

    /** Keep only the slack the view still reaches into. */
    function trimTailSlack() {
        const sc = getScroller()
        if (!sc || tailSlack === 0) return
        const needed = sc.scrollTop + sc.clientHeight - (sc.scrollHeight - tailSlack)
        if (needed < tailSlack) setTailSlack(needed)
    }

    const GREETING_SLOT = 'greeting'

    // The greeting is drawn by DefaultChatScreen above this list, in the same
    // scroller. It must be an anchor too: anchored to the first message below
    // it instead, a greeting that grew (a CSS button opening a panel) pushed
    // itself up out of view by exactly the growth.
    function greetingElement(): HTMLElement | null {
        const element = getScroller()?.querySelector<HTMLElement>('.risu-chat[data-chat-index="-1"]') ?? null
        return element && !chatBody?.contains(element) ? element : null
    }

    function containerOf(anchor: ReaderAnchor): HTMLElement | null {
        if (anchor.slot === GREETING_SLOT) return greetingElement()
        if (anchor.chatId) {
            const byId = chatBody.querySelector<HTMLElement>(`:scope > [data-chat-id="${CSS.escape(anchor.chatId)}"]`)
            if (byId) return byId
        }
        return chatBody.querySelector<HTMLElement>(`:scope > [data-chat-slot="${anchor.slot}"]`)
    }

    /** The innermost element at the view's top edge inside `container`, skipping fixed and sticky ones. */
    function readingLine(container: HTMLElement, top: number): HTMLElement | null {
        let node = container
        for (let depth = 0; depth < 32; depth++) {
            let next: HTMLElement | null = null
            for (const child of Array.from(node.children) as HTMLElement[]) {
                const rect = child.getBoundingClientRect()
                if (rect.height === 0 || rect.bottom <= top) continue
                const position = getComputedStyle(child).position
                if (position === 'fixed' || position === 'sticky') continue
                next = child
                break
            }
            if (!next) break
            node = next
        }
        return node === container ? null : node
    }

    function recordReaderAnchor() {
        readerAnchorFrame = 0
        const sc = getScroller()
        if (!sc || !chatBody) return
        const top = sc.getBoundingClientRect().top
        let best: HTMLElement | null = null
        let bestTop = Infinity
        const greeting = greetingElement()
        const candidates = Array.from(chatBody.children) as HTMLElement[]
        if (greeting) candidates.push(greeting)
        for (const child of candidates) {
            const rect = child.getBoundingClientRect()
            if (rect.bottom <= top || rect.height === 0) continue
            if (rect.top < bestTop) {
                bestTop = rect.top
                best = child
            }
        }
        const slot = best && best === greeting ? GREETING_SLOT : best?.dataset.chatSlot
        const line = best && slot ? readingLine(best, top) : null
        readerAnchor = best && slot
            ? {
                chatId: best === greeting ? null : best.dataset.chatId ?? null,
                slot,
                offsetTop: bestTop - top,
                roomId: getCurrentChatRoomId(),
                line,
                lineOffsetTop: line ? line.getBoundingClientRect().top - top : 0,
            }
            : null
    }

    function scheduleReaderAnchor() {
        if (readerAnchorFrame) return
        readerAnchorFrame = requestAnimationFrame(recordReaderAnchor)
    }

    /** Put the reader's message back where it was; true if the view moved. */
    function keepReaderAnchor(): boolean {
        const anchor = readerAnchor
        const sc = getScroller()
        if (!anchor || !sc || anchor.roomId !== getCurrentChatRoomId()) return false
        // The reader's line while it is still on the page; else the message's top.
        const line = anchor.line?.isConnected && anchor.line.getClientRects().length > 0 ? anchor.line : null
        const element = line ?? containerOf(anchor)
        if (!element) return false
        const delta = element.getBoundingClientRect().top - sc.getBoundingClientRect().top - (line ? anchor.lineOffsetTop : anchor.offsetTop)
        if (Math.abs(delta) <= 0.5) return false
        const wanted = sc.scrollTop + delta
        const max = sc.scrollHeight - sc.clientHeight
        if (wanted > max + 0.5) setTailSlack(tailSlack + wanted - max)
        sc.scrollTop = wanted
        return true
    }
    // Where the reader was at their last scroll. Growth does not scroll, so
    // until they scroll again this still says whether they were at the tail.
    let readerAtTail = true
    // Bumped by anything that takes the viewport over (the reader's own
    // input, a programmatic jump); scheduled tail moves from before it lapse.
    let viewportIntent = 0
    let pendingTailMove: 'tail' | 'reveal' | null = null

    function scheduleTailMove(kind: 'tail' | 'reveal') {
        if (pendingTailMove === 'tail') return
        const scheduled = pendingTailMove !== null
        pendingTailMove = kind
        if (scheduled) return
        const intent = viewportIntent
        void tick().then(() => requestAnimationFrame(() => {
            const move = pendingTailMove
            pendingTailMove = null
            if (intent !== viewportIntent) return
            if (move === 'tail') scrollToTail()
            else if (move === 'reveal') revealNewestMessage()
        }))
    }

    type ViewportAnchor = {
        element: HTMLElement
        offsetTop: number
        roomId: string | null
    }
    let viewportRestoreRevision = 0

    /** First visible message, to keep in place while older pages mount above. */
    function captureViewportAnchor(): ViewportAnchor | null {
        const sc = getScroller()
        if (!sc) return null
        const scRect = sc.getBoundingClientRect()
        const candidates = Array.from(chatBody.querySelectorAll<HTMLElement>('[data-chat-index]'))
        const element = candidates
            .filter((candidate) => {
                const rect = candidate.getBoundingClientRect()
                return rect.bottom > scRect.top && rect.top < scRect.bottom
            })
            .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0]
        if (!element) return null
        return {
            element,
            offsetTop: element.getBoundingClientRect().top - scRect.top,
            roomId: getCurrentChatRoomId(),
        }
    }

    // Browsers with CSS scroll anchoring already keep it in place; then the
    // measured delta is 0. Without it (Safari), older pages pushed it down.
    async function restoreViewportAnchor(anchor: ViewportAnchor, revision: number) {
        await tick()
        requestAnimationFrame(() => {
            if (revision !== viewportRestoreRevision || !anchor.element.isConnected) return
            if (anchor.roomId !== getCurrentChatRoomId()) return
            const sc = getScroller()
            if (!sc) return
            const delta = anchor.element.getBoundingClientRect().top
                - sc.getBoundingClientRect().top
                - anchor.offsetTop
            if (Math.abs(delta) > 0.5) sc.scrollTop += delta
        })
    }

    export const scrollToLatestMessage = () => {
        if(!chatBody) return;
        hasNewUnreadMessage = false;
        viewportIntent++;
        scrollToTail();
    }

    /** Hand the viewport to a programmatic scroll (message jump, nav buttons). */
    export const releaseViewport = () => {
        pinnedToTail = false;
        viewportIntent++;
        viewportRestoreRevision++;
    }

    $effect(() => {
        const sc = getScroller()
        if (!sc) return
        const onReaderInput = () => {
            pinnedToTail = false
            viewportIntent++
        }
        const onScroll = () => {
            trimTailSlack()
            readerAtTail = isAtTail(sc)
            scheduleReaderAnchor()
        }
        let viewportHeight = sc.clientHeight
        const observer = new ResizeObserver((entries) => {
            const viewportResized = sc.clientHeight !== viewportHeight
            viewportHeight = sc.clientHeight
            // The transcript itself (streamed text, a remount settling, the
            // greeting re-rendering or opening a panel) only drags the view
            // along when the reader asked for that.
            const greeting = greetingElement()
            if (pinnedToTail && performance.now() - pinnedAt > OPEN_PIN_MS) pinnedToTail = false
            const follow = shouldFollowTail({
                pinnedToTail,
                readerAtTail,
                onlyTranscriptResized: !viewportResized && entries.every((entry) => entry.target === chatBody || entry.target === greeting),
                // Auto-scroll follows a reply as it is written. Once it is
                // done, a reader at the tail keeps their line: following the
                // tail then made an animated panel in the reply shake the
                // text up and down.
                autoScroll: DBState.db.autoScrollToNewMessage && generatingHere(),
            })
            if (follow) {
                scrollToTail()
            } else {
                if (pendingTailMove === null) keepReaderAnchor()
                readerAtTail = isAtTail(sc)
            }
        })
        const observeChildren = () => {
            observer.disconnect()
            observer.observe(sc)
            for (const child of Array.from(sc.children)) observer.observe(child)
        }
        observeChildren()
        const children = new MutationObserver(observeChildren)
        children.observe(sc, { childList: true })
        const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
        sc.addEventListener('scroll', onScroll, { passive: true })
        for (const type of inputEvents) sc.addEventListener(type, onReaderInput, { passive: true })
        recordReaderAnchor()
        return () => {
            if (readerAnchorFrame) cancelAnimationFrame(readerAnchorFrame)
            readerAnchorFrame = 0
            observer.disconnect()
            children.disconnect()
            sc.removeEventListener('scroll', onScroll)
            for (const type of inputEvents) sc.removeEventListener(type, onReaderInput)
        }
    })

    let previousLength = 0;
    let previousLoadPages = 0;
    let previousChatRoomId: string | null = null;

    $effect(() => {
        void $ReloadChatPointer; // Make $effect track ReloadChatPointer changes
        void $rerollPlaceholders; // and the old reply shown while it is rerolled
        const currentChatRoomId = getCurrentChatRoomId();
        const isSameChat = currentChatRoomId === previousChatRoomId;
        const added = isSameChat && messages.length > previousLength;
        const olderPagesMounted = isSameChat && loadPages > previousLoadPages;
        const wasAtTail = checkIfAtBottom();
        const anchor = olderPagesMounted && !pinnedToTail && pendingTailMove === null
            ? captureViewportAnchor()
            : null
        const restoreRevision = ++viewportRestoreRevision
        updateChatBody()
        if (anchor) void restoreViewportAnchor(anchor, restoreRevision)

        if (!isSameChat || added) setTailSlack(0)
        if (!isSameChat) {
            pinnedToTail = true
            pinnedAt = performance.now()
            scheduleTailMove('tail')
        } else if (added) {
            // The first new message ends the "just opened" pin however it
            // was sent (tap, Enter, a plugin or another device); from here the
            // reply streams in below without dragging the view.
            pinnedToTail = false
            const lastMsg = messages[messages.length - 1];
            const reveal = shouldRevealAddedMessage({
                wasAtTail,
                role: lastMsg?.role,
                autoScroll: DBState.db.autoScrollToNewMessage,
                alwaysScroll: DBState.db.alwaysScrollToNewMessage,
            })
            if (reveal) {
                scheduleTailMove('reveal')
            } else if (lastMsg?.role === 'char' && DBState.db.autoScrollToNewMessage) {
                hasNewUnreadMessage = true;
            }
        }
        previousLength = messages.length;
        previousLoadPages = loadPages;
        previousChatRoomId = currentChatRoomId;
    })

</script>

<div class="flex flex-col-reverse" bind:this={chatBody}></div>
