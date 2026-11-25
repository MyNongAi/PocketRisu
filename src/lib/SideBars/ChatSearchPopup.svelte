<script lang="ts">
    // CHAT-SEARCH-POPUP (2026-11-25): one bot's search above the app.
    import { onDestroy, onMount, tick, untrack } from 'svelte'
    import { SearchIcon, XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type { character } from 'src/ts/storage/database.svelte'
    import { ChatSearchSource, chatSearchQueries, type SearchHit, type SearchSnapshot } from 'src/ts/gui/chatSearchSource'
    import { nextSearchIndex, searchEnterIndex } from 'src/ts/gui/searchPopupNav'
    import { BackLayerRank, useBackLayer } from 'src/ts/gui/backLayers.svelte'
    import ChatSearchResults from './ChatSearchResults.svelte'

    let { chara, close, open }: { chara: character; close: () => void; open: (hit: SearchHit) => void } = $props()
    // The popup opens for one bot; its first query is that bot's last one.
    let searchInput = $state(untrack(() => chatSearchQueries.get(chara.chaId) ?? ''))
    let searchQuery = $state(untrack(() => searchInput.trim()))
    let searchSnapshot = $state<SearchSnapshot>({ hits: [], count: 0, done: 0, total: 0, failed: 0, reading: false })
    let highlighted = $state(0)
    let input: HTMLInputElement
    let source: ChatSearchSource | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let searchSerial = 0

    useBackLayer(BackLayerRank.Popup, () => true, () => { close() })

    function clearSearch() {
        clearTimeout(timer)
        searchSerial++
        searchInput = ''
        searchQuery = ''
        chatSearchQueries.delete(chara.chaId)
        source?.dispose()
        source = null
        highlighted = 0
        searchSnapshot = { hits: [], count: 0, done: 0, total: 0, failed: 0, reading: false }
        input?.focus()
    }

    function scheduleSearch() {
        chatSearchQueries.set(chara.chaId, searchInput)
        clearTimeout(timer)
        highlighted = 0
        if (!searchInput.trim()) { clearSearch(); return }
        const serial = ++searchSerial
        searchSnapshot = { hits: [], count: 0, done: 0, total: 0, failed: 0, reading: false }
        timer = setTimeout(() => {
            searchQuery = searchInput.trim()
            source ??= new ChatSearchSource(chara)
            source.search(searchQuery, snapshot => { if (serial === searchSerial) searchSnapshot = snapshot })
        }, 250)
    }

    function openHit(hit: SearchHit) {
        close()
        open(hit)
    }

    function onKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') { event.preventDefault(); close(); return }
        if (event.isComposing) return
        if (event.key === 'Enter' && event.target instanceof HTMLButtonElement) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            highlighted = nextSearchIndex(highlighted, searchSnapshot.hits.length, event.key === 'ArrowDown' ? 1 : -1)
        } else if (event.key === 'Enter') {
            const index = searchEnterIndex(highlighted, searchSnapshot.hits.length)
            if (index >= 0) { event.preventDefault(); openHit(searchSnapshot.hits[index]) }
        }
    }

    function closeFromBackdrop(event: MouseEvent) {
        if (event.target === event.currentTarget) close()
    }

    onMount(async () => {
        await tick()
        input.focus()
        input.select()
        if (searchQuery) scheduleSearch()
    })
    onDestroy(() => {
        clearTimeout(timer)
        source?.dispose()
    })
</script>

<svelte:window onkeydown={onKeydown} />

<div class="fixed inset-0 z-50 flex justify-center bg-black/60 px-3 pt-3 pb-3 sm:items-center sm:p-6" role="presentation" onclick={closeFromBackdrop}>
    <div class="flex w-full max-w-[640px] min-w-0 max-h-[calc(100dvh-1.5rem)] flex-col overflow-hidden rounded-xl border border-darkborderc bg-darkbg text-textcolor shadow-2xl sm:max-h-[min(80dvh,720px)]"
        role="dialog" aria-modal="true" aria-label={language.search}>
        <div class="shrink-0 border-b border-darkborderc p-3 sm:p-4">
            <div class="mb-2 truncate text-xs text-textcolor2">{chara.name}</div>
            <div class="flex min-w-0 items-center gap-2">
                <SearchIcon size={18} class="shrink-0 text-textcolor2" />
                <input bind:this={input} class="min-w-0 flex-1 bg-transparent border-0 p-0 text-base text-textcolor outline-none" type="text" enterkeyhint="search"
                    placeholder={language.search} aria-label={language.search} value={searchInput}
                    oninput={(event) => { searchInput = event.currentTarget.value; scheduleSearch() }} />
                {#if searchInput}<button type="button" class="shrink-0 cursor-pointer text-textcolor2 hover:text-primary" title={language.chatSearchClear} aria-label={language.chatSearchClear} onclick={clearSearch}><XIcon size={16} /></button>{/if}
                <button type="button" class="shrink-0 cursor-pointer text-textcolor2 hover:text-primary" title={language.close} aria-label={language.close} onclick={close}><XIcon size={20} /></button>
            </div>
        </div>
        {#if searchQuery}
            <ChatSearchResults snapshot={searchSnapshot} activeIndex={highlighted} open={openHit} />
        {/if}
    </div>
</div>
