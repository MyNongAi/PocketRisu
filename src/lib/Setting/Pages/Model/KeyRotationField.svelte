<script lang="ts">
    import type { ModelPreset } from 'src/ts/preset/types';
    import { language } from 'src/lang';
    import { addApiKey, getApiKey, listApiKeys } from 'src/ts/preset/apiKeyPool';
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte';
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte';
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte';
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte';
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte';
    import SecretInput from 'src/lib/UI/GUI/SecretInput.svelte';

    let { preset }: { preset: ModelPreset } = $props();
    let showAll = $state(false);
    let showAddDialog = $state(false);
    let pendingKey = $state('');
    let pendingName = $state('');
    const provider = $derived(preset.profileSnapshot.providerBaseId);
    const entries = $derived(listApiKeys(showAll ? undefined : provider));
    const isVertex = $derived(preset.profileSnapshot.auth.kind === 'google-service-account');

    function setRef(index: number, id: string) {
        const refs = [...(preset.rotationKeyRefs ?? [])];
        refs[index] = id;
        preset.rotationKeyRefs = refs;
    }
    function remove(index: number) {
        preset.rotationKeyRefs = (preset.rotationKeyRefs ?? []).filter((_, i) => i !== index);
    }
    function saveNewKey() {
        if (!pendingKey || !pendingName.trim()) return;
        const entry = addApiKey({ name: pendingName.trim(), key: pendingKey, provider });
        const refs = [...(preset.rotationKeyRefs ?? [])];
        const emptyRow = refs.indexOf('');
        if (emptyRow >= 0) refs[emptyRow] = entry.id;
        else refs.push(entry.id);
        preset.rotationKeyRefs = refs;
        pendingKey = '';
        pendingName = '';
        showAddDialog = false;
    }
</script>

<!-- PRESET-KEY-ROTATION: extra keys for automatic rotation. -->
<div class="flex min-w-0 flex-col gap-2 rounded-md border border-darkborderc p-3">
    <div class="flex items-center justify-between gap-2">
        <span class="text-sm font-semibold text-textcolor">{language.presetKeyRotation}</span>
        <ShButton variant="outline" size="sm" onclick={() => { preset.rotationKeyRefs = [...(preset.rotationKeyRefs ?? []), '']; }} aria-label={language.presetKeyRotationAdd}>+</ShButton>
    </div>
    <p class="text-xs text-textcolor2">{language.presetKeyRotationHelp}</p>
    {#if isVertex}<p class="text-xs text-textcolor2">{language.presetKeyRotationVertexHelp}</p>{/if}
    {#each preset.rotationKeyRefs ?? [] as ref, index (index)}
        <div class="flex min-w-0 items-center gap-2">
            <div class="min-w-0 flex-1">
                <SelectInput value={ref} className="w-full min-w-0" onchange={(event) => setRef(index, event.currentTarget.value)}>
                    <OptionInput value="">{language.apiKeySelectNone}</OptionInput>
                    {#if ref && !getApiKey(ref)}<OptionInput value={ref}>{language.apiKeyDeletedOption}</OptionInput>{/if}
                    {#if ref && getApiKey(ref) && !entries.some((entry) => entry.id === ref)}
                        <OptionInput value={ref}>{getApiKey(ref)?.name}</OptionInput>
                    {/if}
                    {#each entries as entry (entry.id)}
                        <OptionInput value={entry.id}>{entry.name}{showAll && entry.provider ? ` (${entry.provider})` : ''}</OptionInput>
                    {/each}
                </SelectInput>
            </div>
            <button type="button" class="shrink-0 rounded px-2 py-1 text-textcolor2 hover:text-red-400" aria-label={language.remove} onclick={() => remove(index)}>×</button>
        </div>
    {/each}
    <CheckInput bind:check={showAll} name={language.apiKeyShowAll} className="text-xs" />
    <div><ShButton variant="ghost" size="sm" onclick={() => { pendingKey = ''; pendingName = ''; showAddDialog = true; }}>{language.presetKeyRotationNew}</ShButton></div>
</div>

<ShDialog bind:open={showAddDialog} size="sm">
    {#snippet title()}{language.presetKeyRotationNew}{/snippet}
    <div class="flex flex-col gap-3 min-w-0">
        <input bind:value={pendingName} class="w-full min-w-0 rounded-md border border-darkborderc bg-transparent px-3 py-2 text-textcolor" placeholder={language.apiKeyName} autocomplete="off" />
        <SecretInput bind:value={pendingKey} fullwidth placeholder={language.apiKeyModeDirect} />
    </div>
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { showAddDialog = false; }}>{language.cancel}</ShButton>
        <ShButton variant="default" disabled={!pendingName.trim() || !pendingKey} onclick={saveNewKey}>{language.apiKeyFormSave}</ShButton>
    {/snippet}
</ShDialog>
