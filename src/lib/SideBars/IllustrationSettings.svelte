<script lang="ts" module>
    // The NovelAI box starts folded and stays as it was left for the session
    // (the user's request, 2026-10-28).
    let naiOpen = $state(false)
</script>

<script lang="ts">
    // A bot's illustration settings (illustration.ts), unfolded under the 🎨
    // switch by its ⚙ (inline: in a dialog the select lists opened beside it
    // and a pick closed the dialog unsaved). Style presets are "프리셋 X" lorebook entries — the bot's
    // own, the chat's, a module's for every bot with it on (2026-10-20), and
    // the 🎨 module's for every bot, on or off (illustrationModule.ts,
    // 2026-10-26); "new preset" and a dropped image write into the 🎨 module.
    // The NovelAI values are the settings page's own fields, bound here too
    // (the user's request, 2026-10-26: one set, changed from either place).
    // (Selects sit in plain divs: a <label> around ShSelect sent its clicks to
    // the hidden native select, which closed the list at once.)
    import { onMount, untrack } from 'svelte'
    import { PlusIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { DBState, selectedCharID } from 'src/ts/stores.svelte'
    import { notifyError, notifySuccess } from 'src/ts/alert'
    import { illustrationSettings, newPresetContent, ratioSize, type IllustrationBotSettings } from 'src/ts/process/illustration'
    import { presetsFor, restoreIllustrationPresets, writableIllustrationModule } from 'src/ts/process/illustrationRun'
    import { illustrationModuleOf, presetLorebookEntry } from 'src/ts/process/illustrationModule'
    import { NAI_MODELS, NAI_NOISE_SCHEDULES, naiModelShort, naiSamplers, naiSwitches } from 'src/ts/process/naiOptions'
    import { captureModuleRuntimeContext, getModules } from 'src/ts/process/modules'
    import { presetContentFromMeta, presetNameFromFile, readImageGenMeta } from 'src/ts/process/imageMeta'
    import { FileDropSurface, draggedItemsAreImages } from 'src/ts/gui/fileDropSurface.svelte'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import ShSwitch from '../UI/GUI/ShSwitch.svelte'
    import ShAccordion from '../UI/GUI/ShAccordion.svelte'
    import SelectInput from '../UI/GUI/SelectInput.svelte'
    import OptionInput from '../UI/GUI/OptionInput.svelte'
    import TextAreaInput from '../UI/GUI/TextAreaInput.svelte'
    import NumberInput from '../UI/GUI/NumberInput.svelte'


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

    onMount(() => { restoreIllustrationPresets() })

    // NovelAI: what the chosen preset's [NAI] section sets instead, shown by the field it replaces.
    let presetNai = $derived(chosen?.nai ?? {})
    let switches = $derived(naiSwitches(DBState.db.NAIImgModel, DBState.db.NAIImgConfig?.sampler))
    let size = $derived(ratioSize(settings.ratio))
    // Shown under the folded title: what a drawing would use now, preset values first.
    let naiSummary = $derived([
        naiModelShort(DBState.db.NAIImgModel),
        `${language.illustrationNaiSteps} ${presetNai.steps ?? DBState.db.NAIImgConfig?.steps}`,
        `CFG ${presetNai.scale ?? DBState.db.NAIImgConfig?.scale}`,
    ].join(' · '))
    const presetValue = (value: unknown) => language.illustrationNaiPresetValue.replace('{value}', typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : String(value))

    // Where a new preset goes: the 🎨 module (every bot can pick it), or a
    // module on now (every bot with that module gets it).
    let ownModule = $derived(illustrationModuleOf(DBState.db))
    let target = $state('illustration')
    let moduleTargets = $derived(char ? getModules(captureModuleRuntimeContext(char, chat)).filter((module) => !!module && module.id !== ownModule?.id) : [])

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
        const module = (target !== 'illustration' && DBState.db.modules.find((m) => m?.id === target)) || writableIllustrationModule()
        module.lorebook = [...(module.lorebook ?? []), presetLorebookEntry(name, content)]
        set('preset', name)
        notifySuccess(language.illustrationPresetCreated
            .replace('{name}', `프리셋 ${name}`)
            .replace('{where}', module.name))
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
                    {#if moduleTargets.length > 0}
                        <SelectInput size="sm" className="grow" value={target} onchange={(e) => { target = e.currentTarget.value }}>
                            <OptionInput value="illustration">{ownModule?.name ?? language.illustrationModuleName}</OptionInput>
                            {#each moduleTargets as module (module.id)}
                                <OptionInput value={module.id}>{module.name}</OptionInput>
                            {/each}
                        </SelectInput>
                    {:else}
                        <span class="min-w-0 truncate">{ownModule?.name ?? language.illustrationModuleName}</span>
                    {/if}
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

        {#if DBState.db.sdProvider === 'novelai' && DBState.db.NAIImgConfig}
            <!-- The settings page's NovelAI fields themselves; a value the chosen preset replaces is marked. -->
            {#snippet naiTitle()}
                <span class="flex min-w-0 flex-col leading-tight">
                    <span class="text-sm font-semibold text-textcolor">{language.illustrationNai}</span>
                    {#if !naiOpen}<span class="truncate text-xs font-normal text-textcolor2" data-illustration-nai-summary>{naiSummary}</span>{/if}
                </span>
            {/snippet}
            <!-- The label, and the value the chosen preset draws with instead (the field it replaces dims).
                 Kept outside the accordion: a snippet inside a component becomes its prop. -->
            {#snippet label(text: string, override: unknown)}
                <span class="min-w-0 text-textcolor2">{text}{#if override !== undefined}<span class="ml-1 text-yellow-500">· {presetValue(override)}</span>{/if}</span>
            {/snippet}
            <div data-illustration-nai>
            <ShAccordion bind:open={naiOpen} trigger={naiTitle} class="w-full" bodyClass="flex flex-col gap-1.5 text-xs">
                <div class="flex flex-col gap-1">
                    {@render label(language.illustrationNaiModel, undefined)}
                    <SelectInput size="sm" bind:value={DBState.db.NAIImgModel}>
                        {#each NAI_MODELS as model (model)}
                            <OptionInput value={model}>{model}</OptionInput>
                        {/each}
                    </SelectInput>
                </div>
                <div class="flex flex-col gap-1">
                    {@render label(language.illustrationNaiSampler, presetNai.sampler)}
                    <div class:opacity-50={presetNai.sampler !== undefined}>
                        <SelectInput size="sm" bind:value={DBState.db.NAIImgConfig.sampler}>
                            {#each naiSamplers(DBState.db.NAIImgModel) as sampler (sampler.value)}
                                <OptionInput value={sampler.value}>{sampler.label}</OptionInput>
                            {/each}
                        </SelectInput>
                    </div>
                </div>
                <div class="flex flex-col gap-1">
                    {@render label(language.illustrationNaiSchedule, presetNai.noise_schedule)}
                    <div class:opacity-50={presetNai.noise_schedule !== undefined}>
                        <SelectInput size="sm" bind:value={DBState.db.NAIImgConfig.noise_schedule}>
                            {#each NAI_NOISE_SCHEDULES as schedule (schedule)}
                                <OptionInput value={schedule}>{schedule}</OptionInput>
                            {/each}
                        </SelectInput>
                    </div>
                </div>
                <div class="flex items-center justify-between gap-2">
                    {@render label(language.illustrationNaiSteps, presetNai.steps)}
                    <div class="shrink-0" class:opacity-50={presetNai.steps !== undefined}>
                        <NumberInput size="sm" padding className="w-20" min={0} max={2048} bind:value={DBState.db.NAIImgConfig.steps} />
                    </div>
                </div>
                <div class="flex items-center justify-between gap-2">
                    {@render label(language.illustrationNaiScale, presetNai.scale)}
                    <div class="shrink-0" class:opacity-50={presetNai.scale !== undefined}>
                        <NumberInput size="sm" padding className="w-20" min={0} max={2048} bind:value={DBState.db.NAIImgConfig.scale} />
                    </div>
                </div>
                <div class="flex items-center justify-between gap-2">
                    {@render label(language.illustrationNaiRescale, presetNai.cfg_rescale)}
                    <div class="shrink-0" class:opacity-50={presetNai.cfg_rescale !== undefined}>
                        <NumberInput size="sm" padding className="w-20" min={0} max={1} bind:value={DBState.db.NAIImgConfig.cfg_rescale} />
                    </div>
                </div>
                {#if switches.smea}
                    <div class="flex min-h-8 items-center justify-between gap-2">
                        {@render label('SMEA', presetNai.sm)}
                        <div class="shrink-0" class:opacity-50={presetNai.sm !== undefined}>
                            <ShSwitch checked={!!DBState.db.NAIImgConfig.sm} onCheckedChange={(v) => DBState.db.NAIImgConfig.sm = v} />
                        </div>
                    </div>
                {/if}
                {#if switches.dyn}
                    <div class="flex min-h-8 items-center justify-between gap-2">
                        {@render label('DYN', presetNai.sm_dyn)}
                        <div class="shrink-0" class:opacity-50={presetNai.sm_dyn !== undefined}>
                            <ShSwitch checked={!!DBState.db.NAIImgConfig.sm_dyn} onCheckedChange={(v) => DBState.db.NAIImgConfig.sm_dyn = v} />
                        </div>
                    </div>
                {/if}
                {#if switches.variety}
                    <div class="flex min-h-8 items-center justify-between gap-2">
                        {@render label('Variety+', presetNai.variety)}
                        <div class="shrink-0" class:opacity-50={presetNai.variety !== undefined}>
                            <ShSwitch checked={!!DBState.db.NAIImgConfig.variety_plus} onCheckedChange={(v) => DBState.db.NAIImgConfig.variety_plus = v} />
                        </div>
                    </div>
                {/if}
                {#if switches.decrisp}
                    <div class="flex min-h-8 items-center justify-between gap-2">
                        {@render label('Decrisp', undefined)}
                        <ShSwitch checked={!!DBState.db.NAIImgConfig.decrisp} onCheckedChange={(v) => DBState.db.NAIImgConfig.decrisp = v} />
                    </div>
                {/if}
                {#if switches.legacyUc}
                    <div class="flex min-h-8 items-center justify-between gap-2">
                        {@render label('Legacy UC', undefined)}
                        <ShSwitch checked={!!DBState.db.NAIImgConfig.legacy_uc} onCheckedChange={(v) => DBState.db.NAIImgConfig.legacy_uc = v} />
                    </div>
                {/if}
                <div class="flex items-center justify-between gap-2">
                    <span class="text-textcolor2">{language.illustrationNaiSeed}</span>
                    <span class={presetNai.seed !== undefined ? 'text-yellow-500' : 'text-textcolor2'}>{presetNai.seed !== undefined ? presetValue(presetNai.seed) : language.illustrationNaiSeedRandom}</span>
                </div>
                <div class="flex items-center justify-between gap-2">
                    <span class="text-textcolor2">{language.illustrationNaiSize}</span>
                    <span class="text-right text-textcolor2">{size.width}×{size.height} · {language.illustrationNaiSizeHint}</span>
                </div>
                <span class="text-textcolor2">{language.illustrationNaiLinked}</span>
            </ShAccordion>
            </div>
        {/if}

        <div class="flex flex-col gap-1">
            <span>{language.illustrationDirection}</span>
            <TextAreaInput bind:value={direction} size="sm" placeholder={language.illustrationDirectionHint} />
        </div>
</div>
