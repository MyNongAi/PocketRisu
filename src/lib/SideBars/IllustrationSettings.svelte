<script lang="ts">
    // A bot's illustration settings (illustration.ts), unfolded under the 🎨
    // switch by its ⚙ (inline: in a dialog the select lists opened beside it
    // and a pick closed the dialog unsaved). Style presets are "프리셋 X" lorebook entries — the bot's
    // own, the chat's, or a module's for every bot with it on (2026-10-20);
    // "new preset" writes one into the bot's lorebook to edit there.
    // (Selects sit in plain divs: a <label> around ShSelect sent its clicks to
    // the hidden native select, which closed the list at once.)
    import { untrack } from 'svelte'
    import { PlusIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { DBState, selectedCharID } from 'src/ts/stores.svelte'
    import { notifyInfo } from 'src/ts/alert'
    import { illustrationSettings, newPresetContent, type IllustrationBotSettings } from 'src/ts/process/illustration'
    import { presetsFor } from 'src/ts/process/illustrationRun'
    import { captureModuleRuntimeContext } from 'src/ts/process/modules'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import ShSwitch from '../UI/GUI/ShSwitch.svelte'
    import SelectInput from '../UI/GUI/SelectInput.svelte'
    import OptionInput from '../UI/GUI/OptionInput.svelte'
    import TextAreaInput from '../UI/GUI/TextAreaInput.svelte'


    let char = $derived(DBState.db.characters[$selectedCharID])
    let chat = $derived(char?.chats?.[char.chatPage])
    let settings = $derived(illustrationSettings(char?.nodeOnlyIllustration))
    let presets = $derived(char ? presetsFor(char, chat, captureModuleRuntimeContext(char, chat)) : [])
    let chosen = $derived(presets.find((preset) => preset.name === settings.preset))
    let direction = $state(untrack(() => char?.nodeOnlyIllustration?.direction ?? ''))

    function set<K extends keyof IllustrationBotSettings>(key: K, value: IllustrationBotSettings[K]) {
        if (!char) return
        char.nodeOnlyIllustration = { ...(char.nodeOnlyIllustration ?? {}), [key]: value }
    }

    $effect(() => {
        const text = direction
        if (!char || (char.nodeOnlyIllustration?.direction ?? '') === text) return
        set('direction', text)
    })

    let naiSummary = $derived.by(() => {
        if (DBState.db.sdProvider !== 'novelai') return ''
        const own = chosen?.nai ?? {}
        const config = DBState.db.NAIImgConfig
        return [
            DBState.db.NAIImgModel,
            `${own.steps ?? config.steps}${language.illustrationSteps}`,
            `${language.illustrationGuidance} ${own.scale ?? config.scale}`,
            own.sampler ?? config.sampler,
        ].join(' · ')
    })

    // A "프리셋 X" entry in the bot's lorebook, never active in the main prompt.
    function newPreset() {
        if (!char) return
        const taken = new Set(presets.map((preset) => preset.name))
        let name = language.illustrationNewPresetName
        for (let i = 2; taken.has(name); i++) name = `${language.illustrationNewPresetName} ${i}`
        char.globalLore = [...(char.globalLore ?? []), {
            key: '', secondkey: '', insertorder: 100, comment: `프리셋 ${name}`,
            content: newPresetContent(), mode: 'normal', alwaysActive: false, selective: false,
        }]
        set('preset', name)
        notifyInfo(language.illustrationPresetCreated.replace('{name}', `프리셋 ${name}`))
    }
</script>

<div class="flex w-full flex-col gap-3 rounded-md border border-darkborderc p-2 text-sm">
        {#if DBState.db.sdProvider === ''}
            <p class="text-red-400">{language.illustrationNoImageProvider}</p>
        {:else if DBState.db.sdProvider !== 'novelai'}
            <p class="text-textcolor2">{language.illustrationNotNovelAI}</p>
        {/if}

        <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-1">
                <span>{language.illustrationTrigger}</span>
                <SelectInput value={settings.trigger} onchange={(e) => set('trigger', e.currentTarget.value as any)}>
                    <OptionInput value="auto">{language.illustrationTriggerAuto}</OptionInput>
                    <OptionInput value="button">{language.illustrationTriggerButton}</OptionInput>
                </SelectInput>
            </div>
            <div class="flex flex-col gap-1">
                <span>{language.illustrationCount}</span>
                <SelectInput value={settings.count} onchange={(e) => set('count', e.currentTarget.value as any)}>
                    <OptionInput value="0-1">{language.illustrationCount01}</OptionInput>
                    <OptionInput value="1">{language.illustrationCount1}</OptionInput>
                    <OptionInput value="1-2">{language.illustrationCount12}</OptionInput>
                    <OptionInput value="1-3">{language.illustrationCount13}</OptionInput>
                </SelectInput>
            </div>
            <div class="flex flex-col gap-1">
                <span>{language.illustrationPosition}</span>
                <SelectInput value={settings.position} onchange={(e) => set('position', e.currentTarget.value as any)}>
                    <OptionInput value="auto">{language.illustrationPositionAuto}</OptionInput>
                    <OptionInput value="top">{language.illustrationPositionTop}</OptionInput>
                    <OptionInput value="middle">{language.illustrationPositionMiddle}</OptionInput>
                    <OptionInput value="bottom">{language.illustrationPositionBottom}</OptionInput>
                </SelectInput>
            </div>
            <div class="flex flex-col gap-1">
                <span>{language.illustrationRatio}</span>
                <SelectInput value={settings.ratio} onchange={(e) => set('ratio', e.currentTarget.value as any)}>
                    <OptionInput value="portrait">{language.illustrationRatioPortrait}</OptionInput>
                    <OptionInput value="landscape">{language.illustrationRatioLandscape}</OptionInput>
                    <OptionInput value="square">{language.illustrationRatioSquare}</OptionInput>
                </SelectInput>
            </div>
            <div class="flex flex-col gap-1">
                <span>{language.illustrationMaxCharacters}</span>
                <SelectInput value={String(settings.maxCharacters)} onchange={(e) => set('maxCharacters', Number(e.currentTarget.value))}>
                    <OptionInput value="1">1</OptionInput>
                    <OptionInput value="2">2</OptionInput>
                    <OptionInput value="3">3</OptionInput>
                </SelectInput>
            </div>
            <div class="flex items-center justify-between gap-2 min-h-10">
                <span>{language.illustrationNsfw}</span>
                <ShSwitch checked={settings.nsfw} onCheckedChange={(checked) => set('nsfw', checked)} />
            </div>
        </div>

        <div class="flex flex-col gap-1">
            <span>{language.illustrationPreset}</span>
            <div class="flex flex-col gap-2">
                <SelectInput value={settings.preset ?? ''} onchange={(e) => set('preset', e.currentTarget.value || undefined)}>
                    <OptionInput value="">{language.illustrationPresetNone}</OptionInput>
                    {#each presets as preset (preset.name)}
                        <OptionInput value={preset.name}>{preset.name} · {preset.source}</OptionInput>
                    {/each}
                </SelectInput>
                <ShButton size="sm" variant="outline" className="self-start" onclick={newPreset}><PlusIcon size={14}/> {language.illustrationNewPreset}</ShButton>
            </div>
            <span class="text-xs text-textcolor2">{language.illustrationPresetHint}</span>
            {#if settings.preset && !chosen}
                <span class="text-xs text-yellow-500">{language.illustrationPresetMissing}</span>
            {/if}
        </div>

        {#if naiSummary}
            <div class="flex flex-col gap-0.5 rounded-md border border-darkborderc px-2 py-1.5 text-xs text-textcolor2">
                <span>NovelAI · {naiSummary}{chosen?.nai ? ` (${language.illustrationPresetOwn})` : ''}</span>
                <span>{language.illustrationNaiHint}</span>
            </div>
        {/if}

        <div class="flex flex-col gap-1">
            <span>{language.illustrationDirection}</span>
            <TextAreaInput bind:value={direction} size="sm" placeholder={language.illustrationDirectionHint} />
        </div>
</div>
