<script lang="ts">
    // The 🎨 album (the user's request, 2026-11-09; process/illustrationAlbum.ts).
    // 이 채팅: the pictures of the open chat's replies, newest first. A tap shows
    // one big: go to its message, draw its scene again (Lightboard's 재생성) or
    // take it out of the reply. Above them, the replies without a picture,
    // drawn one after another. 봇 전체: every picture stored for this bot (the
    // owner the settings' inlay gallery reads), by chat. 화풍 샘플: each preset
    // drawn from one scene and kept in the 🎨 module (illustrationSamples.ts),
    // whose 에셋 tab shows and deletes them too.
    import { untrack } from 'svelte'
    import { ChevronLeftIcon, ChevronRightIcon, LocateFixedIcon, PaletteIcon, RefreshCcwIcon, Trash2Icon, XIcon } from '@lucide/svelte'
    import { v4 } from 'uuid'
    import { language } from 'src/lang'
    import { DBState, ScrollToMessageStore, selectedCharID, sideBarClosing, sideBarStore } from 'src/ts/stores.svelte'
    import { isWideShell } from 'src/ts/gui/shellBreakpoint'
    import { alertConfirm, notifyError, notifyInfo, notifySuccess } from 'src/ts/alert'
    import { changeChatTo, getFileSrc } from 'src/ts/globalApi.svelte'
    import { sleep } from 'src/ts/util'
    import { closeIllustrationAlbum, illustrationAlbumStore, type IllustrationAlbumTab } from 'src/ts/illustrationAlbum.svelte'
    import { DEFAULT_SAMPLE_SCENE, chatPictures, inlayIdsOf, inlayThumbSrc, repliesWithoutPictures } from 'src/ts/process/illustrationAlbum'
    import {
        illustrateRepliesInTurn, illustratingReplies, illustrationBatch, presetsFor, redrawIllustration, redrawingIllustrations,
        restoreIllustrationPresets, stopIllustrationBatch, takeOutIllustration,
    } from 'src/ts/process/illustrationRun'
    import { drawPresetSample, drawingSamples, loadPresetSamples, removePresetSample } from 'src/ts/process/illustrationSamples'
    import { illustrationModuleOf } from 'src/ts/process/illustrationModule'
    import { captureModuleRuntimeContext } from 'src/ts/process/modules'
    import { getInlayAssetBlob, listInlayExplorerItems, type InlayExplorerItem } from 'src/ts/process/files/inlays'
    import type { IllustrationPreset } from 'src/ts/process/illustration'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import SelectInput from '../UI/GUI/SelectInput.svelte'
    import OptionInput from '../UI/GUI/OptionInput.svelte'
    import TextInput from '../UI/GUI/TextInput.svelte'

    let character = $derived(DBState.db.characters.find((c) => c?.chaId === illustrationAlbumStore.chaId))
    let chatIndex = $derived(character?.chats?.findIndex((c) => c?.id === illustrationAlbumStore.chatId) ?? -1)
    let chat = $derived(chatIndex >= 0 ? character?.chats?.[chatIndex] : undefined)
    let tab = $derived(illustrationAlbumStore.tab)

    function setTab(next: IllustrationAlbumTab) {
        illustrationAlbumStore.tab = next
        viewed = null
        sampleViewed = null
    }

    // ── 이 채팅 ──
    let pictures = $derived(chat && !chat._placeholder ? chatPictures(chat.message) : [])
    let range = $state(10)
    let missing = $derived(chat && !chat._placeholder ? repliesWithoutPictures(chat.message, range) : [])
    let batch = $derived($illustrationBatch)

    async function drawMissing() {
        const char = character
        const target = chat
        if (!char || !target || missing.length === 0 || batch) return
        if (DBState.db.sdProvider === '') {
            notifyError(language.illustrationNoImageProvider)
            return
        }
        const count = missing.length
        if (!await alertConfirm(language.illustrationBatchConfirm.replaceAll('{n}', String(count)))) return
        const messageIds = missing.map((index) => {
            const message = target.message[index]
            message.chatId ??= v4()
            return message.chatId
        })
        const drawn = await illustrateRepliesInTurn({ chaId: char.chaId, chatId: target.id, messageIds, moduleContext: captureModuleRuntimeContext(char, target) })
        notifySuccess(language.illustrationBatchDone.replace('{n}', String(drawn)))
    }

    // ── 봇 전체 ──
    let botItems = $state<InlayExplorerItem[] | null>(null)
    let botLoading = $state(false)
    async function loadBotPictures() {
        botLoading = true
        try {
            const items = await listInlayExplorerItems(true)
            botItems = items
                .filter((item) => item.type === 'image' && item.meta?.charId === illustrationAlbumStore.chaId)
                .sort((a, b) => (b.meta?.createdAt ?? 0) - (a.meta?.createdAt ?? 0))
        } catch (error) {
            notifyError(`${error}`)
            botItems = []
        } finally {
            botLoading = false
        }
    }
    $effect(() => {
        if (tab !== 'bot') return
        untrack(() => { if (botItems === null && !botLoading) void loadBotPictures() })
    })
    let botPictures = $derived((botItems ?? []).map((item) => ({ inlayId: item.id, chatId: item.meta?.chatId })))
    let botGroups = $derived.by(() => {
        const groups: { chatId: string | undefined, start: number, items: { inlayId: string }[] }[] = []
        botPictures.forEach((picture, position) => {
            let group = groups.find((g) => g.chatId === picture.chatId)
            if (!group) {
                group = { chatId: picture.chatId, start: position, items: [] }
                groups.push(group)
            }
            group.items.push(picture)
        })
        return groups
    })
    function chatName(chatId: string | undefined): string {
        return character?.chats?.find((c) => c?.id === chatId)?.name || language.illustrationAlbumChatGone
    }

    // ── The big view (이 채팅 / 봇 전체) ──
    let viewed = $state<{ list: 'chat' | 'bot', position: number } | null>(null)
    let viewedList = $derived(viewed?.list === 'bot' ? botPictures : pictures)
    let viewedItem = $derived(viewed ? viewedList[viewed.position] : undefined)
    let chatViewed = $derived(viewed?.list === 'chat' ? pictures[viewed.position] : undefined)
    let bigSrc = $state('')
    $effect(() => {
        const id = viewedItem?.inlayId
        bigSrc = ''
        if (!id) return
        let url = ''
        let cancelled = false
        void getInlayAssetBlob(id).then((asset) => {
            if (cancelled || !asset || !(asset.data instanceof Blob)) return
            url = URL.createObjectURL(asset.data)
            bigSrc = url
        }).catch(() => {})
        return () => {
            cancelled = true
            if (url) URL.revokeObjectURL(url)
        }
    })
    // A picture taken out leaves its place: the view closes when nothing is there.
    $effect(() => {
        if (viewed && !viewedItem) untrack(() => { viewed = null })
    })
    // A picture whose file is gone shows as an empty tile, not a broken image.
    function hideMissing(event: Event) {
        (event.currentTarget as HTMLImageElement).style.visibility = 'hidden'
    }
    function view(list: 'chat' | 'bot', position: number) {
        viewed = { list, position }
    }
    function step(offset: -1 | 1) {
        if (!viewed) return
        const next = viewed.position + offset
        if (next >= 0 && next < viewedList.length) viewed = { ...viewed, position: next }
    }

    async function goTo(chatId: string | undefined, inlayId: string) {
        const char = character
        const index = char?.chats?.findIndex((c) => c?.id === chatId) ?? -1
        if (!char || index < 0) {
            notifyInfo(language.illustrationAlbumChatGone)
            return
        }
        if (DBState.db.characters[$selectedCharID]?.chaId !== char.chaId) {
            notifyInfo(language.illustrationAlbumOtherBot)
            return
        }
        closeIllustrationAlbum()
        // On a phone the sidebar the album was opened from covers the chat.
        if (!isWideShell(window.innerWidth) && $sideBarStore) sideBarClosing.set(true)
        if (char.chatPage !== index) changeChatTo(index)
        // The chat may load first; then its message is found by the picture.
        for (let i = 0; i < 60; i++) {
            const target = char.chats[index]
            if (target && !target._placeholder) {
                const at = (target.message ?? []).findIndex((m) => inlayIdsOf(m?.data).includes(inlayId))
                if (at >= 0) {
                    ScrollToMessageStore.value = at
                    return
                }
                if (i >= 10) break
            }
            await sleep(100)
        }
        notifyInfo(language.illustrationAlbumNotInChat)
    }

    async function redrawViewed() {
        const char = character
        const picture = chatViewed
        if (!char || !chat || !picture?.messageId || !picture.prompt) return
        await redrawIllustration({ chaId: char.chaId, chatId: chat.id, messageId: picture.messageId, inlayId: picture.inlayId })
    }

    async function takeOutViewed() {
        const picture = chatViewed
        const message = picture ? chat?.message?.[picture.index] : undefined
        if (!picture || !message) return
        if (!await alertConfirm(language.illustrationAlbumTakeOutConfirm)) return
        takeOutIllustration(message, picture.inlayId)
    }

    // ── 화풍 샘플 ──
    let presets = $derived(character ? presetsFor(character, chat, captureModuleRuntimeContext(character, chat)) : [])
    let ownModule = $derived(illustrationModuleOf(DBState.db))
    let samples = $state(new Map<string, { path: string, ext: string, index: number }>())
    let sampleSrc = $state<Record<string, string>>({})
    let sampleSceneText = $state(untrack(() => DBState.db.nodeOnlyIllustrationSampleScene ?? ''))
    let samplesRunning = $state(false)
    let samplesStopping = $state(false)
    let sampleViewed = $state<string | null>(null)
    let missingSamples = $derived(presets.filter((preset) => !samples.has(preset.name)))
    let orphanSamples = $derived([...samples.keys()].filter((name) => !presets.some((preset) => preset.name === name)))
    let usedPreset = $derived(character?.nodeOnlyIllustration?.preset)

    $effect(() => {
        const text = sampleSceneText.trim()
        if ((DBState.db.nodeOnlyIllustrationSampleScene ?? '') === text) return
        if (text) DBState.db.nodeOnlyIllustrationSampleScene = text
        else delete DBState.db.nodeOnlyIllustrationSampleScene
    })

    async function refreshSamples() {
        try {
            const next = await loadPresetSamples()
            const sources: Record<string, string> = {}
            for (const [name, sample] of next) sources[name] = await getFileSrc(sample.path)
            samples = next
            sampleSrc = sources
        } catch (error) {
            notifyError(`${error}`)
        }
    }
    // Again whenever the module's assets change (here, or in its 에셋 tab).
    $effect(() => {
        if (tab !== 'samples') return
        void ownModule?.assetManifest?.id
        void ownModule?.assets
        void ownModule?.assets?.length
        untrack(() => {
            restoreIllustrationPresets()
            void refreshSamples()
        })
    })

    async function drawSample(preset: IllustrationPreset) {
        const char = character
        if (!char) return
        if (DBState.db.sdProvider === '') {
            notifyError(language.illustrationNoImageProvider)
            return
        }
        try {
            if (!await drawPresetSample(preset, char, sampleSceneText)) notifyError(language.illustrationSampleFailed)
        } catch (error) {
            notifyError(`${language.illustrationSampleFailed}: ${error}`)
        }
        await refreshSamples()
    }

    async function drawMissingSamples() {
        const list = [...missingSamples]
        if (list.length === 0 || samplesRunning) return
        if (DBState.db.sdProvider === '') {
            notifyError(language.illustrationNoImageProvider)
            return
        }
        if (!await alertConfirm(language.illustrationSampleAllConfirm.replaceAll('{n}', String(list.length)))) return
        samplesRunning = true
        samplesStopping = false
        try {
            for (const preset of list) {
                if (samplesStopping) break
                await drawSample(preset)
            }
        } finally {
            samplesRunning = false
        }
    }

    async function deleteSample(name: string) {
        if (!await alertConfirm(language.illustrationSampleRemoveConfirm.replace('{name}', name))) return
        try {
            await removePresetSample(name)
        } catch (error) {
            notifyError(`${error}`)
        }
        if (sampleViewed === name) sampleViewed = null
        await refreshSamples()
    }

    function usePreset(name: string) {
        const char = character
        if (!char) return
        char.nodeOnlyIllustration = { ...(char.nodeOnlyIllustration ?? {}), preset: name }
        notifySuccess(language.illustrationSampleUsed.replace('{name}', name))
    }

    $effect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                if (viewed) viewed = null
                else if (sampleViewed) sampleViewed = null
                else closeIllustrationAlbum()
            } else if (viewed && event.key === 'ArrowLeft') step(-1)
            else if (viewed && event.key === 'ArrowRight') step(1)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    })

    const TABS: { key: IllustrationAlbumTab, label: () => string }[] = [
        { key: 'chat', label: () => language.illustrationAlbumChat },
        { key: 'bot', label: () => language.illustrationAlbumBot },
        { key: 'samples', label: () => language.illustrationAlbumSamples },
    ]
</script>

<div class="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 sm:items-center sm:p-3" role="presentation" data-illustration-album>
    <div class="flex h-full w-full max-w-3xl min-w-0 flex-col overflow-hidden bg-bgcolor text-textcolor shadow-xl sm:h-auto sm:max-h-[90vh] sm:rounded-lg sm:border sm:border-darkborderc"
        role="dialog" aria-modal="true" aria-label={language.illustrationAlbum}>
        <div class="flex shrink-0 items-center gap-2 border-b border-darkborderc px-4 py-3">
            <PaletteIcon size={18} class="shrink-0 text-textcolor2" />
            <h2 class="min-w-0 grow truncate text-base font-semibold">{language.illustrationAlbum}{#if character}<span class="font-normal text-textcolor2">{' · '}{character.name}</span>{/if}</h2>
            <button class="rounded p-1 text-textcolor2 hover:text-textcolor" aria-label={language.close} onclick={closeIllustrationAlbum}>
                <XIcon size={18} />
            </button>
        </div>

        <div class="flex shrink-0 gap-1 border-b border-darkborderc px-3 py-2 text-sm" role="tablist">
            {#each TABS as item (item.key)}
                <button
                    role="tab"
                    aria-selected={tab === item.key}
                    class="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 {tab === item.key ? 'bg-selected font-semibold text-textcolor' : 'text-textcolor2 hover:bg-selected/60'}"
                    data-album-tab={item.key}
                    onclick={() => setTab(item.key)}
                >{item.label()}{#if item.key === 'chat'}<span class="ml-1 text-xs text-textcolor2">{pictures.length}</span>{:else if item.key === 'bot' && botItems}<span class="ml-1 text-xs text-textcolor2">{botItems.length}</span>{/if}</button>
            {/each}
        </div>

        <div class="min-h-0 grow overflow-y-auto px-3 py-3">
            {#if !character}
                <p class="text-sm text-textcolor2">{language.illustrationAlbumNoBot}</p>
            {:else if tab === 'chat'}
                <!-- The replies that came out without a picture, drawn one after another. -->
                <div class="mb-3 flex flex-col gap-2 rounded-md border border-darkborderc p-2 text-sm" data-album-batch>
                    {#if batch}
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <span data-album-batch-progress>{language.illustrationBatchProgress.replace('{done}', String(batch.done)).replace('{total}', String(batch.total)).replace('{n}', String(batch.drawn))}</span>
                            <ShButton size="sm" variant="outline" disabled={batch.stopping} onclick={stopIllustrationBatch}>{language.illustrationBatchStop}</ShButton>
                        </div>
                    {:else}
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="min-w-0 grow">{language.illustrationBatchMissing.replace('{n}', String(missing.length))}</span>
                            <SelectInput size="sm" value={String(range)} onchange={(e) => { range = Number(e.currentTarget.value) }}>
                                <OptionInput value="10">{language.illustrationBatchLast10}</OptionInput>
                                <OptionInput value="30">{language.illustrationBatchLast30}</OptionInput>
                                <OptionInput value="0">{language.illustrationBatchAll}</OptionInput>
                            </SelectInput>
                            <ShButton size="sm" disabled={missing.length === 0} onclick={drawMissing}>{language.illustrationBatchStart}</ShButton>
                        </div>
                    {/if}
                </div>
                {#if pictures.length === 0}
                    <p class="text-sm text-textcolor2">{language.illustrationAlbumEmpty}</p>
                {:else}
                    <div class="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                        {#each pictures as picture, position (picture.inlayId)}
                            <button class="relative aspect-square overflow-hidden rounded-md bg-darkbg" onclick={() => view('chat', position)} data-album-picture={picture.inlayId}>
                                <img src={inlayThumbSrc(picture.inlayId)} alt="" class="h-full w-full object-cover" loading="lazy" onerror={hideMissing} />
                                <span class="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[11px] text-white">#{picture.index + 1}</span>
                                {#if $redrawingIllustrations.has(picture.inlayId)}
                                    <span class="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white">{language.illustrationDrawing}</span>
                                {/if}
                            </button>
                        {/each}
                    </div>
                {/if}
            {:else if tab === 'bot'}
                <p class="mb-2 text-xs text-textcolor2">{language.illustrationAlbumBotHint}</p>
                {#if botLoading && !botItems}
                    <p class="text-sm text-textcolor2">{language.loading}</p>
                {:else if botPictures.length === 0}
                    <p class="text-sm text-textcolor2">{language.illustrationAlbumEmpty}</p>
                {:else}
                    {#each botGroups as group (group.chatId ?? '')}
                        <h3 class="mb-1 mt-2 truncate text-sm font-semibold first:mt-0">{chatName(group.chatId)} <span class="font-normal text-textcolor2">{group.items.length}</span></h3>
                        <div class="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                            {#each group.items as picture, i (picture.inlayId)}
                                <button class="aspect-square overflow-hidden rounded-md bg-darkbg" onclick={() => view('bot', group.start + i)} data-album-bot-picture={picture.inlayId}>
                                    <img src={inlayThumbSrc(picture.inlayId)} alt="" class="h-full w-full object-cover" loading="lazy" onerror={hideMissing} />
                                </button>
                            {/each}
                        </div>
                    {/each}
                {/if}
            {:else}
                <div class="mb-3 flex flex-col gap-2 text-sm">
                    <div class="flex flex-col gap-1">
                        <span>{language.illustrationSampleScene}</span>
                        <TextInput size="sm" fullwidth bind:value={sampleSceneText} placeholder={DEFAULT_SAMPLE_SCENE} />
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                        {#if samplesRunning}
                            <ShButton size="sm" variant="outline" disabled={samplesStopping} onclick={() => { samplesStopping = true }}>{language.illustrationBatchStop}</ShButton>
                        {:else if missingSamples.length > 0}
                            <ShButton size="sm" onclick={drawMissingSamples}>{language.illustrationSampleAll.replace('{n}', String(missingSamples.length))}</ShButton>
                        {/if}
                    </div>
                    <span class="text-xs text-textcolor2">{language.illustrationSampleWhere.replace('{module}', ownModule?.name ?? language.illustrationModuleName)}</span>
                </div>
                {#if presets.length === 0}
                    <p class="text-sm text-textcolor2">{language.illustrationSampleNoPresets}</p>
                {/if}
                <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {#each presets as preset (preset.name)}
                        {@const src = sampleSrc[preset.name]}
                        {@const drawing = $drawingSamples.has(preset.name)}
                        <div class="flex min-w-0 flex-col overflow-hidden rounded-md border {usedPreset === preset.name ? 'border-primary' : 'border-darkborderc'}" data-album-sample={preset.name}>
                            <button class="relative aspect-[2/3] w-full bg-darkbg" disabled={!src} onclick={() => { sampleViewed = preset.name }}>
                                {#if src}
                                    <img {src} alt={preset.name} class="h-full w-full object-cover" loading="lazy" />
                                {:else}
                                    <span class="absolute inset-0 flex items-center justify-center text-xs text-textcolor2">{language.illustrationSampleNone}</span>
                                {/if}
                                {#if drawing}
                                    <span class="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white">{language.illustrationDrawing}</span>
                                {/if}
                            </button>
                            <div class="flex min-w-0 flex-col gap-1 p-1.5">
                                <span class="truncate text-sm" title={preset.name}>{preset.name}</span>
                                <span class="truncate text-[11px] text-textcolor2">{preset.source}</span>
                                <div class="flex flex-wrap gap-1">
                                    <ShButton size="xs" variant="outline" disabled={drawing || samplesRunning} onclick={() => drawSample(preset)}>{src ? language.illustrationSampleRedraw : language.illustrationSampleDraw}</ShButton>
                                    {#if usedPreset === preset.name}
                                        <span class="px-1 text-xs leading-6 text-primary">{language.illustrationSampleInUse}</span>
                                    {:else}
                                        <ShButton size="xs" variant="ghost" onclick={() => usePreset(preset.name)}>{language.illustrationSampleUse}</ShButton>
                                    {/if}
                                    {#if src}
                                        <button class="ml-auto p-1 text-textcolor2 hover:text-red-400" aria-label={language.illustrationSampleRemove} title={language.illustrationSampleRemove} onclick={() => deleteSample(preset.name)}><Trash2Icon size={14} /></button>
                                    {/if}
                                </div>
                            </div>
                        </div>
                    {/each}
                </div>
                {#if orphanSamples.length > 0}
                    <h3 class="mb-1 mt-4 text-sm font-semibold">{language.illustrationSampleOrphan}</h3>
                    <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {#each orphanSamples as name (name)}
                            <div class="flex min-w-0 flex-col overflow-hidden rounded-md border border-darkborderc">
                                <button class="aspect-[2/3] w-full bg-darkbg" onclick={() => { sampleViewed = name }}>
                                    {#if sampleSrc[name]}<img src={sampleSrc[name]} alt={name} class="h-full w-full object-cover" loading="lazy" />{/if}
                                </button>
                                <div class="flex items-center gap-1 p-1.5">
                                    <span class="min-w-0 grow truncate text-sm">{name}</span>
                                    <button class="p-1 text-textcolor2 hover:text-red-400" aria-label={language.illustrationSampleRemove} onclick={() => deleteSample(name)}><Trash2Icon size={14} /></button>
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            {/if}
        </div>
    </div>

    {#if viewed && viewedItem}
        <div class="fixed inset-0 z-50 flex flex-col bg-black text-white" role="dialog" aria-modal="true" data-album-viewer>
            <div class="flex shrink-0 items-center gap-2 px-3 py-2">
                <span class="min-w-0 grow truncate text-sm">
                    {viewed.position + 1} / {viewedList.length}
                    {#if chatViewed} · {language.illustrationAlbumMessage.replace('{n}', String(chatViewed.index + 1))}{:else if viewed.list === 'bot'} · {chatName(botPictures[viewed.position]?.chatId)}{/if}
                </span>
                <button class="rounded p-1 hover:bg-white/10" aria-label={language.close} onclick={() => { viewed = null }}><XIcon size={20} /></button>
            </div>
            <div class="relative flex min-h-0 grow items-center justify-center">
                {#if bigSrc}
                    <img src={bigSrc} alt="" class="max-h-full max-w-full object-contain" />
                {:else}
                    <img src={inlayThumbSrc(viewedItem.inlayId)} alt="" class="max-h-full max-w-full object-contain opacity-60" />
                {/if}
                {#if $redrawingIllustrations.has(viewedItem.inlayId)}
                    <span class="absolute inset-0 flex items-center justify-center bg-black/40 text-sm">{language.illustrationDrawing}</span>
                {/if}
                {#if viewed.position > 0}
                    <button class="absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2" aria-label="prev" onclick={() => step(-1)}><ChevronLeftIcon size={22} /></button>
                {/if}
                {#if viewed.position < viewedList.length - 1}
                    <button class="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2" aria-label="next" onclick={() => step(1)}><ChevronRightIcon size={22} /></button>
                {/if}
            </div>
            <div class="flex shrink-0 flex-col gap-2 px-3 py-3">
                <div class="flex flex-wrap gap-2">
                    <ShButton size="sm" variant="secondary" onclick={() => goTo(viewed?.list === 'bot' ? botPictures[viewed.position]?.chatId : chat?.id, viewedItem.inlayId)}>
                        <LocateFixedIcon size={14} /> {viewed.list === 'bot' ? language.illustrationAlbumOpenChat : language.illustrationAlbumGoTo}
                    </ShButton>
                    {#if chatViewed?.prompt}
                        <ShButton size="sm" variant="secondary" disabled={$redrawingIllustrations.has(chatViewed.inlayId) || (!!chatViewed.messageId && $illustratingReplies.has(chatViewed.messageId))} onclick={redrawViewed}>
                            <RefreshCcwIcon size={14} /> {language.illustrationAlbumRedrawOne}
                        </ShButton>
                        <ShButton size="sm" variant="destructive" onclick={takeOutViewed}>
                            <Trash2Icon size={14} /> {language.illustrationAlbumTakeOut}
                        </ShButton>
                    {/if}
                </div>
                {#if chatViewed?.prompt}
                    <details class="text-xs text-white/70">
                        <summary class="cursor-pointer">{language.illustrationAlbumScene}</summary>
                        <p class="mt-1 max-h-24 overflow-y-auto break-words">{chatViewed.prompt.positive}</p>
                    </details>
                {:else if viewed.list === 'chat'}
                    <span class="text-xs text-white/60">{language.illustrationAlbumNotOurs}</span>
                {/if}
            </div>
        </div>
    {/if}

    {#if sampleViewed && sampleSrc[sampleViewed]}
        <div class="fixed inset-0 z-50 flex flex-col bg-black text-white" role="dialog" aria-modal="true" data-album-sample-viewer>
            <div class="flex shrink-0 items-center gap-2 px-3 py-2">
                <span class="min-w-0 grow truncate text-sm">{sampleViewed}</span>
                <button class="rounded p-1 hover:bg-white/10" aria-label={language.close} onclick={() => { sampleViewed = null }}><XIcon size={20} /></button>
            </div>
            <div class="flex min-h-0 grow items-center justify-center">
                <img src={sampleSrc[sampleViewed]} alt={sampleViewed} class="max-h-full max-w-full object-contain" />
            </div>
            <div class="flex shrink-0 flex-wrap gap-2 px-3 py-3">
                {#if presets.some((preset) => preset.name === sampleViewed) && usedPreset !== sampleViewed}
                    <ShButton size="sm" variant="secondary" onclick={() => { if (sampleViewed) usePreset(sampleViewed) }}>{language.illustrationSampleUse}</ShButton>
                {/if}
                <ShButton size="sm" variant="destructive" onclick={() => { if (sampleViewed) void deleteSample(sampleViewed) }}>
                    <Trash2Icon size={14} /> {language.illustrationSampleRemove}
                </ShButton>
            </div>
        </div>
    {/if}
</div>
