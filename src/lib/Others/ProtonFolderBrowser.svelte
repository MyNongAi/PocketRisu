<script lang="ts">
    // Browse a Proton Drive folder share inside PocketRisu: open subfolders,
    // see Proton's own previews where it has them, and pick files from any
    // number of folders before importing them in one batch.
    import { onDestroy, onMount } from 'svelte'
    import { SvelteMap } from 'svelte/reactivity'
    import {
        ChevronRightIcon, FileIcon, FolderIcon, HardDriveIcon, LoaderCircleIcon,
        PackageIcon, PuzzleIcon, SlidersHorizontalIcon, UserIcon, XIcon,
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import {
        buildProtonRows, closeProtonBrowser, formatProtonSize, protonBrowserState,
        type ProtonPick, type ProtonRow,
    } from 'src/ts/protonBrowser.svelte'
    import {
        fetchProtonThumbnails, inspectProtonShare,
        type ProtonFolderStep, type ProtonInspectResult,
    } from 'src/ts/protonShareClient'

    const url = protonBrowserState.url
    const password = protonBrowserState.password
    const rootName = protonBrowserState.initial?.name ?? ''

    // Listings are cached per folder so going back up is instant.
    const listings = new Map<string, ProtonInspectResult>()
    let listing = $state<ProtonInspectResult | null>(protonBrowserState.initial)
    let trail = $state<ProtonFolderStep[]>(protonBrowserState.initial?.trail ?? [])
    let loading = $state(false)
    let error = $state('')
    let navigation = 0

    const picks = new SvelteMap<string, ProtonPick>()
    const thumbnails = new SvelteMap<string, string>()
    const thumbnailsRequested = new Set<string>()

    const origin = protonBrowserState.origin
    const rows = $derived(buildProtonRows(listing?.entries ?? [], origin))
    const pickableHere = $derived(rows.filter((row) => row.importable))
    const allHerePicked = $derived(pickableHere.length > 0 && pickableHere.every((row) => picks.has(row.entry.linkId)))
    const pathIds = $derived(trail.map((step) => step.linkId))

    const kindLabel: Record<string, () => string> = {
        character: () => language.protonBrowserKind.character,
        module: () => language.protonBrowserKind.module,
        preset: () => language.protonBrowserKind.preset,
        plugin: () => language.protonBrowserKind.plugin,
        unsupported: () => language.protonBrowserUnsupported,
    }

    function loadThumbnails(result: ProtonInspectResult, path: string[]) {
        const wanted = result.entries
            .filter((entry) => entry.type === 2 && entry.hasThumbnail && !thumbnailsRequested.has(entry.linkId))
            .map((entry) => entry.linkId)
        if (wanted.length === 0) return
        for (const id of wanted) thumbnailsRequested.add(id)
        void fetchProtonThumbnails(url, password, path, wanted, (urls) => {
            for (const [id, objectUrl] of urls) thumbnails.set(id, objectUrl)
        })
    }

    async function openFolder(path: string[]) {
        const key = path.join('/')
        const ticket = ++navigation
        error = ''
        const cached = listings.get(key)
        if (cached) {
            listing = cached
            trail = cached.trail
            return
        }
        loading = true
        try {
            const result = await inspectProtonShare(url, password, path)
            listings.set(key, result)
            if (ticket !== navigation) return
            listing = result
            trail = result.trail
            loadThumbnails(result, path)
        } catch (caught) {
            if (ticket === navigation) error = caught instanceof Error ? caught.message : String(caught)
        } finally {
            if (ticket === navigation) loading = false
        }
    }

    function togglePick(row: ProtonRow) {
        if (!row.importable) return
        if (picks.has(row.entry.linkId)) picks.delete(row.entry.linkId)
        else picks.set(row.entry.linkId, { entry: row.entry, path: [...pathIds] })
    }

    function toggleAllHere() {
        if (allHerePicked) {
            for (const row of pickableHere) picks.delete(row.entry.linkId)
        } else {
            for (const row of pickableHere) {
                if (!picks.has(row.entry.linkId)) picks.set(row.entry.linkId, { entry: row.entry, path: [...pathIds] })
            }
        }
    }

    function finish(confirmed: boolean) {
        closeProtonBrowser(confirmed ? [...picks.values()] : null)
    }

    function onKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.stopPropagation()
            finish(false)
        }
    }

    onMount(() => {
        if (listing) {
            listings.set(pathIds.join('/'), listing)
            loadThumbnails(listing, [...pathIds])
        }
    })

    onDestroy(() => {
        navigation++
        for (const objectUrl of thumbnails.values()) URL.revokeObjectURL(objectUrl)
    })
</script>

<svelte:window onkeydown={onKeydown} />

<div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3"
    role="presentation"
    onclick={(event) => { if (event.target === event.currentTarget) finish(false) }}
>
    <div
        class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-darkborderc bg-bgcolor text-textcolor shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={language.protonBrowserTitle}
    >
        <div class="flex items-center gap-2 border-b border-darkborderc px-4 py-3">
            <HardDriveIcon size={18} class="shrink-0 text-textcolor2" />
            <h2 class="min-w-0 grow truncate text-base font-semibold">{language.protonBrowserTitle}</h2>
            <button class="rounded p-1 text-textcolor2 hover:text-textcolor" aria-label={language.close} onclick={() => finish(false)}>
                <XIcon size={18} />
            </button>
        </div>

        <nav class="flex min-w-0 flex-wrap items-center gap-1 border-b border-darkborderc px-4 py-2 text-sm" aria-label={language.protonBrowserTitle}>
            <button
                class="max-w-[12rem] truncate rounded px-1.5 py-0.5 hover:bg-selected"
                class:font-semibold={trail.length === 0}
                onclick={() => openFolder([])}
            >{rootName}</button>
            {#each trail as step, index (step.linkId)}
                <ChevronRightIcon size={14} class="shrink-0 text-textcolor2" />
                <button
                    class="max-w-[12rem] truncate rounded px-1.5 py-0.5 hover:bg-selected"
                    class:font-semibold={index === trail.length - 1}
                    onclick={() => openFolder(trail.slice(0, index + 1).map((s) => s.linkId))}
                >{step.name}</button>
            {/each}
        </nav>

        <div class="flex items-center gap-3 px-4 py-2 text-sm text-textcolor2">
            <label class="flex cursor-pointer items-center gap-2" class:opacity-50={pickableHere.length === 0}>
                <input
                    type="checkbox"
                    class="h-4 w-4 accent-[var(--risu-theme-primary)]"
                    checked={allHerePicked}
                    disabled={pickableHere.length === 0}
                    onchange={toggleAllHere}
                />
                {language.protonBrowserSelectAll}
            </label>
            <span class="ml-auto">{language.protonBrowserSelected(picks.size)}</span>
        </div>

        <div class="min-h-[12rem] grow overflow-y-auto px-2 pb-2">
            {#if loading}
                <div class="flex items-center justify-center gap-2 py-10 text-sm text-textcolor2">
                    <LoaderCircleIcon size={16} class="animate-spin" />{language.protonBrowserLoading}
                </div>
            {:else if error}
                <div class="flex flex-col items-center gap-3 py-10 text-sm">
                    <span class="text-red-400">{error}</span>
                    <ShButton variant="outline" size="sm" onclick={() => openFolder([...pathIds])}>{language.protonBrowserRetry}</ShButton>
                </div>
            {:else if rows.length === 0}
                <div class="py-10 text-center text-sm text-textcolor2">{language.protonBrowserEmpty}</div>
            {:else}
                <ul class="flex flex-col">
                    {#each rows as row (row.entry.linkId)}
                        <li>
                            {#if row.kind === 'folder'}
                                <button
                                    class="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-selected"
                                    onclick={() => openFolder([...pathIds, row.entry.linkId])}
                                >
                                    <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-darkbg text-amber-400">
                                        <FolderIcon size={20} />
                                    </span>
                                    <span class="min-w-0 grow truncate text-sm">{row.entry.name}</span>
                                    <ChevronRightIcon size={16} class="shrink-0 text-textcolor2" />
                                </button>
                            {:else}
                                <label
                                    class="flex w-full items-center gap-3 rounded-md px-2 py-2 {row.importable ? 'cursor-pointer hover:bg-selected' : 'opacity-50'}"
                                >
                                    <input
                                        type="checkbox"
                                        class="h-4 w-4 shrink-0 accent-[var(--risu-theme-primary)]"
                                        checked={picks.has(row.entry.linkId)}
                                        disabled={!row.importable}
                                        onchange={() => togglePick(row)}
                                    />
                                    {#if thumbnails.get(row.entry.linkId)}
                                        <img src={thumbnails.get(row.entry.linkId)} alt="" class="h-10 w-10 shrink-0 rounded-md bg-darkbg object-cover" />
                                    {:else}
                                        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-darkbg text-textcolor2">
                                            {#if row.kind === 'character'}<UserIcon size={20} />
                                            {:else if row.kind === 'module'}<PackageIcon size={20} />
                                            {:else if row.kind === 'preset'}<SlidersHorizontalIcon size={20} />
                                            {:else if row.kind === 'plugin'}<PuzzleIcon size={20} />
                                            {:else}<FileIcon size={20} />{/if}
                                        </span>
                                    {/if}
                                    <span class="flex min-w-0 grow flex-col">
                                        <span class="truncate text-sm" title={row.entry.name}>{row.entry.name}</span>
                                        <span class="text-xs text-textcolor2">
                                            {[kindLabel[row.kind]?.(), formatProtonSize(row.entry.size)].filter(Boolean).join(' · ')}
                                        </span>
                                    </span>
                                </label>
                            {/if}
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>

        <div class="flex items-center justify-end gap-2 border-t border-darkborderc px-4 py-3">
            <ShButton variant="outline" size="sm" onclick={() => finish(false)}>{language.cancel}</ShButton>
            <ShButton variant="primary" size="sm" disabled={picks.size === 0} onclick={() => finish(true)}>
                {language.protonBrowserImport(picks.size)}
            </ShButton>
        </div>
    </div>
</div>
