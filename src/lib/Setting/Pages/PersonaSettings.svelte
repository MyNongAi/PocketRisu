<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import FolderedList, { type FolderedItemPlacement } from "src/lib/UI/FolderedList.svelte";
    import { Clock3Icon, FolderPlusIcon, Grid3X3Icon, GripHorizontalIcon, HardDriveUploadIcon, ListIcon, ListOrderedIcon, PlusIcon, SearchIcon, StarIcon } from "@lucide/svelte";
    import { alertConfirm, alertInput, notifyError, notifySuccess } from "src/ts/alert";
    import { getCharImage } from "src/ts/characters";
    import { changeUserPersona, exportUserPersona, importUserPersona, importUserPersonaImage, saveUserPersona, selectUserImg, setUserPersonaImage } from "src/ts/persona";
    import { onDestroy } from "svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { v4 } from "uuid"
    import { groupByFolder } from "src/ts/folders";
    import LazyAssetPreview from "src/lib/Others/LazyAssetPreview.svelte";
    import { resolveCharacterSourceBadge } from "src/ts/gui/characterSourceBadge";

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

    type PersonaSortMode = 'registered' | 'recent'
    let personaSearch = $state('')
    let personaSort = $state<PersonaSortMode>(
        typeof localStorage !== 'undefined' && localStorage.getItem('risu-persona-sort') === 'recent'
            ? 'recent'
            : 'registered',
    )
    let detailHeight = $state(loadDetailHeight())
    let stopDetailResize: (() => void) | null = null

    const folders = $derived(DBState.db.personaFolders ?? [])
    const personaGroups = $derived.by(() => {
        const query = personaSearch.trim().toLocaleLowerCase().replace(/\s+/g, '')
        const groups = groupByFolder(DBState.db.personas.map((persona) => persona.folderId), folders)
            .map((group) => ({
                ...group,
                indexes: group.indexes
                    .filter((index) => {
                        if (!query) return true
                        const persona = DBState.db.personas[index]
                        const source = resolveCharacterSourceBadge(persona?.sourceInfo?.label).label
                        return `${persona?.name ?? ''}\n${persona?.note ?? ''}\n${persona?.personaPrompt ?? ''}\n${source}`
                            .replace(/\s+/g, '')
                            .toLocaleLowerCase()
                            .includes(query)
                    })
                    .sort((left, right) => personaSort === 'recent'
                        ? (Number(DBState.db.personas[right]?.lastAppliedAt) - Number(DBState.db.personas[left]?.lastAppliedAt)) || left - right
                        : left - right),
            }))
            .filter((group) => group.indexes.length > 0)
        if (personaSort === 'recent') {
            groups.sort((left, right) => (
                Math.max(0, ...right.indexes.map((index) => Number(DBState.db.personas[index]?.lastAppliedAt) || 0))
                - Math.max(0, ...left.indexes.map((index) => Number(DBState.db.personas[index]?.lastAppliedAt) || 0))
            ))
        }
        return groups
    })
    const personaListIndexes = $derived(DBState.db.personas
        .map((_, index) => index)
        .sort((left, right) => personaSort === 'recent'
            ? (Number(DBState.db.personas[right]?.lastAppliedAt) - Number(DBState.db.personas[left]?.lastAppliedAt)) || left - right
            : left - right))

    function loadDetailHeight() {
        try {
            const value = Number(localStorage.getItem('risu-persona-detail-height'))
            if (Number.isFinite(value) && value >= 140) return value
        } catch {}
        return 260
    }

    function setPersonaSort(next: PersonaSortMode) {
        personaSort = next
        try { localStorage.setItem('risu-persona-sort', next) } catch {}
    }

    function ensureId(persona: typeof DBState.db.personas[number]) {
        persona.id ??= v4()
        return persona.id
    }

    function personaSource(index: number) {
        return resolveCharacterSourceBadge(DBState.db.personas[index]?.sourceInfo?.label)
    }

    function isFileDrag(event: DragEvent) {
        return Array.from(event.dataTransfer?.types ?? []).includes('Files')
    }

    function allowPersonaDrop(event: DragEvent) {
        if (!isFileDrag(event)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    async function handlePersonaDrop(event: DragEvent, targetIndex = DBState.db.selectedPersona) {
        if (!isFileDrag(event)) return
        const file = event.dataTransfer?.files?.[0]
        if (!file || !/\.(png|webp|gif|jpe?g)$/i.test(file.name)) return
        event.preventDefault()
        event.stopPropagation()
        try {
            const data = new Uint8Array(await file.arrayBuffer())
            const importedIndex = file.name.toLocaleLowerCase().endsWith('.png')
                ? await importUserPersonaImage(data)
                : null
            if (importedIndex !== null) {
                changeUserPersona(importedIndex, 'noSave')
                expanded = true
                notifySuccess(language.successImport)
            } else {
                await setUserPersonaImage(data, targetIndex)
                notifySuccess('페르소나 이미지가 변경되었사와요')
            }
        } catch (error) {
            notifyError(error)
        }
    }

    async function createPersonaFolder() {
        const name = (await alertInput(language.folderNameInput))?.trim()
        if (!name) return
        DBState.db.personaFolders = [{ id: v4(), name }, ...(DBState.db.personaFolders ?? [])]
        void requestImmediateSave()
    }

    function beginDetailResize(event: PointerEvent) {
        if (event.button !== 0) return
        event.preventDefault()
        stopDetailResize?.()
        const startY = event.clientY
        const startHeight = detailHeight
        const onMove = (moveEvent: PointerEvent) => {
            const maxHeight = Math.max(180, Math.floor(window.innerHeight * 0.72))
            detailHeight = Math.min(maxHeight, Math.max(140, startHeight - (moveEvent.clientY - startY)))
        }
        const onEnd = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onEnd)
            window.removeEventListener('pointercancel', onEnd)
            stopDetailResize = null
            try { localStorage.setItem('risu-persona-detail-height', String(Math.round(detailHeight))) } catch {}
        }
        stopDetailResize = onEnd
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onEnd, { once: true })
        window.addEventListener('pointercancel', onEnd, { once: true })
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
        changeUserPersona(Math.max(0, next.findIndex(p => p.id === selectedId)), 'noSave', false)
        void requestImmediateSave()
    }

    function applyListPlacements(placements: FolderedItemPlacement[]) {
        const mapped = placements.map(({ index, folderId }) => ({
            index: personaListIndexes[index],
            folderId,
        }))
        if (personaSort === 'registered') {
            applyPlacements(mapped)
            return
        }
        // A derived recent sort is display-only. Folder menu operations remain
        // useful, but must not physically rewrite the registration sequence.
        saveUserPersona()
        const selectedId = ensureId(DBState.db.personas[DBState.db.selectedPersona])
        const folderByIndex = new Map(mapped.map((placement) => [placement.index, placement.folderId]))
        DBState.db.personas = DBState.db.personas.map((persona, index) => ({
            ...persona,
            folderId: folderByIndex.get(index),
        }))
        changeUserPersona(Math.max(0, DBState.db.personas.findIndex((persona) => persona.id === selectedId)), 'noSave', false)
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
            createdAt: Date.now(),
            lastAppliedAt: Date.now(),
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
        DBState.db.personas = [...DBState.db.personas, {
            ...clone,
            name: clone.name + ' (Copy)',
            id: v4(),
            createdAt: Date.now(),
            lastAppliedAt: undefined,
        }]
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
        changeUserPersona(selectedIndex >= 0 ? selectedIndex : 0, 'noSave', false)
        // Don't pop open whichever persona became selected after the removal.
        if (selectedIndex < 0) expanded = false
        void requestImmediateSave()
    }

    onDestroy(() => {
        stopDetailResize?.()
        saveUserPersona()
    })
</script>

{#snippet personaEditor(index: number)}
    {@const persona = DBState.db.personas[index]}
    <div class="flex flex-wrap gap-4 bg-dark-900/50 p-3 rounded-md">
        <button
            class="shrink-0 self-start rounded-md"
            onclick={() => { void selectUserImg(index) }}
            ondragover={allowPersonaDrop}
            ondrop={(event) => { void handlePersonaDrop(event, index) }}
            title="이미지를 놓으면 썸네일 변경 · 페르소나 정보가 든 PNG는 새 페르소나로 가져오기"
        >
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

<SettingPage title={language.persona} contentClassName="min-h-0 grow">
    <div class="mb-2 flex flex-wrap items-center justify-end gap-1" aria-label={language.persona}>
        <ShButton size="sm" variant={personaSort === 'registered' ? 'default' : 'outline'} onclick={() => setPersonaSort('registered')}>
            <ListOrderedIcon />등록순
        </ShButton>
        <ShButton size="sm" variant={personaSort === 'recent' ? 'default' : 'outline'} onclick={() => setPersonaSort('recent')}>
            <Clock3Icon />최근 적용순
        </ShButton>
        <span class="grow"></span>
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
        <div class="mb-2 flex flex-wrap items-center gap-2">
            <ShButton size="sm" onclick={createPersona}><PlusIcon />{language.createfromScratch}</ShButton>
            <ShButton size="sm" variant="outline" onclick={importPersona}><HardDriveUploadIcon />{language.import}</ShButton>
            <ShButton size="sm" variant="outline" onclick={createPersonaFolder}><FolderPlusIcon />{language.folderNew}</ShButton>
        </div>

        <div class="risu-field-border mb-2 flex items-center gap-2 rounded-md px-3">
            <SearchIcon size={18} class="shrink-0 text-textcolor2" />
            <input bind:value={personaSearch} placeholder={language.personaSearch}
                class="w-full bg-transparent py-2 text-textcolor outline-none" />
        </div>

        <div class="persona-grid-shell flex min-h-0 grow flex-col" role="region" aria-label="페르소나 그리드" ondragover={allowPersonaDrop} ondrop={(event) => { void handlePersonaDrop(event) }}>
        <div class="persona-grid-catalog min-h-0 grow rounded-md border border-darkborderc p-3">
            {#each personaGroups as group (group.folder?.id ?? '')}
                {#if group.indexes.length > 0}
                    <div class="mb-2 mt-1 flex items-center gap-2 text-sm text-textcolor2">
                        <span class="truncate">{group.folder?.name ?? language.folderUncategorized}</span>
                        <span class="text-xs">{group.indexes.length}</span>
                    </div>
                    <div class="mb-4 flex flex-wrap content-start gap-3">
                        {#each group.indexes as index}
                            {@const persona = DBState.db.personas[index]}
                            {@const source = personaSource(index)}
                            <button
                                type="button"
                                aria-label={persona.name || 'User'}
                                aria-pressed={index === DBState.db.selectedPersona}
                                onclick={() => selectGridPersona(index)}
                                ondragover={allowPersonaDrop}
                                ondrop={(event) => { void handlePersonaDrop(event, index) }}
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
                                <span
                                    class="w-full truncate text-center text-[10px]"
                                    class:text-sky-300={source.label === '로컬'}
                                    class:text-violet-300={source.label === '웹'}
                                    class:text-emerald-300={source.label === '모바일'}
                                    title={source.recorded ? `기록된 출처: ${source.label}` : '출처 기록 없음 · 기존 웹리스 기준'}
                                >[{source.label}]</span>
                            </button>
                        {/each}
                    </div>
                {/if}
            {/each}
        </div>

        {#if DBState.db.personas[DBState.db.selectedPersona]}
            <div class="persona-grid-detail mt-3" style={`height:${detailHeight}px`} aria-label="선택한 페르소나 정보">
                <button
                    type="button"
                    class="persona-detail-resizer"
                    aria-label="페르소나 정보창 높이 조절"
                    title="위아래로 끌어 정보창 높이 조절"
                    onpointerdown={beginDetailResize}
                ><GripHorizontalIcon size={20} /></button>
                {@render personaEditor(DBState.db.selectedPersona)}
            </div>
        {/if}
        </div>
    {:else}
    <FolderedList
        {folders}
        itemFolderIds={personaListIndexes.map((index) => DBState.db.personas[index]?.folderId)}
        itemSearchTexts={personaListIndexes.map((index) => {
            const persona = DBState.db.personas[index]
            return `${persona?.name ?? ''}\n${persona?.note ?? ''}\n${personaSource(index).label}`
        })}
        searchPlaceholder={language.personaSearch}
        selectedIndex={personaListIndexes.indexOf(DBState.db.selectedPersona)}
        isExpanded={(displayIndex) => expanded && personaListIndexes[displayIndex] === DBState.db.selectedPersona}
        storageKey="risu-persona-folders-collapsed"
        reorderDisabled={personaSort === 'recent'}
        onSelect={(displayIndex) => toggleRow(personaListIndexes[displayIndex])}
        onItemsChange={applyListPlacements}
        onFoldersChange={(next) => { DBState.db.personaFolders = next; void requestImmediateSave() }}
        onDuplicate={(displayIndex) => duplicatePersona(personaListIndexes[displayIndex])}
        onExport={(displayIndex) => exportPersona(personaListIndexes[displayIndex])}
        onDelete={(displayIndex) => deletePersona(personaListIndexes[displayIndex])}
    >
        {#snippet actions()}
            <ShButton size="sm" onclick={createPersona}><PlusIcon />{language.createfromScratch}</ShButton>
            <ShButton size="sm" variant="outline" onclick={importPersona}><HardDriveUploadIcon />{language.import}</ShButton>
        {/snippet}
        {#snippet itemContent(displayIndex)}
            {@const index = personaListIndexes[displayIndex]}
            {@const persona = DBState.db.personas[index]}
            {@const source = personaSource(index)}
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
                <span
                    class="ml-1 text-xs"
                    class:text-sky-300={source.label === '로컬'}
                    class:text-violet-300={source.label === '웹'}
                    class:text-emerald-300={source.label === '모바일'}
                    title={source.recorded ? `기록된 출처: ${source.label}` : '출처 기록 없음 · 기존 웹리스 기준'}
                >[{source.label}]</span>
            </div>
            <!-- Active persona marker (same convention as the memory preset default star). -->
            {#if index === DBState.db.selectedPersona}
                <StarIcon size={14} class="shrink-0 text-primary" />
            {/if}
        {/snippet}
        {#snippet itemPanel(displayIndex)}
            {@const index = personaListIndexes[displayIndex]}
            {@render personaEditor(index)}
        {/snippet}
    </FolderedList>
    {/if}
</SettingPage>

<style>
    .persona-grid-catalog {
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
    }

    .persona-grid-detail {
        position: relative;
        flex: 0 0 auto;
        z-index: 20;
        min-height: 8.75rem;
        max-height: 72vh;
        overflow: auto;
        border-radius: 0.375rem;
        background: var(--risu-theme-bgcolor);
        box-shadow: 0 -0.4rem 1.2rem color-mix(in srgb, var(--risu-theme-bgcolor) 82%, transparent);
    }

    .persona-detail-resizer {
        position: sticky;
        top: 0;
        z-index: 30;
        display: flex;
        width: 100%;
        height: 1.15rem;
        cursor: ns-resize;
        touch-action: none;
        align-items: center;
        justify-content: center;
        border-top: 1px solid var(--risu-theme-darkborderc);
        background: color-mix(in srgb, var(--risu-theme-bgcolor) 92%, transparent);
        color: var(--risu-theme-textcolor2);
    }

    .persona-detail-resizer:hover {
        color: var(--risu-theme-primary);
        border-top-color: var(--risu-theme-primary);
    }
</style>
