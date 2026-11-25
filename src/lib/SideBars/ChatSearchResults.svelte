<script lang="ts">
    // CHAT-SEARCH (2026-11-22): text-only results grouped by chat.
    import { language } from 'src/lang'
    import type { SearchHit, SearchSnapshot } from 'src/ts/gui/chatSearchSource'
    let { snapshot, activeIndex, open }: { snapshot: SearchSnapshot; activeIndex: number; open: (hit: SearchHit) => void } = $props()
    let results: HTMLDivElement
    const groups = $derived((() => {
        const ordered: { id: string; hits: { hit: SearchHit; index: number }[] }[] = []
        for (const [index, hit] of snapshot.hits.entries()) {
            let group = ordered.find(group => group.id === hit.chatId)
            if (!group) { group = { id: hit.chatId, hits: [] }; ordered.push(group) }
            group.hits.push({ hit, index })
        }
        return ordered
    })())
    $effect(() => {
        activeIndex
        snapshot.hits
        if (!results) return
        const selected = results.querySelector<HTMLElement>('[data-search-active="true"]')
        if (!selected) return
        const top = selected.offsetTop - results.offsetTop
        if (top < results.scrollTop) results.scrollTop = top
        else if (top + selected.offsetHeight > results.scrollTop + results.clientHeight) {
            results.scrollTop = top + selected.offsetHeight - results.clientHeight
        }
    })
</script>

<div class="min-h-0 flex-1 overflow-y-auto text-textcolor text-sm" aria-live="polite" bind:this={results}>
    <div class="sticky top-0 bg-darkbg px-2 py-1 text-textcolor2">
        {language.chatSearchMatches.replace('{}', String(snapshot.count))}
        {#if snapshot.reading} · {language.chatSearchReading.replace('{n}', String(snapshot.done)).replace('{m}', String(snapshot.total))}{/if}
        {#if snapshot.failed} · {language.chatSearchFailed.replace('{n}', String(snapshot.failed))}{/if}
        {#if snapshot.count > 300} · {language.chatSearchLimited}{/if}
    </div>
    {#each groups as group}
        <div class="px-2 pt-2 pb-1 font-semibold truncate">{group.hits[0].hit.chatName}</div>
        {#each group.hits as { hit, index }}
            <button class="w-full text-left px-2 py-1 hover:bg-selected border-0 cursor-pointer" class:bg-selected={index === activeIndex} data-search-active={index === activeIndex} aria-current={index === activeIndex ? 'true' : undefined} onclick={() => open(hit)}>
                <span class="text-textcolor2 text-xs">{hit.role === 'user' ? language.user : language.character} · #{hit.index + 1}</span>
                <span class="block line-clamp-2 break-words">
                    {#each hit.parts as part}<span class:text-primary={part.hit} class:font-semibold={part.hit}>{part.text}</span>{/each}
                </span>
            </button>
        {/each}
    {/each}
    {#if !snapshot.reading && snapshot.count === 0}<div class="p-2 text-textcolor2">{language.chatSearchEmpty}</div>{/if}
</div>
