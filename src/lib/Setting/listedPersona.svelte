<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon, FolderIcon, SearchIcon, SettingsIcon, XIcon } from "@lucide/svelte";
    import { language } from "../../lang";
    import { DBState, selectedCharID } from 'src/ts/stores.svelte';
    import { changeUserPersona } from "src/ts/persona";
    import { groupByFolder } from "src/ts/folders";
    import { openSettings, SettingsRoute } from "src/ts/routing";
    import LazyAssetPreview from "src/lib/Others/LazyAssetPreview.svelte";

    interface Props {
        close?: () => void;
        onSelect?: ((index: number) => void) | null;
    }

    let { close = () => {}, onSelect = null }: Props = $props();
    let searchQuery = $state('');
    let expanded = $state<Set<string>>(new Set());

    const query = $derived(searchQuery.trim().toLocaleLowerCase());
    const bindingMode = $derived(onSelect !== null);
    const boundIndex = $derived.by(() => {
        if (!bindingMode) return -1;
        const char = DBState.db.characters?.[$selectedCharID];
        const id = char?.chats?.[char?.chatPage]?.bindedPersona;
        return id ? DBState.db.personas.findIndex((persona) => persona.id === id) : -1;
    });
    const highlightIndex = $derived(bindingMode ? boundIndex : DBState.db.selectedPersona);
    const groups = $derived(groupByFolder(
        DBState.db.personas.map((persona) => persona.folderId),
        DBState.db.personaFolders ?? [],
    ));

    function toggle(key: string) {
        const next = new Set(expanded);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        expanded = next;
    }

    function matches(index: number) {
        const persona = DBState.db.personas[index];
        return !query || `${persona.name ?? ''}\n${persona.note ?? ''}`.toLocaleLowerCase().includes(query);
    }

    function select(index: number) {
        if (onSelect) onSelect(index);
        else changeUserPersona(index);
        close();
    }

    function closeFromBackdrop(event: MouseEvent) {
        if (event.target === event.currentTarget) close();
    }

    function closeFromKeyboard(event: KeyboardEvent) {
        if (event.key === 'Escape') close();
    }
</script>

<svelte:window onkeydown={closeFromKeyboard} />

<div
    class="absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-3 sm:p-6"
    role="presentation"
    onclick={closeFromBackdrop}
>
    <div
        class="break-any flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-darkborderc bg-darkbg shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={language.persona}
    >
        <div class="flex shrink-0 items-center border-b border-darkborderc px-4 py-3 text-textcolor">
            <h2 class="mt-0 mb-0 font-bold">{language.persona}</h2>
            <div class="grow flex justify-end">
                <button type="button" aria-label={language.close} class="cursor-pointer items-center text-textcolor2 hover:text-primary" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>

        <div class="risu-field-border mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-md px-3">
            <SearchIcon size={16} class="shrink-0 text-textcolor2"/>
            <input bind:value={searchQuery} placeholder={language.personaSearch} class="w-full bg-transparent py-1.5 text-sm text-textcolor outline-none"/>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-4">
            {#if bindingMode}
                <button
                    type="button"
                    aria-label={language.memoryPresetInherit}
                    aria-pressed={boundIndex < 0}
                    onclick={() => select(-1)}
                    class={`mb-3 flex min-h-20 w-20 items-center justify-center rounded-md border p-2 text-center text-xs font-semibold text-textcolor shadow-lg hover:border-primary hover:bg-primary/10
                        ${boundIndex < 0 ? 'border-primary ring-2 ring-primary/40' : 'border-darkborderc bg-selected/20'}`}
                >
                    {language.memoryPresetInherit}
                </button>
            {/if}

            {#each groups as group (group.folder?.id ?? '')}
                {@const visible = group.indexes.filter(matches)}
                {@const key = group.folder?.id ?? ''}
                {@const open = !!query || (key === '' ? !expanded.has(key) : expanded.has(key))}
                {#if visible.length > 0}
                    <button
                        type="button"
                        class="mt-1 flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-2 text-textcolor hover:bg-selected/30"
                        onclick={() => toggle(key)}
                    >
                        {#if open}<ChevronDownIcon size={16} class="shrink-0 text-textcolor2"/>{:else}<ChevronRightIcon size={16} class="shrink-0 text-textcolor2"/>{/if}
                        <FolderIcon size={16} class="shrink-0 text-textcolor2"/>
                        <span class="grow truncate text-left {group.folder ? '' : 'text-textcolor2'}">{group.folder?.name ?? language.folderUncategorized}</span>
                        <span class="text-xs text-textcolor2">{visible.length}</span>
                    </button>

                    {#if open}
                        <div class="flex content-start flex-wrap gap-3 px-2 pb-3 pt-1">
                            {#each visible as i}
                                {@const persona = DBState.db.personas[i]}
                                <button
                                    type="button"
                                    aria-label={persona.name || 'User'}
                                    aria-pressed={i === highlightIndex}
                                    onclick={() => select(i)}
                                    class={`group relative h-20 w-20 shrink-0 cursor-pointer overflow-hidden rounded-md border bg-selected/20 text-textcolor shadow-lg transition-colors hover:border-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary
                                        ${i === highlightIndex ? 'border-primary ring-2 ring-primary/40' : 'border-darkborderc'}`}
                                >
                                    <div class="relative h-full w-full overflow-hidden bg-selected/45">
                                        {#if persona.icon}
                                            <LazyAssetPreview
                                                path={persona.icon}
                                                kind="image"
                                                alt={persona.name || 'User'}
                                                mediaClass="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                                                wrapperClass="h-full w-full"
                                                rootMargin="160px"
                                            />
                                        {:else}
                                            <div class="flex h-full w-full items-center justify-center p-2 text-center text-xs font-semibold leading-tight text-textcolor">
                                                <span class="line-clamp-4 wrap-break-word">{persona.name || 'User'}</span>
                                            </div>
                                        {/if}
                                        {#if persona.sourceInfo?.label}
                                            <span class="absolute right-1 bottom-1 max-w-[calc(100%-0.5rem)] truncate rounded-full bg-darkbg/85 px-1.5 py-0.5 text-[9px] text-textcolor">
                                                {persona.sourceInfo.label}
                                            </span>
                                        {/if}
                                    </div>
                                </button>
                            {/each}
                        </div>
                    {/if}
                {/if}
            {/each}
        </div>

        <button
            type="button"
            class="mx-4 mb-3 flex shrink-0 cursor-pointer items-center gap-2 border-t border-darkborderc pt-2 text-sm text-textcolor2 hover:text-primary"
            onclick={() => { close(); openSettings(SettingsRoute.Persona); }}
        >
            <SettingsIcon size={16}/><span>{language.personaManage}</span>
        </button>
    </div>
</div>

<style>
    .break-any {
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
