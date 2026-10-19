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
    import { notifyError, notifySuccess } from 'src/ts/alert'
    import { illustrationSettings, newPresetContent, type IllustrationBotSettings } from 'src/ts/process/illustration'
    import { presetsFor } from 'src/ts/process/illustrationRun'
    import { captureModuleRuntimeContext, getModules } from 'src/ts/process/modules'
    import { presetContentFromMeta, presetNameFromFile, readImageGenMeta } from 'src/ts/process/imageMeta'
    import { FileDropSurface, draggedItemsAreImages } from 'src/ts/gui/fileDropSurface.svelte'
    import type { loreBook } from 'src/ts/storage/database.svelte'
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

    // Where a new preset goes: this bot's lorebook, or a module on now (every
    // bot with that module gets it).
    let target = $state('bot')
    let moduleTargets = $derived(char ? getModules(captureModuleRuntimeContext(char, chat)).filter((module) => !!module) : [])

    function freeName(base: string): string {
        const taken = new Set(presets.map((preset) => preset.name))
        let name = base
        for (let i = 2; taken.has(name); i++) name = `${base} ${i}`
        return name
    }

    // A "프리셋 X" entry, never active in the main prompt; it becomes the bot's preset.
    function addPreset(base: string, content: string): void {
        if (!char) return
        const name = freeName(base)
        const entry: loreBook = {
            key: '', secondkey: '', insertorder: 100, comment: `프리셋 ${name}`,
            content, mode: 'normal', alwaysActive: false, selective: false,
        }
        const module = target === 'bot' ? null : DBState.db.modules.find((m) => m?.id === target)
        if (module) module.lorebook = [...(module.lorebook ?? []), entry]
        else char.globalLore = [...(char.globalLore ?? []), entry]
        set('preset', name)
        notifySuccess(language.illustrationPresetCreated
            .replace('{name}', `프리셋 ${name}`)
            .replace('{where}', module ? module.name : language.illustrationTargetBot))
    }

    function newPreset() {
        addPreset(language.illustrationNewPresetName, newPresetContent())
    }

    // Images dropped (or picked, on a phone): their prompt and settings, whole.
    let reading = $state(false)
    let fileInput: HTMLInputElement | undefined = $state()
    async function takeImages(files: File[]) {
        reading = true
        try {
            for (const file of files.filter((f) => f.type.startsWith('image/'))) {
                const meta = await readImageGenMeta(file)
                if (!meta) {
                    notifyError(`${language.illustrationNoMeta} (${file.name})`)
                    continue
                }
                addPreset(presetNameFromFile(file.name), presetContentFromMeta(meta, file.name))
            }
        } catch (error) {
            notifyError(error)
        } finally {
            reading = false
        }
    }
    const imageDrop = new FileDropSurface({ accepts: draggedItemsAreImages, onDrop: takeImages })
    $effect(() => imageDrop.attachWindowReset())
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
                <div class="flex items-center gap-2 text-xs">
                    <span class="shrink-0 text-textcolor2">{language.illustrationTarget}</span>
                    <SelectInput size="sm" className="grow" value={target} onchange={(e) => { target = e.currentTarget.value }}>
                        <OptionInput value="bot">{language.illustrationTargetBot}</OptionInput>
                        {#each moduleTargets as module (module.id)}
                            <OptionInput value={module.id}>{module.name}</OptionInput>
                        {/each}
                    </SelectInput>
                </div>
                <ShButton size="sm" variant="outline" className="self-start" onclick={newPreset}><PlusIcon size={14}/> {language.illustrationNewPreset}</ShButton>
                <!-- NovelAI / WebUI images: drop (or tap to pick) to make a preset of everything they hold. -->
                <div
                    role="button"
                    tabindex="0"
                    class="flex min-h-16 cursor-pointer items-center justify-center rounded-md border border-dashed px-2 py-3 text-center text-xs {imageDrop.active ? 'border-primary bg-primary/10 text-textcolor' : 'border-darkborderc text-textcolor2 hover:border-textcolor2'}"
                    ondragenter={imageDrop.over}
                    ondragover={imageDrop.over}
                    ondragleave={imageDrop.leave}
                    ondrop={imageDrop.drop}
                    onclick={() => fileInput?.click()}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput?.click() } }}
                >
                    {reading ? language.illustrationReadingImage : language.illustrationFromImageHint}
                </div>
                <input
                    bind:this={fileInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    class="hidden"
                    onchange={(e) => { void takeImages(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = '' }}
                />
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
