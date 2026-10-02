<script lang="ts">
    // ✂️ log capture: the "pick the end" bar, the progress bar and the result
    // window with the images (src/ts/gui/logCaptureState.svelte.ts).
    import { CheckIcon, CopyIcon, DownloadIcon, Share2Icon, XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Portal from '../UI/GUI/Portal.svelte'
    import { BackLayerRank, useBackLayer } from 'src/ts/gui/backLayers.svelte'
    import { formatLogRange, logMessageNumber } from 'src/ts/gui/logCapture'
    import {
        canShareLogImages,
        cancelLogCapture,
        copyLogImage,
        isLogCapturePickingHere,
        logCapture,
        saveLogImage,
        shareLogImages,
        type LogCaptureImage,
    } from 'src/ts/gui/logCaptureState.svelte'

    const picking = $derived(isLogCapturePickingHere())
    const resultOpen = $derived(logCapture.phase === 'done' || logCapture.phase === 'error')
    const canShare = canShareLogImages()

    useBackLayer(BackLayerRank.Menu, () => picking, cancelLogCapture)
    useBackLayer(BackLayerRank.Popup, () => resultOpen || logCapture.phase === 'rendering', cancelLogCapture)

    const messageLabel = (index: number) => index < 0 ? language.logCapture.greeting : `#${logMessageNumber(index)}`

    const stageText = $derived(
        logCapture.stage === 'render' ? language.logCapture.stageRender
        : logCapture.stage === 'images' ? language.logCapture.stageImages
        : language.logCapture.stageDraw
    )

    let copiedIndex = $state(-1)
    async function copyOne(image: LogCaptureImage, index: number) {
        if (await copyLogImage(image)) {
            copiedIndex = index
            setTimeout(() => { if (copiedIndex === index) copiedIndex = -1 }, 1800)
        }
    }

    function saveAll() {
        logCapture.images.forEach((image, i) => setTimeout(() => saveLogImage(image), i * 400))
    }

    const sizeText = (image: LogCaptureImage) => `${image.width}×${image.height} · ${(image.blob.size / 1024 / 1024).toFixed(1)}MB`
</script>

{#if picking && logCapture.start}
    <div class="pointer-events-none absolute inset-x-0 top-2 z-[45] flex justify-center px-3" data-log-capture-bar>
        <div class="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-primary/60 bg-bgcolor/95 py-1.5 pl-3 pr-1.5 text-sm text-textcolor shadow-lg">
            <span aria-hidden="true">✂️</span>
            <span class="min-w-0 truncate">{language.logCapture.pickEnd.replace('{}', messageLabel(logCapture.start.index))}</span>
            <button type="button" class="shrink-0 rounded-full border border-darkborderc px-2.5 py-0.5 text-xs text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor" onclick={cancelLogCapture}>{language.cancel}</button>
        </div>
    </div>
{/if}

{#if logCapture.phase === 'rendering'}
    <div class="pointer-events-none absolute inset-x-0 top-2 z-[45] flex justify-center px-3" data-log-capture-progress>
        <div class="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-darkborderc bg-bgcolor/95 py-1.5 pl-3 pr-1.5 text-sm text-textcolor shadow-lg" aria-live="polite">
            <svg class="h-4 w-4 shrink-0 animate-spin text-primary" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            <span class="min-w-0 truncate">{stageText}{logCapture.total > 1 ? ` ${logCapture.done}/${logCapture.total}` : ''}</span>
            <button type="button" class="shrink-0 rounded-full border border-darkborderc px-2.5 py-0.5 text-xs text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor" onclick={cancelLogCapture}>{language.cancel}</button>
        </div>
    </div>
{/if}

{#if resultOpen}
    <Portal>
        <div class="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-4" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) cancelLogCapture() }}>
            <div class="flex max-h-[92dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-darkborderc bg-bgcolor text-textcolor shadow-2xl sm:rounded-2xl" role="dialog" aria-modal="true" aria-label={language.logCapture.title} data-log-capture-result>
                <header class="flex shrink-0 items-center gap-2 border-b border-darkborderc px-4 py-3">
                    <span aria-hidden="true">✂️</span>
                    <div class="min-w-0 flex-1">
                        <h2 class="text-sm font-semibold">{language.logCapture.title}</h2>
                        {#if logCapture.range}
                            <p class="text-xs text-textcolor2">{formatLogRange(logCapture.range.from, logCapture.range.to, { greeting: language.logCapture.greeting, range: language.logCapture.rangeLabel, single: language.logCapture.singleLabel })}</p>
                        {/if}
                    </div>
                    <button type="button" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor" aria-label={language.close ?? 'Close'} onclick={cancelLogCapture}><XIcon size={18} /></button>
                </header>

                {#if logCapture.phase === 'error'}
                    <p class="px-4 py-6 text-sm text-red-400" role="alert">{language.logCapture.failed}: {logCapture.error}</p>
                {:else}
                    <p class="shrink-0 px-4 pt-3 text-xs" class:text-green-400={logCapture.copy === 'copied'} class:text-textcolor2={logCapture.copy !== 'copied'} aria-live="polite" data-log-capture-status>
                        {#if logCapture.copy === 'copied'}
                            {language.logCapture.copied}
                        {:else if logCapture.copy === 'pending'}
                            {language.logCapture.copying}
                        {:else if logCapture.images.length > 1}
                            {language.logCapture.manyImages.replace('{}', String(logCapture.images.length))}
                        {:else}
                            {language.logCapture.copyManually}
                        {/if}
                    </p>
                    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                        {#each logCapture.images as image, i (image.url)}
                            <figure class="mb-3 last:mb-0">
                                {#if logCapture.images.length > 1}
                                    <figcaption class="mb-1 flex items-center gap-2 text-xs text-textcolor2">
                                        <span class="font-semibold text-textcolor">{i + 1}/{logCapture.images.length}</span>
                                        <span class="min-w-0 flex-1 truncate">{sizeText(image)}</span>
                                        <button type="button" class="flex items-center gap-1 rounded-md border border-darkborderc px-2 py-0.5 transition-colors hover:bg-selected hover:text-textcolor" onclick={() => copyOne(image, i)}>
                                            {#if copiedIndex === i}<CheckIcon size={12} />{:else}<CopyIcon size={12} />{/if}{language.logCapture.copy}
                                        </button>
                                        <button type="button" class="flex items-center gap-1 rounded-md border border-darkborderc px-2 py-0.5 transition-colors hover:bg-selected hover:text-textcolor" onclick={() => saveLogImage(image)}>
                                            <DownloadIcon size={12} />{language.logCapture.save}
                                        </button>
                                    </figcaption>
                                {:else}
                                    <figcaption class="mb-1 text-xs text-textcolor2">{sizeText(image)}</figcaption>
                                {/if}
                                <img src={image.url} alt={language.logCapture.title} class="block w-full rounded-md border border-darkborderc" />
                            </figure>
                        {/each}
                    </div>
                    <footer class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-darkborderc px-4 py-3">
                        {#if logCapture.images.length === 1}
                            <button type="button" class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm text-white transition-colors hover:bg-primary/85" onclick={() => copyOne(logCapture.images[0], 0)}>
                                {#if copiedIndex === 0}<CheckIcon size={16} />{:else}<CopyIcon size={16} />{/if}{language.logCapture.copy}
                            </button>
                        {/if}
                        <button type="button" class="flex items-center gap-1.5 rounded-lg border border-darkborderc px-3 py-1.5 text-sm transition-colors hover:bg-selected" onclick={() => logCapture.images.length === 1 ? saveLogImage(logCapture.images[0]) : saveAll()}>
                            <DownloadIcon size={16} />{logCapture.images.length > 1 ? language.logCapture.saveAll : language.logCapture.save}
                        </button>
                        {#if canShare}
                            <button type="button" class="flex items-center gap-1.5 rounded-lg border border-darkborderc px-3 py-1.5 text-sm transition-colors hover:bg-selected" onclick={() => shareLogImages(logCapture.images)}>
                                <Share2Icon size={16} />{language.logCapture.share}
                            </button>
                        {/if}
                    </footer>
                {/if}
            </div>
        </div>
    </Portal>
{/if}

<style>
    /* The dashed box around the marked start, then around the range being
       captured: each message draws its piece (Chat.svelte data-log-mark). */
    :global(.risu-chat[data-log-mark]) {
        position: relative;
    }
    :global(.risu-chat[data-log-mark]::after) {
        content: '';
        position: absolute;
        inset: 4px 6px;
        border: 2px dashed var(--risu-theme-primary, #3b82f6);
        border-radius: 12px;
        pointer-events: none;
        z-index: 5;
    }
    :global(.risu-chat[data-log-mark='top']::after) {
        bottom: 0;
        border-bottom: 0;
        border-bottom-left-radius: 0;
        border-bottom-right-radius: 0;
    }
    :global(.risu-chat[data-log-mark='middle']::after) {
        top: 0;
        bottom: 0;
        border-top: 0;
        border-bottom: 0;
        border-radius: 0;
    }
    :global(.risu-chat[data-log-mark='bottom']::after) {
        top: 0;
        border-top: 0;
        border-top-left-radius: 0;
        border-top-right-radius: 0;
    }
</style>
