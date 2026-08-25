<script lang="ts">
  import { ChevronLeft, ChevronRight, X, Search as SearchIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import { assetViewerStore, closeAssetViewer } from 'src/ts/assetViewer.svelte'
  import LazyAssetPreview from './LazyAssetPreview.svelte'
  import VirtualGrid from 'src/lib/UI/Virtual/VirtualGrid.svelte'

  let search = $state('')
  let zoomIndex = $state(-1) // index into the filtered list; -1 means grid view
  let swipeStartX: number | null = null
  let focusedPreviewIndex = $state<number | null>(null)

  const filtered = $derived.by(() => {
    const query = search.trim().toLowerCase()
    const indexed = assetViewerStore.items.map((item, i) => ({ ...item, origIndex: i }))
    return query ? indexed.filter((item) => item.name.toLowerCase().includes(query)) : indexed
  })

  const current = $derived(zoomIndex >= 0 ? (filtered[zoomIndex] ?? null) : null)
  const canPrev = $derived(zoomIndex > 0)
  const canNext = $derived(zoomIndex >= 0 && zoomIndex < filtered.length - 1)

  // Navigation drives the scroll position; the scroll handler is the single
  // source of truth for zoomIndex. Buttons/keys scroll, swipes scroll — both
  // converge through onTrackScroll, so there is no index⇄scroll feedback loop.
  function go(offset: -1 | 1) {
    const next = zoomIndex + offset
    if (next >= 0 && next < filtered.length) zoomIndex = next
  }

  function finishSwipe(event: PointerEvent) {
    if (swipeStartX === null || event.pointerType !== 'touch') return
    const delta = event.clientX - swipeStartX
    swipeStartX = null
    if (Math.abs(delta) < 48) return
    if (delta < 0 && canNext) go(1)
    else if (delta > 0 && canPrev) go(-1)
  }

  // Arrows navigate the zoom view; Escape closes the zoom, then the whole viewer.
  $effect(() => {
    if (!assetViewerStore.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (zoomIndex >= 0) zoomIndex = -1
        else closeAssetViewer()
      } else if (zoomIndex >= 0 && e.key === 'ArrowLeft' && canPrev) go(-1)
      else if (zoomIndex >= 0 && e.key === 'ArrowRight' && canNext) go(1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })
</script>

<div class="fixed inset-0 z-50 flex flex-col" style="background: #09090b;">
  <!-- Header: title + search + close -->
  <div class="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-white/10">
    <span class="text-white text-sm font-semibold truncate">{assetViewerStore.title}</span>
    <div class="flex items-center gap-2 ml-auto">
      <div class="relative">
        <SearchIcon size={14} class="absolute left-2 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
        <input
          class="w-40 sm:w-56 pl-7 pr-2 py-1.5 rounded bg-white/5 border border-white/15 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-white/40"
          placeholder={language.search}
          bind:value={search}
        />
      </div>
      <button
        class="w-9 h-9 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
        onclick={closeAssetViewer}
        title={language.goback}
      >
        <X size={16} />
      </button>
    </div>
  </div>

  <!-- Thumbnail grid -->
  <div class="flex-1 min-h-0 p-4">
    {#if filtered.length === 0}
      <div class="h-full flex items-center justify-center text-textcolor2 text-sm">{language.noData}</div>
    {:else}
      <VirtualGrid items={filtered} minItemWidth={112} gap={12} className="h-full" key={(item) => item.origIndex}>
        {#snippet children(item, i)}
          <button
            class="relative group w-full h-full rounded-lg overflow-hidden bg-darkbg border border-darkborderc hover:border-borderc/70 transition-colors"
            onclick={() => (zoomIndex = i)}
            onfocus={() => (focusedPreviewIndex = item.origIndex)}
            onblur={() => { if (focusedPreviewIndex === item.origIndex) focusedPreviewIndex = null }}
          >
            <LazyAssetPreview
              path={item.path}
              kind="image"
              alt={item.name}
              draggableOriginal
              dragFileName={item.name}
              originalIntentActive={focusedPreviewIndex === item.origIndex}
              wrapperClass="w-full h-full"
              mediaClass="w-full h-full object-cover"
            />
            <div class="absolute inset-x-0 bottom-0 pt-6 pb-1.5 px-2 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              <p class="text-white text-[11px] truncate leading-tight">{item.name}</p>
            </div>
          </button>
        {/snippet}
      </VirtualGrid>
    {/if}
  </div>
</div>

<!-- Fullscreen zoom -->
{#if zoomIndex >= 0}
  <div class="fixed inset-0 z-[60]" style="background: #09090b;">
    <!-- Toolbar -->
    <div class="absolute top-0 inset-x-0 z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/70 to-transparent pointer-events-none">
      <div class="flex-1 min-w-0">
        <p class="text-white text-sm font-semibold truncate">{current?.name}</p>
        <p class="text-white/40 text-xs">{zoomIndex + 1} / {filtered.length}</p>
      </div>
      <button
        class="w-9 h-9 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors shrink-0 pointer-events-auto"
        onclick={() => (zoomIndex = -1)}
        title={language.goback}
      >
        <X size={16} />
      </button>
    </div>

    {#if canPrev}
      <button
        class="absolute left-3 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
        onclick={() => go(-1)}
      >
        <ChevronLeft size={22} />
      </button>
    {/if}

    <!-- A single full-size original is mounted. Touch swipes change the index;
         unlike the old scroll-snap track this never creates one blank slide DOM
         node per asset in a 100k-image module. -->
    <div
      role="region"
      aria-label={current?.name || assetViewerStore.title}
      class="w-full h-full flex items-center justify-center px-0 py-2 sm:px-16 sm:py-14 touch-pan-y"
      onpointerdown={(event) => { if (event.pointerType === 'touch') swipeStartX = event.clientX }}
      onpointerup={finishSwipe}
      onpointercancel={() => { swipeStartX = null }}
    >
      {#if current}
        <LazyAssetPreview
          path={current.path}
          kind="image"
          alt={current.name}
          eager
          thumbnail={false}
          draggableOriginal
          dragFileName={current.name}
          wrapperClass="w-full h-full flex items-center justify-center"
          mediaClass="max-w-full max-h-full object-contain shadow-2xl sm:rounded select-none"
        />
      {/if}
    </div>

    {#if canNext}
      <button
        class="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full border border-white/20 bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
        onclick={() => go(1)}
      >
        <ChevronRight size={22} />
      </button>
    {/if}
  </div>
{/if}
