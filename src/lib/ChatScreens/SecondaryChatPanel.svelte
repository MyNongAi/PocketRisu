<script lang="ts">
    import { tick } from 'svelte'
    import { get } from 'svelte/store'
    import { Send, Square, X } from '@lucide/svelte'
    import { createSimpleCharacter, DBState, selectedCharID } from 'src/ts/stores.svelte'
    import { language } from 'src/lang'
    import { captureGenerationTarget } from 'src/ts/process/generationTarget'
    import { captureChatModelRoute } from 'src/ts/process/request/modelPresetBinding'
    import { captureModuleRuntimeContext, getModuleAssets } from 'src/ts/process/modules'
    import { processScript } from 'src/ts/process/scripts'
    import { processMultiCommand } from 'src/ts/process/command'
    import { runTrigger } from 'src/ts/process/triggers'
    import { sendChat } from 'src/ts/process/index.svelte'
    import {
        abortGeneration,
        chatGenKey,
        endGeneration,
        generationStates,
        getGenerationAdmission,
        registerAbort,
    } from 'src/ts/process/generationState'
    import { ensureCurrentChatReady } from 'src/ts/storage/chatStorage'
    import { forageStorage, requestImmediateSave } from 'src/ts/globalApi.svelte'
    import { alertError, notifyError } from 'src/ts/alert'
    import { getChatAssetRenderWindow } from 'src/ts/chatAssetWindow'
    import { splitChatOpen } from 'src/ts/chatSplitPane'
    import { chatWriterClaimMessage } from 'src/ts/storage/nodeStorage'
    import SecondaryChatMessage from './SecondaryChatMessage.svelte'

    const CHARACTER_KEY = 'pocketrisu:split-chat:character'
    const CHAT_KEY = 'pocketrisu:split-chat:chat'

    function readStored(key: string): string {
        try {
            return localStorage.getItem(key) ?? ''
        } catch {
            return ''
        }
    }

    function persist(key: string, value: string) {
        try {
            localStorage.setItem(key, value)
        } catch {
            // Split chat remains usable for this session without persistence.
        }
    }

    let characterId = $state(readStored(CHARACTER_KEY))
    let chatId = $state(readStored(CHAT_KEY))
    let messageInput = $state('')
    let preparing = $state(false)
    let messageViewport: HTMLDivElement | null = $state(null)

    let selectableCharacters = $derived(DBState.db.characters.filter((character) =>
        character && !character.trashTime && character.chaId !== '§playground'
    ))
    let characterIndex = $derived(DBState.db.characters.findIndex((character) => character?.chaId === characterId))
    let currentCharacter = $derived(characterIndex >= 0 ? DBState.db.characters[characterIndex] : null)
    let currentChatIndex = $derived(currentCharacter?.chats?.findIndex((chat) => chat?.id === chatId) ?? -1)
    let currentChat = $derived(currentChatIndex >= 0 ? currentCharacter?.chats?.[currentChatIndex] : null)
    let renderModuleContext = $derived(currentCharacter && currentChat
        ? captureModuleRuntimeContext(currentCharacter, currentChat)
        : null)
    let simpleCharacter = $derived(currentCharacter && renderModuleContext
        ? createSimpleCharacter(currentCharacter, getModuleAssets(renderModuleContext))
        : null)
    let currentKey = $derived(chatGenKey(currentChat?.id))
    let generating = $derived($generationStates.has(currentKey))
    let renderedMessages = $derived(currentChat?._placeholder ? [] : (currentChat?.message ?? []))
    let assetWindow = $derived(getChatAssetRenderWindow(
        renderedMessages,
        DBState.db.externalAssetRecentOutputs,
        currentChat?.firstMessageDisabled !== true,
    ))
    let startIndex = $derived(Math.max(0, renderedMessages.length - 80))

    function chooseDefaultCharacter() {
        const primaryIndex = get(selectedCharID)
        const primary = DBState.db.characters[primaryIndex]
        const next = primary && !primary.trashTime && primary.chaId !== '§playground'
            ? primary
            : selectableCharacters[0]
        if (!next) return
        characterId = next.chaId
        chatId = next.chats?.[next.chatPage]?.id ?? next.chats?.[0]?.id ?? ''
    }

    function selectCharacter(nextCharacterId: string) {
        characterId = nextCharacterId
        const character = DBState.db.characters.find((item) => item?.chaId === nextCharacterId)
        chatId = character?.chats?.[character.chatPage]?.id ?? character?.chats?.[0]?.id ?? ''
    }

    $effect(() => {
        if (characterIndex < 0 && selectableCharacters.length > 0) chooseDefaultCharacter()
    })

    $effect(() => {
        if (!currentCharacter) return
        if (currentChatIndex < 0) {
            chatId = currentCharacter.chats?.[currentCharacter.chatPage]?.id ?? currentCharacter.chats?.[0]?.id ?? ''
        }
    })

    $effect(() => {
        persist(CHARACTER_KEY, characterId)
        persist(CHAT_KEY, chatId)
    })

    $effect(() => {
        const character = currentCharacter
        const index = currentChatIndex
        const placeholder = currentChat?._placeholder
        if (!character || index < 0 || !placeholder) return
        void ensureCurrentChatReady(character.chats, index, character.chaId)
    })

    $effect(() => {
        renderedMessages.length
        if (!messageViewport) return
        void tick().then(() => {
            if (messageViewport) messageViewport.scrollTop = messageViewport.scrollHeight
        })
    })

    async function sendSecondary() {
        if (preparing || generating || !currentCharacter || !currentChat) return
        if (currentChat._placeholder) {
            await ensureCurrentChatReady(currentCharacter.chats, currentChatIndex, currentCharacter.chaId)
        }

        const character = DBState.db.characters.find((item) => item?.chaId === characterId)
        const chat = character?.chats?.find((item) => item?.id === chatId)
        if (!character || !chat || chat._placeholder) return

        let target = captureGenerationTarget(character, chat)
        const key = chatGenKey(target.chatId)
        const route = captureChatModelRoute(chat, 'model')
        const emotionRoute = captureChatModelRoute(chat, 'emotion')
        const memoryRoute = captureChatModelRoute(chat, 'memory')
        const admission = getGenerationAdmission(key, {
            characterId: target.characterId,
            chatId: target.chatId,
            presetId: route.kind === 'modelPreset' ? route.presetId : undefined,
            providerKey: route.kind === 'block' ? undefined : route.providerKey,
            modelId: route.kind === 'modelPreset'
                ? route.modelId
                : route.kind === 'classic'
                    ? route.aiModel
                    : undefined,
        })
        if (!admission.allowed) {
            if (!('reason' in admission) || admission.reason !== 'same-chat') notifyError('At most two chats can generate at the same time.')
            return
        }

        preparing = true
        let claimed = false
        let generationController: AbortController | null = null
        let generationStarted = false
        try {
            const claim = await forageStorage.claimChatWriterSession(character.chaId, chat.id)
            if (claim.ok === false) {
                notifyError(chatWriterClaimMessage(claim))
                return
            }
            claimed = true

            const moduleContext = captureModuleRuntimeContext(character, chat)
            const input = messageInput
            if (input.startsWith('/')) {
                const commandProcessed = await processMultiCommand(input, { character, chat, moduleContext })
                if (commandProcessed !== false) {
                    messageInput = ''
                    return
                }
            }

            const originalMessages = chat.message
            let messages = chat.message
            if (input === '') {
                if ((messages.length === 0 || messages.at(-1)?.role !== 'user') && DBState.db.useSayNothing) {
                    messages.push({ role: 'user', data: '*says nothing*', name: null, time: Date.now() })
                }
            } else if (character.type === 'character') {
                const triggerResult = await runTrigger(character, 'input', {
                    chat,
                    targetCharacter: character,
                    targetChat: chat,
                    moduleContext,
                })
                if (triggerResult) messages = triggerResult.chat.message
                messages.push({
                    role: 'user',
                    data: await processScript(character, input, 'editinput', {}, moduleContext),
                    time: Date.now(),
                    name: null,
                })
            } else {
                messages.push({ role: 'user', data: input, time: Date.now(), name: null })
            }
            chat.message = messages
            target = captureGenerationTarget(character, chat)

            // Trigger/script processing above can await. Repeat admission now,
            // immediately before registerAbort + sendChat's synchronous claim,
            // so this panel never attaches its Stop controller to another send.
            const finalAdmission = getGenerationAdmission(key, {
                characterId: target.characterId,
                chatId: target.chatId,
                presetId: route.kind === 'modelPreset' ? route.presetId : undefined,
                providerKey: route.kind === 'block' ? undefined : route.providerKey,
                modelId: route.kind === 'modelPreset'
                    ? route.modelId
                    : route.kind === 'classic'
                        ? route.aiModel
                        : undefined,
            })
            if (!finalAdmission.allowed) {
                chat.message = originalMessages
                if (!('reason' in finalAdmission) || finalAdmission.reason !== 'same-chat') {
                    notifyError('At most two chats can generate at the same time.')
                }
                return
            }

            messageInput = ''
            generationController = new AbortController()
            registerAbort(key, generationController)
            const sending = sendChat(-1, {
                signal: generationController.signal,
                generationTarget: target,
                moduleContext,
                routeSnapshot: route,
                emotionRouteSnapshot: emotionRoute,
                memoryRouteSnapshot: memoryRoute,
            })
            generationStarted = get(generationStates).get(key)?.abortController === generationController
            await sending
        } catch (error) {
            console.error('[SplitChat] send failed:', error)
            alertError(error)
        } finally {
            const activeGeneration = get(generationStates).get(key)
            if (generationStarted && (!activeGeneration || activeGeneration.abortController === generationController)) {
                endGeneration(key)
            }
            try {
                await requestImmediateSave()
            } catch (error) {
                console.error('[SplitChat] final save failed:', error)
            }
            if (claimed) await forageStorage.releaseChatWriterSession(character.chaId, chat.id)
            preparing = false
        }
    }
</script>

<aside class="flex h-full min-h-0 min-w-0 flex-col border-l border-darkborderc bg-darkbg" aria-label="Secondary chat panel">
    <header class="flex min-w-0 items-center gap-2 border-b border-darkborderc p-2">
        <select
            class="min-w-0 grow rounded-md border border-darkborderc bg-bgcolor px-2 py-1.5 text-sm text-textcolor"
            value={characterId}
            aria-label={language.character}
            onchange={(event) => selectCharacter(event.currentTarget.value)}
        >
            {#each selectableCharacters as character (character.chaId)}
                <option value={character.chaId}>{character.name}</option>
            {/each}
        </select>
        <select
            class="min-w-0 grow rounded-md border border-darkborderc bg-bgcolor px-2 py-1.5 text-sm text-textcolor"
            bind:value={chatId}
            aria-label={language.chatList}
        >
            {#each currentCharacter?.chats ?? [] as chat, index (chat.id ?? index)}
                <option value={chat.id}>{chat.name || `${language.chatList} ${index + 1}`}</option>
            {/each}
        </select>
        <button
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-textcolor2 hover:bg-selected hover:text-textcolor"
            aria-label="Close split chat"
            title="분할 채팅 닫기"
            onclick={() => splitChatOpen.set(false)}
        ><X size={18} /></button>
    </header>

    <div class="flex min-h-0 grow flex-col gap-2 overflow-y-auto p-3" bind:this={messageViewport}>
        {#if currentChat?._placeholder}
            <div class="m-auto text-sm text-textcolor2">{language.loadingChatData}</div>
        {:else if !currentCharacter || !currentChat || !simpleCharacter}
            <div class="m-auto text-sm text-textcolor2">{language.selectChatToView}</div>
        {:else}
            {#each renderedMessages.slice(startIndex) as message, offset (`${message.chatId ?? startIndex + offset}:${offset}`)}
                {@const index = startIndex + offset}
                <SecondaryChatMessage
                    {message}
                    character={currentCharacter}
                    chat={currentChat}
                    modules={renderModuleContext?.modules ?? []}
                    {simpleCharacter}
                    {index}
                    resolveAssets={assetWindow.messageIndices.has(index)}
                />
            {/each}
        {/if}
    </div>

    <div class="border-t border-darkborderc p-2">
        <div class="flex items-end gap-2 rounded-2xl border border-darkborderc bg-bgcolor px-2 py-1.5 focus-within:border-textcolor">
            <textarea
                class="max-h-40 min-h-9 min-w-0 grow resize-y bg-transparent px-2 py-1.5 text-sm text-textcolor outline-hidden"
                bind:value={messageInput}
                placeholder="메시지 입력"
                onkeydown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                        event.preventDefault()
                        void sendSecondary()
                    }
                }}
            ></textarea>
            <button
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-white hover:bg-primary/80 disabled:opacity-50"
                aria-label={generating ? 'Stop secondary generation' : language.send}
                disabled={preparing && !generating}
                onclick={() => generating ? abortGeneration(currentKey) : void sendSecondary()}
            >
                {#if generating}<Square size={17} />{:else}<Send size={18} />{/if}
            </button>
        </div>
    </div>
</aside>
