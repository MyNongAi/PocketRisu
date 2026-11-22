<script lang="ts">
    // CHAT-SEARCH (2026-11-22): text-only results for the narrow chat list.
    import { language } from 'src/lang'
    import type { SearchHit, SearchSnapshot } from 'src/ts/gui/chatSearchSource'
    let { snapshot, open }: { snapshot: SearchSnapshot; open: (hit: SearchHit) => void } = $props()
    const groups = $derived((() => {
        const ordered: { id: string; hits: SearchHit[] }[] = []
        for (const hit of snapshot.hits) {
            let group = ordered.find(group => group.id === hit.chatId)
            if (!group) { group = { id: hit.chatId, hits: [] }; ordered.push(group) }
            group.hits.push(hit)
        }
        return ordered
    })())
</script>

<!-- A block, not a flex column: flex items that clip (truncate) would shrink to nothing under max-h-80. -->
<div class="mt-2 max-h-80 overflow-y-auto text-textcolor text-sm" aria-live="polite">
    <div class="sticky top-0 bg-darkbg px-2 py-1 text-textcolor2">
        {language.chatSearchMatches.replace('{}', String(snapshot.count))}
        {#if snapshot.reading} · {language.chatSearchReading.replace('{n}', String(snapshot.done)).replace('{m}', String(snapshot.total))}{/if}
        {#if snapshot.failed} · {language.chatSearchFailed.replace('{n}', String(snapshot.failed))}{/if}
        {#if snapshot.count > 300} · {language.chatSearchLimited}{/if}
    </div>
    {#each groups as group}
        <div class="px-2 pt-2 pb-1 font-semibold truncate">{group.hits[0].chatName}</div>
        {#each group.hits as hit}
            <button class="w-full text-left px-2 py-1 hover:bg-selected border-0 cursor-pointer" onclick={() => open(hit)}>
                <span class="text-textcolor2 text-xs">{hit.role === 'user' ? language.user : language.character} · #{hit.index + 1}</span>
                <span class="block line-clamp-2 break-words">
                    {#each hit.parts as part}<span class:text-primary={part.hit} class:font-semibold={part.hit}>{part.text}</span>{/each}
                </span>
            </button>
        {/each}
    {/each}
    {#if !snapshot.reading && snapshot.count === 0}<div class="p-2 text-textcolor2">{language.chatSearchEmpty}</div>{/if}
</div>
