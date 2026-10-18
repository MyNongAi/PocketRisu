<script lang="ts">
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import FolderedList, { type FolderedItemPlacement } from "src/lib/UI/FolderedList.svelte";
    import { ArrowLeftIcon, CloudDownloadIcon, GitCompare, Globe, HardDriveUploadIcon, InfoIcon, PlusIcon } from "@lucide/svelte";
    import { onDestroy } from "svelte";
    import PromptDiffModal from "src/lib/Others/PromptDiffModal.svelte";
    import { tooltip } from "src/ts/gui/tooltip";
    import { language } from "src/lang";
    import { alertConfirm, notifyError, notifySuccess } from "src/ts/alert";
    import { DBState, PromptPresetEditorOpen, PromptPresetSubmenuIndex } from "src/ts/stores.svelte";
    import { changeToPreset, copyPreset, downloadPreset, importPreset, saveCurrentPreset, withStableActivePreset } from "src/ts/storage/database.svelte";
    import { prebuiltPresets } from "src/ts/process/templates/templates";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { v4 as uuidv4 } from "uuid";
    import { get } from "svelte/store";
    import {
        promptPresetBasicInfoItems,
        promptPresetPromptItems,
        promptPresetParameterItems,
        promptPresetAdvancedItems,
    } from "src/ts/setting/promptPresetSettingsData.svelte";

    // The page opens on the list; tapping a preset activates it and switches
    // to the editor. The editor still edits the DB top-level preset fields
    // via the setting schema exactly as before — only the shell changed.
    // A settings-search deep link asks for the editor directly.
    let view = $state<'list' | 'edit'>(get(PromptPresetEditorOpen) ? 'edit' : 'list')
    PromptPresetEditorOpen.set(false)

    const folders = $derived(DBState.db.promptPresetFolders ?? [])

    // A row opens the preset's editor; the globe on its right makes it the
    // one in use (the user's request, 2026-10-18; a row click used to switch
    // presets). The editor edits the preset in use (the setting schema reads
    // the DB's top-level fields), so a preset opened for editing is in use
    // only while its editor is open, and the one in use before comes back.
    // The preset in use when the editor opened, by id: the editor's own
    // duplicate/import/delete move what it edits and shift indexes.
    let returnToPresetId = $state<string | null>(null)

    function rememberUsedPreset() {
        if (returnToPresetId !== null) return
        const used = DBState.db.botPresets[DBState.db.botPresetsId]
        if (!used) return
        used.id ??= uuidv4()
        returnToPresetId = used.id
    }
    // A settings-search link opens the editor directly: remember from the start.
    // svelte-ignore state_referenced_locally
    if (view === 'edit') rememberUsedPreset()

    function openEditor(index: number) {
        saveCurrentPreset()
        rememberUsedPreset()
        changeToPreset(index, false)
        view = 'edit'
    }

    /** Leave the editor: the edits are kept, and the preset in use before is back. */
    function restoreUsedPreset() {
        saveCurrentPreset()
        const id = returnToPresetId
        returnToPresetId = null
        const back = id ? DBState.db.botPresets.findIndex((preset) => preset.id === id) : -1
        if (back >= 0 && back !== DBState.db.botPresetsId) changeToPreset(back, false)
    }

    function backToList() {
        restoreUsedPreset()
        view = 'list'
    }

    // Closing settings from the editor leaves the same way.
    onDestroy(() => {
        if (view === 'edit') restoreUsedPreset()
    })

    function usePreset(index: number) {
        saveCurrentPreset()
        changeToPreset(index, false)
        void requestImmediateSave()
    }

    /** Rebuilds `db.botPresets` from the list's reported order/folder membership. */
    function applyPlacements(placements: FolderedItemPlacement[]) {
        saveCurrentPreset()
        const presets = DBState.db.botPresets
        const next = placements.map(({ index, folderId }) => ({ ...presets[index], folderId }))
        if (next.length !== presets.length) return
        withStableActivePreset(() => {
            DBState.db.botPresets = next
        })
        void requestImmediateSave()
    }

    function createPreset() {
        saveCurrentPreset()
        const newPreset = safeStructuredClone(prebuiltPresets.OAI2)
        newPreset.id = uuidv4()
        newPreset.name = 'New Preset'
        DBState.db.botPresets = [...DBState.db.botPresets, newPreset]
        openEditor(DBState.db.botPresets.length - 1)
        void requestImmediateSave()
    }

    async function importPresetFile() {
        saveCurrentPreset()
        const before = DBState.db.botPresets.length
        await importPreset()
        // Added to the list; only the globe puts a preset in use.
        if (DBState.db.botPresets.length > before) notifySuccess(language.presetImported)
        void requestImmediateSave()
    }

    // A preset from a Proton Drive share link (protonImport.ts), added to
    // the list like a file import.
    async function importPresetFromProton() {
        saveCurrentPreset()
        const { importPresetsFromProtonLink } = await import('src/ts/protonImport')
        await importPresetsFromProtonLink()
        void requestImmediateSave()
    }

    function duplicatePreset(index: number) {
        const before = DBState.db.botPresets.length
        copyPreset(index)
        if (DBState.db.botPresets.length > before) notifySuccess(language.presetDuplicated)
        void requestImmediateSave()
    }

    function exportPreset(index: number) {
        downloadPreset(index, 'risupreset')
        notifySuccess(language.presetExported)
    }

    async function deletePreset(index: number) {
        const preset = DBState.db.botPresets[index]
        if (!preset) return
        if (DBState.db.botPresets.length === 1) {
            notifyError(language.errors.onlyOnePreset)
            return
        }
        if (!await alertConfirm(`${language.removeConfirm}${preset.name}`)) return
        // Flush in-flight top-level edits into the active preset before mutating the array.
        saveCurrentPreset()
        const removingActive = index === DBState.db.botPresetsId
        withStableActivePreset(() => {
            DBState.db.botPresets = DBState.db.botPresets.filter((_, i) => i !== index)
        })
        if (removingActive) changeToPreset(0, false)
        notifySuccess(language.presetDeleted)
        void requestImmediateSave()
    }

    // Prompt diff (display.showPromptComparison): pick two presets with the
    // compare icon to open the diff modal. Same flow as the sidebar picker.
    let showDiffModal = $state(false)
    let selectedDiffPreset = $state<number | null>(null)
    let firstPresetId = $state<number | null>(null)
    let secondPresetId = $state<number | null>(null)

    function handleDiffMode(index: number) {
        if (selectedDiffPreset === index) {
            selectedDiffPreset = null
            firstPresetId = null
            secondPresetId = null
            return
        }
        selectedDiffPreset = index
        if (firstPresetId === null) {
            firstPresetId = index
            secondPresetId = null
            return
        }
        secondPresetId = index
        selectedDiffPreset = null
        showDiffModal = true
    }

    function closeDiff() {
        showDiffModal = false
        firstPresetId = null
        secondPresetId = null
        selectedDiffPreset = null
    }
</script>

{#if view === 'list'}
<SettingPage title={language.promptPresetMenu}>
    <FolderedList
        {folders}
        itemFolderIds={DBState.db.botPresets.map(p => p.folderId)}
        itemSearchTexts={DBState.db.botPresets.map(p => p.name ?? '')}
        selectedIndex={DBState.db.botPresetsId}
        storageKey="risu-prompt-preset-folders-collapsed"
        onSelect={openEditor}
        onItemsChange={applyPlacements}
        onFoldersChange={(next) => { DBState.db.promptPresetFolders = next; void requestImmediateSave() }}
        onDuplicate={duplicatePreset}
        onExport={exportPreset}
        onDelete={deletePreset}
    >
        {#snippet actions()}
            <ShButton size="sm" onclick={createPreset}><PlusIcon />{language.presetNew}</ShButton>
            <ShButton size="sm" variant="outline" onclick={importPresetFile}><HardDriveUploadIcon />{language.presetImport}</ShButton>
            <ShButton size="sm" variant="outline" onclick={importPresetFromProton}><CloudDownloadIcon />{language.importFromProton}</ShButton>
        {/snippet}
        {#snippet itemContent(index)}
            {@const preset = DBState.db.botPresets[index]}
            {#if preset.image}
                <img src={preset.image} alt="" class="h-8 w-8 shrink-0 rounded-md object-cover" decoding="async"/>
            {:else}
                <div class="h-8 w-8 shrink-0 rounded-md bg-textcolor2/30"></div>
            {/if}
            <span class="min-w-0 grow truncate">{preset.name}</span>
            <button class="no-sort shrink-0 p-1 cursor-pointer {DBState.db.botPresetsId === index ? 'text-blue-500' : 'text-textcolor2 hover:text-primary'}"
                aria-label={DBState.db.botPresetsId === index ? language.presetInUse : language.presetUse}
                use:tooltip={DBState.db.botPresetsId === index ? language.presetInUse : language.presetUse}
                onclick={(e) => { e.stopPropagation(); usePreset(index) }}>
                <Globe size={18}/>
            </button>
            {#if DBState.db.showPromptComparison}
                <button class="no-sort shrink-0 p-1 rounded {selectedDiffPreset === index ? 'text-green-500' : 'text-textcolor2 hover:text-primary'}"
                    aria-label="compare" use:tooltip={language.showPromptComparison}
                    onclick={(e) => { e.stopPropagation(); handleDiffMode(index) }}>
                    <GitCompare size={16}/>
                </button>
            {/if}
        {/snippet}
    </FolderedList>
</SettingPage>
{#if showDiffModal && firstPresetId !== null && secondPresetId !== null}
    <!-- The modal is `absolute inset-0`; anchor it to the viewport, not the settings panel. -->
    <div class="fixed inset-0 z-50">
        <PromptDiffModal {firstPresetId} {secondPresetId} onClose={closeDiff} />
    </div>
{/if}
{:else}
<div class="flex items-center gap-2 mt-2 mb-2">
    <ShButton size="sm" variant="ghost" onclick={backToList}><ArrowLeftIcon />{language.backToList}</ShButton>
    <span class="text-sm text-textcolor2 truncate">{DBState.db.botPresets?.[DBState.db.botPresetsId]?.name ?? '—'}</span>
    {#if returnToPresetId !== null && DBState.db.botPresets?.[DBState.db.botPresetsId]?.id !== returnToPresetId}<span class="shrink-0 rounded bg-selected px-1.5 text-xs text-textcolor2">{language.presetEditingOnly}</span>{/if}
</div>
<SettingTabs
    tabs={[
        { label: language.basicInfo, value: 0 },
        { label: language.prompt, value: 1 },
        { label: language.parameters, value: 2 },
        { label: language.advancedSettings, value: 3 },
    ]}
    bind:selected={$PromptPresetSubmenuIndex}
/>

{#if $PromptPresetSubmenuIndex === 0}
    <SettingRenderer items={promptPresetBasicInfoItems} layout="row" />
{:else if $PromptPresetSubmenuIndex === 1}
    <SettingRenderer items={promptPresetPromptItems} layout="row" />
{:else if $PromptPresetSubmenuIndex === 2}
    <ShAlert className="mt-4 mb-2">
        {#snippet icon()}<InfoIcon />{/snippet}
        {language.promptPresetParamScopeDesc}
    </ShAlert>
    <SettingRenderer items={promptPresetParameterItems} layout="block" />
{:else if $PromptPresetSubmenuIndex === 3}
    <SettingRenderer items={promptPresetAdvancedItems} layout="row" />
{/if}
{/if}
