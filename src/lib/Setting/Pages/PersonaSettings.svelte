<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import FolderedList, { type FolderedItemPlacement } from "src/lib/UI/FolderedList.svelte";
    import { Grid3X3Icon, HardDriveUploadIcon, ListIcon, PlusIcon, StarIcon } from "@lucide/svelte";
    import { alertConfirm } from "src/ts/alert";
    import { getCharImage } from "src/ts/characters";
    import { changeUserPersona, exportUserPersona, importUserPersona, saveUserPersona, selectUserImg } from "src/ts/persona";
    import { onDestroy } from "svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { v4 } from "uuid"
    import { groupByFolder } from "src/ts/folders";
    import LazyAssetPreview from "src/lib/Others/LazyAssetPreview.svelte";

    // selectedPersona can point past the array (persona removed by a plugin or
    // stale index in an imported DB) — clamp before the template dereferences it.
    if(!DBState.db.personas[DBState.db.selectedPersona] && DBState.db.personas.length > 0){
        DBState.db.selectedPersona = 0
    }

    // Tapping a row activates that persona and expands the editor inline
    // beneath it (same pattern as the plugin page). The editor edits the DB
    // top-level persona fields (username/personaPrompt/...), which always
    // mirror the *selected* persona — so only the selected row can be open.
    let expanded = $state(false)

    type PersonaViewMode = 'grid' | 'list'
    function loadPersonaViewMode(): PersonaViewMode {
        try {
            const saved = localStorage.getItem('risu-persona-settings-view')
            return saved === 'list' ? 'list' : 'grid'
        } catch {
            return 'grid'
        }
    }
    let viewMode = $state<PersonaViewMode>(loadPersonaViewMode())

    function setViewMode(next: PersonaViewMode) {
        viewMode = next
        try { localStorage.setItem('risu-persona-settings-view', next) } catch {}
    }

    const folders = $derived(DBState.db.personaFolders ?? [])
    const personaGroups = $derived(groupByFolder(
        DBState.db.personas.map((persona) => persona.folderId),
        folders,
    ))

    function ensureId(persona: typeof DBState.db.personas[number]) {
        persona.id ??= v4()
        return persona.id
    }

    function toggleRow(index: number) {
        if (index === DBState.db.selectedPersona) {
            expanded = !expanded
            if (!expanded) saveUserPersona()
            return
        }
        changeUserPersona(index)
        expanded = true
    }

    function selectGridPersona(index: number) {
        if(index !== DBState.db.selectedPersona) changeUserPersona(index)
        expanded = true
    }

    /** Rebuilds `db.personas` from the list's reported order/folder membership. */
    function applyPlacements(placements: FolderedItemPlacement[]) {
        saveUserPersona()
        const personas = DBState.db.personas
        const selectedId = ensureId(personas[DBState.db.selectedPersona])
        const next = placements.map(({ index, folderId }) => ({ ...personas[index], folderId }))
        if (next.length !== personas.length) return
        DBState.db.personas = next
        changeUserPersona(Math.max(0, next.findIndex(p => p.id === selectedId)), 'noSave')
        void requestImmediateSave()
    }

    function createPersona() {
        saveUserPersona()
        DBState.db.personas = [...DBState.db.personas, {
            id: v4(),
            name: 'New Persona',
            icon: '',
            personaPrompt: '',
            note: '',
        }]
        changeUserPersona(DBState.db.personas.length - 1, 'noSave')
        expanded = true
        void requestImmediateSave()
    }

    async function importPersona() {
        saveUserPersona()
        const before = DBState.db.personas.length
        await importUserPersona()
        if (DBState.db.personas.length > before) changeUserPersona(DBState.db.personas.length - 1, 'noSave')
        void requestImmediateSave()
    }

    function duplicatePersona(index: number) {
        saveUserPersona()
        const clone = $state.snapshot(DBState.db.personas[index])
        DBState.db.personas = [...DBState.db.personas, { ...clone, name: clone.name + ' (Copy)', id: v4() }]
        void requestImmediateSave()
    }

    async function exportPersona(index: number) {
        saveUserPersona()
        await exportUserPersona(index)
    }

    async function deletePersona(index: number) {
        const persona = DBState.db.personas[index]
        if (!persona || DBState.db.personas.length === 1) return
        if (!await alertConfirm(`${language.removeConfirm}${persona.name}`)) return
        saveUserPersona()
        const selected = DBState.db.personas[DBState.db.selectedPersona]
        const next = DBState.db.personas.filter((_, i) => i !== index)
        DBState.db.personas = next
        const selectedIndex = next.indexOf(selected)
        changeUserPersona(selectedIndex >= 0 ? selectedIndex : 0, 'noSave')
        // Don't pop open whichever persona became selected after the removal.
        if (selectedIndex < 0) expanded = false
        void requestImmediateSave()
    }

    onDestroy(() => {
        saveUserPersona()
    })
</script>

{#snippet personaEditor(index: number)}
    {@const persona = DBState.db.personas[index]}
    <div class="flex flex-wrap gap-4 bg-dark-900/50 p-3 rounded-md">
        <button class="shrink-0 self-start" onclick={() => {selectUserImg()}}>
            {#if DBState.db.userIcon === ''}
                <div class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary"></div>
            {:else}
                {#await getCharImage(DBState.db.userIcon, persona.largePortrait ? 'lgcss' : 'css')}
                    <div class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary"></div>
                {:then im}
                    <div class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" style={im}></div>
                {/await}
            {/if}
        </button>
        <div class="flex grow flex-col min-w-0 basis-64">
            <span class="text-sm text-textcolor2">{language.name} <Help key="personaName" /></span>
            <TextInput className="mt-2" marginBottom placeholder="User" bind:value={DBState.db.username}/>
            <span class="text-sm text-textcolor2">{language.note} <Help key="personaNote" /></span>
            {#if DBState.db.personaNote}
                <TextInput className="mt-2" marginBottom bind:value={DBState.db.userNote} placeholder={`Put a unique identifier for this persona here.\nExample: [Alternate Hunters persona]`} />
            {/if}
            <span class="text-sm text-textcolor2">{language.description} <Help key="personaDescription" /></span>
            <TextAreaInput className="mt-2 mb-4" autocomplete="off" bind:value={DBState.db.personaPrompt} placeholder={`Put the description of this persona here.\nExample: [<user> is a 20 year old girl.]`} />
            <div class="flex gap-2 max-w-full flex-wrap items-center">
                <ShButton size="sm" variant="outline" onclick={() => exportPersona(index)}>{language.export}</ShButton>
                <ShButton size="sm" variant="outline" onclick={() => {
                    duplicatePersona(index)
                    changeUserPersona(DBState.db.personas.length - 1, 'noSave')
                }}>{language.personaDuplicate}</ShButton>
                <ShButton size="sm" variant="destructive" onclick={() => deletePersona(index)}>{language.remove}</ShButton>
                <Check bind:check={DBState.db.personas[DBState.db.selectedPersona].largePortrait} name={language.largePortrait}/>
                <Help key="personaLargePortrait" />
            </div>
        </div>
    </div>
{/snippet}

<SettingPage title={language.persona}>
    <div class="mb-2 flex justify-end gap-1" aria-label={language.persona}>
        <ShButton
            size="sm"
            variant={viewMode === 'grid' ? 'default' : 'outline'}
            onclick={() => setViewMode('grid')}
            title={language.grid}
        ><Grid3X3Icon />{language.grid}</ShButton>
        <ShButton
            size="sm"
            variant={viewMode === 'list' ? 'default' : 'outline'}
            onclick={() => setViewMode('list')}
            title={language.list}
        ><ListIcon />{language.list}</ShButton>
    </div>

    {#if viewMode === 'grid'}
        <div class="mb-2 flex flex-wrap gap-2">
            <ShButton size="sm" onclick={createPersona}><PlusIcon />{language.createfromScratch}</ShButton>
            <ShButton size="sm" variant="outline" onclick={importPersona}><HardDriveUploadIcon />{language.import}</ShButton>
        </div>

        <div class="persona-grid-catalog rounded-md border border-darkborderc p-3">
            {#each personaGroups as group (group.folder?.id ?? '')}
                {#if group.indexes.length > 0}
                    <div class="mb-2 mt-1 flex items-center gap-2 text-sm text-textcolor2">
                        <span class="truncate">{group.folder?.name ?? language.folderUncategorized}</span>
                        <span class="text-xs">{group.indexes.length}</span>
                    </div>
                    <div class="mb-4 flex flex-wrap content-start gap-3">
                        {#each group.indexes as index}
                            {@const persona = DBState.db.personas[index]}
                            <button
                                type="button"
                                aria-label={persona.name || 'User'}
                                aria-pressed={index === DBState.db.selectedPersona}
                                onclick={() => selectGridPersona(index)}
                                class="group flex w-24 shrink-0 cursor-pointer flex-col items-center gap-1 rounded-md p-1 text-textcolor hover:bg-selected/30"
                            >
                                <div class={`relative h-20 w-20 overflow-hidden rounded-md border bg-selected/45 shadow-lg transition-colors group-hover:border-primary ${index === DBState.db.selectedPersona ? 'border-primary ring-2 ring-primary/40' : 'border-darkborderc'}`}>
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
                                    {#if index === DBState.db.selectedPersona}
                                        <StarIcon size={14} class="absolute right-1 top-1 text-primary" />
                                    {/if}
                                </div>
                                <span class="w-full truncate text-center text-xs">{persona.name || 'User'}</span>
                            </button>
                        {/each}
                    </div>
                {/if}
            {/each}
        </div>

        {#if DBState.db.personas[DBState.db.selectedPersona]}
            <div class="persona-grid-detail mt-3" aria-label="선택한 페르소나 정보">
                {@render personaEditor(DBState.db.selectedPersona)}
            </div>
        {/if}
    {:else}
    <FolderedList
        {folders}
        itemFolderIds={DBState.db.personas.map(p => p.folderId)}
        itemSearchTexts={DBState.db.personas.map(p => `${p.name ?? ''}\n${p.note ?? ''}`)}
        searchPlaceholder={language.personaSearch}
        selectedIndex={DBState.db.selectedPersona}
        isExpanded={(index) => expanded && index === DBState.db.selectedPersona}
        storageKey="risu-persona-folders-collapsed"
        onSelect={toggleRow}
        onItemsChange={applyPlacements}
        onFoldersChange={(next) => { DBState.db.personaFolders = next; void requestImmediateSave() }}
        onDuplicate={duplicatePersona}
        onExport={exportPersona}
        onDelete={deletePersona}
    >
        {#snippet actions()}
            <ShButton size="sm" onclick={createPersona}><PlusIcon />{language.createfromScratch}</ShButton>
            <ShButton size="sm" variant="outline" onclick={importPersona}><HardDriveUploadIcon />{language.import}</ShButton>
        {/snippet}
        {#snippet itemContent(index)}
            {@const persona = DBState.db.personas[index]}
            <div class="h-8 w-8 shrink-0 overflow-hidden rounded-md bg-textcolor2">
                {#if persona.icon}
                    {#await getCharImage(persona.icon, 'css') then im}
                        <div class="h-full w-full bg-cover bg-center" style={im}></div>
                    {/await}
                {/if}
            </div>
            <div class="min-w-0 grow truncate">
                <span>{persona.name}</span>
                {#if persona.note}<span class="text-textcolor2"> / {persona.note}</span>{/if}
            </div>
            <!-- Active persona marker (same convention as the memory preset default star). -->
            {#if index === DBState.db.selectedPersona}
                <StarIcon size={14} class="shrink-0 text-primary" />
            {/if}
        {/snippet}
        {#snippet itemPanel(index)}
            {@render personaEditor(index)}
        {/snippet}
    </FolderedList>
    {/if}
</SettingPage>

<style>
    .persona-grid-catalog {
        max-height: min(42vh, 32rem);
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
    }

    .persona-grid-detail {
        position: sticky;
        z-index: 20;
        bottom: 0;
        height: min(36vh, 26rem);
        min-height: 10rem;
        max-height: 72vh;
        resize: vertical;
        overflow: auto;
        border-radius: 0.375rem;
        background: var(--risu-theme-bgcolor);
        box-shadow: 0 -0.4rem 1.2rem color-mix(in srgb, var(--risu-theme-bgcolor) 82%, transparent);
    }
</style>
