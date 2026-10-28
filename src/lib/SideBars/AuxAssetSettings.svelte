<script lang="ts">
    // A bot's 🌙 settings (auxLorebook.ts), unfolded under the sidebar's 🌙
    // row by its ⚙, as the 🎨 one is (the user's choice, 2026-10-28). The
    // fields are what the community "보조모델 에셋모듈" set with its toggles.
    import { language } from 'src/lang'
    import type { Chat, character as Bot } from 'src/ts/storage/database.svelte'
    import { AUX_CONTEXT_COUNTS, auxAssetSettings, auxLorebookEntries, type AuxAssetBotSettings } from 'src/ts/process/auxLorebook'
    import { captureModuleRuntimeContext, getModuleLorebooks } from 'src/ts/process/modules'
    import ShSwitch from '../UI/GUI/ShSwitch.svelte'
    import SelectInput from '../UI/GUI/SelectInput.svelte'
    import OptionInput from '../UI/GUI/OptionInput.svelte'

    interface Props {
        character: Bot
        chat: Chat
    }

    let { character, chat }: Props = $props()

    let settings = $derived(auxAssetSettings(character.nodeOnlyAuxAsset))
    // Said when nothing would be tagged: no 🌙 entry in the lorebooks in use.
    let hasRules = $derived(auxLorebookEntries([
        character.globalLore,
        chat.localLore,
        getModuleLorebooks(captureModuleRuntimeContext(character, chat)),
    ]).length > 0)

    function set<K extends keyof AuxAssetBotSettings>(key: K, value: AuxAssetBotSettings[K]) {
        character.nodeOnlyAuxAsset = { ...(character.nodeOnlyAuxAsset ?? {}), [key]: value }
    }

    const SWITCHES = [
        { key: 'skipUser', label: 'auxAssetSkipUser' },
        { key: 'description', label: 'auxAssetDescription' },
        { key: 'persona', label: 'auxAssetPersona' },
        { key: 'mainModel', label: 'auxAssetMainModel' },
        { key: 'rerollButton', label: 'auxAssetRerollButton' },
    ] as const
</script>

<div class="flex w-full flex-col gap-3 rounded-md border border-darkborderc p-2 text-sm" data-aux-asset-settings>
    {#if !hasRules}
        <p class="text-textcolor2">{language.auxAssetNoRules}</p>
    {/if}
    <!-- Off: the rules stay, only the reply menu's 🌙 tags (the user's request, 2026-10-28). -->
    <div class="flex flex-col gap-1" data-aux-asset-auto>
        <div class="flex min-h-10 items-center justify-between gap-2">
            <span class="min-w-0 break-words">{language.auxAssetAuto}</span>
            <ShSwitch className="shrink-0" checked={settings.auto} onCheckedChange={(checked) => set('auto', checked)} />
        </div>
        {#if !settings.auto}
            <span class="text-xs text-textcolor2">{language.auxAssetAutoOff}</span>
        {/if}
    </div>
    <div class="flex flex-col gap-1">
        <span>{language.auxAssetContextCount}</span>
        <SelectInput value={String(settings.contextCount)} onchange={(e) => set('contextCount', Number(e.currentTarget.value))}>
            {#each AUX_CONTEXT_COUNTS as count (count)}
                <OptionInput value={String(count)}>{count}</OptionInput>
            {/each}
        </SelectInput>
    </div>
    {#each SWITCHES as field (field.key)}
        <div class="flex min-h-10 items-center justify-between gap-2">
            <span class="min-w-0 break-words">{language[field.label]}</span>
            <ShSwitch className="shrink-0" checked={settings[field.key]} onCheckedChange={(checked) => set(field.key, checked)} />
        </div>
    {/each}
</div>
