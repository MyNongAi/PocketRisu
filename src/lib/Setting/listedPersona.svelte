<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon, FolderIcon, ImageIcon, SearchIcon, SettingsIcon, StarIcon, UserRoundIcon, XIcon } from "@lucide/svelte";
    import { language } from "../../lang";
    import { DBState, selectedCharID } from 'src/ts/stores.svelte';
    import { changeUserPersona, ensureBlankPersonaIndex, personaFromBlank, setUserPersonaImage, updatePersonaText, type PersonaTextFields } from "src/ts/persona";
    import { PERSONA_IMAGE_EXTENSIONS } from "src/ts/personaImage";
    import { selectSingleFile } from "src/ts/util";
    import { alertError } from "src/ts/alert";
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

    // One-tap row at the top: "default" (binding only), the blank persona and
    // the favorited personas.
    const favorites = $derived(DBState.db.personas
        .map((persona, index) => ({ persona, index }))
        .filter(({ persona }) => persona.favorite && !persona.nodeOnlyBlank && matches(DBState.db.personas.indexOf(persona))));
    const blankIndex = $derived(DBState.db.personas.findIndex((persona) => persona.nodeOnlyBlank));

    function selectBlank() {
        select(ensureBlankPersonaIndex());
    }

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

    // Binding mode (the chat sidebar): a tap binds the persona and opens the
    // edit tab for it instead of closing; only X (or back/Escape) closes.
    // Editing the blank persona leaves it blank and makes a new persona with
    // the edit, bound to the chat in its place.
    let tab = $state<'list' | 'edit'>('list');
    let editId = $state<string | null>(null);
    $effect.pre(() => {
        if (!bindingMode || editId !== null || boundIndex < 0) return;
        editId = DBState.db.personas[boundIndex]?.id ?? null;
    });
    const editIndex = $derived(editId ? DBState.db.personas.findIndex((persona) => persona.id === editId) : -1);
    const editPersona = $derived(editIndex >= 0 ? DBState.db.personas[editIndex] : null);
    const globalPersonaName = $derived(DBState.db.personas[DBState.db.selectedPersona]?.name || 'User');

    // In the folder grid; the blank persona has its own button above it.
    function listed(index: number) {
        return matches(index) && !DBState.db.personas[index]?.nodeOnlyBlank;
    }

    function select(index: number) {
        if (onSelect) onSelect(index);
        else changeUserPersona(index);
        if (!bindingMode) {
            close();
            return;
        }
        editId = index >= 0 ? (DBState.db.personas[index]?.id ?? null) : null;
        tab = 'edit';
    }

    /** The persona the edit goes to: a new one in place of the blank persona. */
    function editTarget(patch: PersonaTextFields = {}): { index: number; created: boolean } {
        const index = editIndex;
        if (index < 0 || !DBState.db.personas[index]?.nodeOnlyBlank) return { index, created: false };
        const created = personaFromBlank(index, patch);
        if (created >= 0) {
            onSelect?.(created);
            editId = DBState.db.personas[created]?.id ?? null;
        }
        return { index: created, created: true };
    }

    function editText(patch: PersonaTextFields) {
        const { index, created } = editTarget(patch);
        if (index >= 0 && !created) updatePersonaText(index, patch);
    }

    async function changeIcon() {
        if (editIndex < 0) return;
        const picked = await selectSingleFile([...PERSONA_IMAGE_EXTENSIONS]);
        if (!picked) return;
        const { index } = editTarget();
        if (index < 0) return;
        try {
            await setUserPersonaImage(picked.data, index);
        } catch (error) {
            alertError(error);
        }
    }

    function closeFromBackdrop(event: MouseEvent) {
        if (bindingMode) return;
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
            {#if bindingMode}
                <div class="ml-3 flex rounded-md border border-darkborderc p-0.5 text-sm" role="tablist">
                    <button type="button" role="tab" aria-selected={tab === 'list'} class="rounded px-2.5 py-0.5 {tab === 'list' ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:text-textcolor'}" onclick={() => tab = 'list'}>{language.personaBindTabList}</button>
                    <button type="button" role="tab" aria-selected={tab === 'edit'} class="rounded px-2.5 py-0.5 {tab === 'edit' ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:text-textcolor'}" onclick={() => tab = 'edit'}>{language.personaBindTabEdit}</button>
                </div>
            {/if}
            <div class="grow flex justify-end">
                <button type="button" aria-label={language.close} class="cursor-pointer items-center text-textcolor2 hover:text-primary" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>

        {#if bindingMode && tab === 'edit'}
        <div class="min-h-0 flex-1 overflow-y-auto p-4" data-persona-bind-edit>
            {#if !editPersona}
                <p class="text-sm text-textcolor2">{language.personaBindEditInherit.replace('{}', globalPersonaName)}</p>
            {:else}
                <div class="flex flex-wrap items-start gap-4">
                    <button
                        type="button"
                        class="group relative h-28 w-28 shrink-0 overflow-hidden rounded-md border border-darkborderc bg-selected/45 hover:border-primary"
                        title={language.personaBindChangeImage}
                        aria-label={language.personaBindChangeImage}
                        onclick={changeIcon}
                    >
                        {#if editPersona.icon}
                            {#key editPersona.icon}
                                <LazyAssetPreview path={editPersona.icon} kind="image" alt={editPersona.name || 'User'} mediaClass="h-full w-full object-cover" wrapperClass="h-full w-full" rootMargin="160px" />
                            {/key}
                        {:else}
                            <div class="flex h-full w-full items-center justify-center text-textcolor2"><UserRoundIcon size={36} /></div>
                        {/if}
                        <span class="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-darkbg/80 py-0.5 text-[10px] text-textcolor opacity-80 group-hover:opacity-100"><ImageIcon size={12} />{language.personaBindChangeImage}</span>
                    </button>
                    <div class="flex min-w-0 grow basis-48 flex-col gap-3">
                        <label class="flex flex-col gap-1">
                            <span class="text-xs text-textcolor2">{language.name}</span>
                            <input class="risu-field-border rounded-md bg-transparent px-3 py-1.5 text-sm text-textcolor outline-none" placeholder="User" value={editPersona.name} oninput={(e) => editText({ name: e.currentTarget.value })} />
                        </label>
                        {#if DBState.db.personaNote}
                            <label class="flex flex-col gap-1">
                                <span class="text-xs text-textcolor2">{language.note}</span>
                                <input class="risu-field-border rounded-md bg-transparent px-3 py-1.5 text-sm text-textcolor outline-none" value={editPersona.nodeOnlyBlank ? '' : (editPersona.note ?? '')} oninput={(e) => editText({ note: e.currentTarget.value })} />
                            </label>
                        {/if}
                    </div>
                </div>
                <label class="mt-3 flex flex-col gap-1">
                    <span class="text-xs text-textcolor2">{language.description}</span>
                    <textarea class="risu-field-border min-h-48 resize-y rounded-md bg-transparent px-3 py-2 text-sm text-textcolor outline-none" rows="10" placeholder={`Put the description of this persona here.\nExample: [<user> is a 20 year old girl.]`} value={editPersona.personaPrompt} oninput={(e) => editText({ personaPrompt: e.currentTarget.value })}></textarea>
                </label>
                <p class="mt-2 text-xs text-textcolor2">{editPersona.nodeOnlyBlank ? language.personaBindEditBlank : language.personaBindEditShared}</p>
            {/if}
        </div>
        {:else}
        <div class="risu-field-border mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-md px-3">
            <SearchIcon size={16} class="shrink-0 text-textcolor2"/>
            <input bind:value={searchQuery} placeholder={language.personaSearch} class="w-full bg-transparent py-1.5 text-sm text-textcolor outline-none"/>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <div class="mb-3 flex flex-wrap content-start gap-3">
                {#if bindingMode}
                    <button
                        type="button"
                        aria-label={language.memoryPresetInherit}
                        aria-pressed={boundIndex < 0}
                        onclick={() => select(-1)}
                        class={`flex min-h-20 w-20 items-center justify-center rounded-md border p-2 text-center text-xs font-semibold text-textcolor shadow-lg hover:border-primary hover:bg-primary/10
                            ${boundIndex < 0 ? 'border-primary ring-2 ring-primary/40' : 'border-darkborderc bg-selected/20'}`}
                    >
                        {language.memoryPresetInherit}
                    </button>
                {/if}
                <button
                    type="button"
                    aria-label={language.personaBlankBind}
                    title={language.personaBlankBind}
                    aria-pressed={blankIndex >= 0 && blankIndex === highlightIndex}
                    onclick={selectBlank}
                    class={`flex min-h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border p-2 text-center text-xs font-semibold text-textcolor shadow-lg hover:border-primary hover:bg-primary/10
                        ${blankIndex >= 0 && blankIndex === highlightIndex ? 'border-primary ring-2 ring-primary/40' : 'border-darkborderc bg-selected/20'}`}
                >
                    <UserRoundIcon size={20} class="text-textcolor2" />
                    {language.personaBlank}
                </button>
                {#each favorites as { persona, index } (persona.id ?? index)}
                    <button
                        type="button"
                        aria-label={persona.name || 'User'}
                        aria-pressed={index === highlightIndex}
                        onclick={() => select(index)}
                        class={`group relative h-20 w-20 shrink-0 cursor-pointer overflow-hidden rounded-md border bg-selected/20 text-textcolor shadow-lg transition-colors hover:border-primary hover:bg-primary/10
                            ${index === highlightIndex ? 'border-primary ring-2 ring-primary/40' : 'border-darkborderc'}`}
                    >
                        <div class="relative h-full w-full overflow-hidden bg-selected/45">
                            {#if persona.icon}
                                <LazyAssetPreview
                                    path={persona.icon}
                                    kind="image"
                                    alt={persona.name || 'User'}
                                    mediaClass="h-full w-full object-cover"
                                    wrapperClass="h-full w-full"
                                    rootMargin="160px"
                                />
                            {:else}
                                <div class="flex h-full w-full items-center justify-center p-2 text-center text-xs font-semibold leading-tight text-textcolor">
                                    <span class="line-clamp-4 wrap-break-word">{persona.name || 'User'}</span>
                                </div>
                            {/if}
                            <StarIcon size={14} class="absolute right-1 top-1 fill-yellow-400 text-yellow-400" />
                            {#if persona.icon}
                                <span class="absolute inset-x-0 bottom-0 truncate bg-darkbg/80 px-1 text-[10px]">{persona.name || 'User'}</span>
                            {/if}
                        </div>
                    </button>
                {/each}
            </div>

            {#each groups as group (group.folder?.id ?? '')}
                {@const visible = group.indexes.filter(listed)}
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
        {/if}
    </div>
</div>

<style>
    .break-any {
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
