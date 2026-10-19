<script lang="ts">
    // A bot's illustration settings (illustration.ts) and the style presets
    // every bot shares, opened from the ⚙ beside the 🎨 switch.
    import { v4 } from 'uuid'
    import { PlusIcon, TrashIcon, DownloadIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { DBState, selectedCharID } from 'src/ts/stores.svelte'
    import { notifyInfo } from 'src/ts/alert'
    import { collectLightboardPresets, illustrationSettings } from 'src/ts/process/illustration'
    import ShDialog from '../UI/GUI/ShDialog.svelte'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import SelectInput from '../UI/GUI/SelectInput.svelte'
    import OptionInput from '../UI/GUI/OptionInput.svelte'
    import TextInput from '../UI/GUI/TextInput.svelte'
    import TextAreaInput from '../UI/GUI/TextAreaInput.svelte'

    interface Props {
        onClose: () => void
    }
    let { onClose }: Props = $props()

    let char = $derived(DBState.db.characters[$selectedCharID])
    let settings = $derived(illustrationSettings(char?.nodeOnlyIllustration))
    let presets = $derived(DBState.db.nodeOnlyIllustrationPresets ?? [])
    let managing = $state(false)

    function set<K extends 'trigger' | 'count' | 'ratio' | 'presetId'>(key: K, value: string) {
        if (!char) return
        char.nodeOnlyIllustration = { ...(char.nodeOnlyIllustration ?? {}), [key]: value || undefined }
    }

    function addPreset() {
        DBState.db.nodeOnlyIllustrationPresets = [...presets, { id: v4(), name: language.illustrationNewPreset, positive: '{prompt}', negative: '' }]
    }

    function removePreset(id: string) {
        DBState.db.nodeOnlyIllustrationPresets = presets.filter((preset) => preset.id !== id)
        if (settings.presetId === id) set('presetId', '')
    }

    // "프리셋 X" lorebooks from the Lightboard illustration modules, bots too.
    function importLightboard() {
        const books = [
            ...(DBState.db.modules ?? []).map((module) => module?.lorebook),
            ...DBState.db.characters.map((c) => c?.globalLore),
        ]
        const found = collectLightboardPresets(books, presets)
        if (found.length) DBState.db.nodeOnlyIllustrationPresets = [...presets, ...found.map((preset) => ({ id: v4(), ...preset }))]
        notifyInfo(language.illustrationImported.replace('{n}', String(found.length)))
    }
</script>

<ShDialog open={true} onOpenChange={(v) => { if (!v) onClose() }} size="default">
    {#snippet title()}{language.illustrationSettings}{/snippet}
    <div class="flex flex-col gap-3 text-sm">
        {#if DBState.db.sdProvider === ''}
            <p class="text-red-400">{language.illustrationNoImageProvider}</p>
        {:else if DBState.db.sdProvider !== 'novelai'}
            <p class="text-textcolor2">{language.illustrationNotNovelAI}</p>
        {/if}

        <label class="flex flex-col gap-1">
            <span>{language.illustrationTrigger}</span>
            <SelectInput value={settings.trigger} onchange={(e) => set('trigger', e.currentTarget.value)}>
                <OptionInput value="auto">{language.illustrationTriggerAuto}</OptionInput>
                <OptionInput value="button">{language.illustrationTriggerButton}</OptionInput>
            </SelectInput>
        </label>
        <label class="flex flex-col gap-1">
            <span>{language.illustrationCount}</span>
            <SelectInput value={settings.count} onchange={(e) => set('count', e.currentTarget.value)}>
                <OptionInput value="0-1">{language.illustrationCount01}</OptionInput>
                <OptionInput value="1">{language.illustrationCount1}</OptionInput>
                <OptionInput value="1-2">{language.illustrationCount12}</OptionInput>
                <OptionInput value="1-3">{language.illustrationCount13}</OptionInput>
            </SelectInput>
        </label>
        <label class="flex flex-col gap-1">
            <span>{language.illustrationRatio}</span>
            <SelectInput value={settings.ratio} onchange={(e) => set('ratio', e.currentTarget.value)}>
                <OptionInput value="portrait">{language.illustrationRatioPortrait}</OptionInput>
                <OptionInput value="landscape">{language.illustrationRatioLandscape}</OptionInput>
                <OptionInput value="square">{language.illustrationRatioSquare}</OptionInput>
            </SelectInput>
        </label>
        <label class="flex flex-col gap-1">
            <span>{language.illustrationPreset}</span>
            <SelectInput value={settings.presetId ?? ''} onchange={(e) => set('presetId', e.currentTarget.value)}>
                <OptionInput value="">{language.illustrationPresetNone}</OptionInput>
                {#each presets as preset (preset.id)}
                    <OptionInput value={preset.id}>{preset.name}</OptionInput>
                {/each}
            </SelectInput>
        </label>

        <ShButton variant="ghost" size="xs" className="self-start text-textcolor2" onclick={() => { managing = !managing }}>
            {managing ? '▾' : '▸'} {language.illustrationManagePresets}
        </ShButton>
        {#if managing}
            <div class="flex flex-col gap-3 rounded-md border border-darkborderc p-2">
                <p class="text-xs text-textcolor2">{language.illustrationPresetHint}</p>
                {#each DBState.db.nodeOnlyIllustrationPresets ?? [] as preset (preset.id)}
                    <div class="flex flex-col gap-1 border-b border-darkborderc pb-3">
                        <div class="flex items-center gap-2">
                            <TextInput bind:value={preset.name} size="sm" className="grow" />
                            <button class="p-1 text-textcolor2 hover:text-red-400" aria-label={language.illustrationRemovePreset} onclick={() => removePreset(preset.id)}><TrashIcon size={16}/></button>
                        </div>
                        <span class="text-xs text-textcolor2">{language.illustrationPositive}</span>
                        <TextAreaInput bind:value={preset.positive} size="sm" />
                        <span class="text-xs text-textcolor2">{language.illustrationNegative}</span>
                        <TextAreaInput bind:value={preset.negative} size="sm" />
                    </div>
                {/each}
                <div class="flex flex-wrap gap-2">
                    <ShButton size="xs" onclick={addPreset}><PlusIcon size={14}/> {language.illustrationNewPreset}</ShButton>
                    <ShButton size="xs" variant="outline" onclick={importLightboard}><DownloadIcon size={14}/> {language.illustrationImportLightboard}</ShButton>
                </div>
            </div>
        {/if}
    </div>
</ShDialog>
