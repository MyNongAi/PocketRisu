<script lang="ts">
    // One character row in the manager. The header line opens the character;
    // the ⋯ menu content comes from the parent (order-mode items differ).
    import type { Snippet } from "svelte";
    import { ArchiveIcon, EllipsisVerticalIcon, EyeOffIcon, MessageSquareIcon } from "@lucide/svelte";
    import ShDropdownMenu from "src/lib/UI/GUI/ShDropdownMenu.svelte";
    import ShDropdownMenuTrigger from "src/lib/UI/GUI/ShDropdownMenuTrigger.svelte";
    import ShDropdownMenuContent from "src/lib/UI/GUI/ShDropdownMenuContent.svelte";
    import { getCharImage } from "src/ts/characters";
    import { makeAgoText } from "src/ts/util";
    import { DBState } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import type { ManagerEntry } from "src/ts/characterManager";
    import { listTitleColor } from "src/ts/gui/titleColors";

    interface Props {
        entry: ManagerEntry;
        selectable?: boolean;
        selected?: boolean;
        active?: boolean;
        similarityCount?: number;
        duplicateCount?: number | null;
        onOpen: (entry: ManagerEntry) => void;
        onToggleSelect?: (entry: ManagerEntry) => void;
        menu?: Snippet<[ManagerEntry]>;
    }

    let { entry, selectable = false, selected = false, active = false, similarityCount = 0, duplicateCount = null, onOpen, onToggleSelect, menu }: Props = $props();

    function activate() {
        if (selectable) onToggleSelect?.(entry);
        else onOpen(entry);
    }

    let sourceBadgeLabel = $derived(`[${entry.sourceBadge}]`);
    let sourceBadgeTitle = $derived(entry.sourceRecorded
        ? `기록된 출처: ${entry.sourceBadge}`
        : '출처 기록 없음 · 기존 웹리스 기준');
    let missingAssetTitle = $derived(entry.realmRecoveryAvailable
        ? `에셋 ${entry.missingAssetCount}개 누락 · Realm 복구 가능`
        : `에셋 ${entry.missingAssetCount}개 누락 · 확인된 Realm 복구 원본 없음`);

    // yy.mm.dd — compact enough to sit at the end of the metrics line.
    // Cards imported before the field existed have no date to show.
    let importedLabel = $derived.by(() => {
        if (!entry.importedAt) return '';
        const d = new Date(entry.importedAt);
        if (Number.isNaN(d.getTime())) return '';
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${pad(d.getFullYear() % 100)}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
    });
</script>

<div
    class="flex items-center gap-2.5 rounded-md px-2 min-h-12 py-1 text-textcolor cursor-pointer select-none {active ? 'bg-selected' : 'risu-interactive-surface'}"
    class:opacity-60={entry.archived}
    role="button" tabindex="0"
    onclick={activate}
    onkeydown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    }}
>
    {#if selectable}
        <input type="checkbox" class="no-sort shrink-0 h-4 w-4 accent-[var(--risu-theme-primary)]" checked={selected} tabindex="-1" onclick={(e) => { e.stopPropagation(); onToggleSelect?.(entry) }} />
    {/if}
    <div class="relative shrink-0" class:grayscale={entry.archived}>
        {#await getCharImage(entry.image, 'plain')}
            <div class="h-10 w-10 bg-skin-border" class:rounded-md={!DBState.db.roundIcons} class:rounded-full={DBState.db.roundIcons}></div>
        {:then src}
            <img src={src || '/none.webp'} alt="" class="h-10 w-10 object-cover object-top bg-skin-border" class:rounded-md={!DBState.db.roundIcons} class:rounded-full={DBState.db.roundIcons} />
        {/await}
        {#if entry.archived}
            <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50" class:rounded-md={!DBState.db.roundIcons} class:rounded-full={DBState.db.roundIcons}>
                <ArchiveIcon size={16} class="text-white/90" />
            </div>
        {/if}
        {#if entry.missingAssetCount > 0}
            {#if entry.realmRecoveryAvailable}
                <span class="pointer-events-none absolute -right-1 -top-1 z-10 rounded-full bg-darkbg px-1 text-sm font-black leading-none text-emerald-400 drop-shadow" aria-label={missingAssetTitle} title={missingAssetTitle}>!</span>
            {:else}
                <span class="pointer-events-none absolute -right-1 -top-1 z-10 text-sm leading-none drop-shadow" aria-label={missingAssetTitle} title={missingAssetTitle}>❗</span>
            {/if}
        {/if}
        <span
            class="pointer-events-none absolute -bottom-1 -left-1 z-10 rounded border border-darkborderc bg-darkbg/95 px-0.5 text-[8px] font-semibold leading-tight"
            class:text-sky-300={entry.sourceBadge === '로컬'}
            class:text-violet-300={entry.sourceBadge === '웹'}
            class:text-emerald-300={entry.sourceBadge === '모바일'}
            class:border-dashed={!entry.sourceRecorded}
            title={sourceBadgeTitle}
        >{sourceBadgeLabel}</span>
    </div>
    <div class="flex-1 min-w-0 flex flex-col">
        <div class="flex items-center gap-1.5 min-w-0">
            <span class="truncate text-sm font-medium" style:color={listTitleColor(entry.titleColor, entry.missingAssetCount > 0)}>{entry.name}</span>
            {#if entry.hidden}
                <span class="shrink-0 inline-flex items-center gap-0.5 rounded border border-darkborderc px-1 py-0.5 text-[10px] leading-none text-textcolor2" title={language.hiddenFromSidebarHint}>
                    <EyeOffIcon size={10} />{language.hiddenBadge}
                </span>
            {/if}
            {#if entry.archived}
                <span class="shrink-0 inline-flex items-center gap-0.5 rounded border border-darkborderc px-1 py-0.5 text-[10px] leading-none text-textcolor2">
                    <ArchiveIcon size={10} />{language.deactivatedBadge}
                </span>
            {/if}
        </div>
        <div class="flex flex-wrap items-center gap-1 text-xs text-textcolor2">
            <span>{entry.chatCount}</span>
            <MessageSquareIcon size={12} />
            {#if entry.lastInteraction > 0}
                <span class="mx-1">|</span>
                <span>{makeAgoText(entry.lastInteraction)}</span>
            {/if}
            <span class="mx-1">|</span>
            <span>{language.characterAssetCountLabel(entry.assetCount)}</span>
            {#if entry.missingAssetCount > 0}
                <span class="mx-1">|</span>
                <span class="text-red-400">누락 {entry.missingAssetCount.toLocaleString()}개</span>
            {/if}
            {#if similarityCount > 0}
                <span class="mx-1">|</span>
                <span title="이름 유사도 90% 이상 후보">{language.characterSimilarityCountLabel(similarityCount)}</span>
            {/if}
            {#if duplicateCount !== null && duplicateCount > 0}
                <span class="mx-1">|</span>
                <span>{language.characterDuplicateCountLabel(duplicateCount)}</span>
            {/if}
            {#if importedLabel}
                <span class="mx-1">|</span>
                <span title={language.characterImportedAtHint}>{importedLabel}</span>
            {/if}
        </div>
    </div>
    {#if menu}
        <ShDropdownMenu>
            <ShDropdownMenuTrigger>
                {#snippet child({ props })}
                    <button {...props} class="no-sort shrink-0 p-1 rounded text-textcolor2 risu-interactive-accent" aria-label="menu"
                        onclick={(e) => { e.stopPropagation(); (props as { onclick?: (e: MouseEvent) => void }).onclick?.(e) }}>
                        <EllipsisVerticalIcon size={16} />
                    </button>
                {/snippet}
            </ShDropdownMenuTrigger>
            <ShDropdownMenuContent align="end" class="min-w-44 z-[45]">
                {@render menu(entry)}
            </ShDropdownMenuContent>
        </ShDropdownMenu>
    {/if}
</div>
