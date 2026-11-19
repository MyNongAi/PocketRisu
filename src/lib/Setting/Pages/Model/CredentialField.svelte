<script lang="ts">
    import type { ModelPreset, RegistryFieldSchema, RegistryUiField } from "src/ts/preset/types";
    import { language } from "src/lang";
    import { localizeDescription } from "src/ts/preset/registry/i18n";
    import { addApiKey, getApiKey, listApiKeys } from "src/ts/preset/apiKeyPool";
    import { untrack } from "svelte";
    import SecretInput from "src/lib/UI/GUI/SecretInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import CopyKeyButton from "src/lib/UI/GUI/CopyKeyButton.svelte";
    import { PlusIcon, MinusIcon } from '@lucide/svelte';

    interface Props {
        preset: ModelPreset;
        schemaField: RegistryFieldSchema;
        uiField: RegistryUiField;
        userValues: Record<string, unknown>;
    }

    let { preset, schemaField, uiField, userValues = $bindable() }: Props = $props();

    const fieldKey = $derived(schemaField.key);
    const providerBaseId = $derived(preset.profileSnapshot?.providerBaseId);
    const localizedDescription = $derived(localizeDescription(schemaField));

    // pool = use a saved key (preset.apiKeyRef); direct = type into userValues.
    // Seed from whether the preset already references a pooled key.
    let mode = $state<'pool' | 'direct'>(untrack(() => preset.apiKeyRef) ? 'pool' : 'direct');
    let showAll = $state(false);

    const directKey = $derived(userValues[fieldKey]);
    const hasDirectKey = $derived(typeof directKey === 'string' && directKey.length > 0);

    const poolEntries = $derived(listApiKeys(showAll ? undefined : providerBaseId));
    const isVertex = $derived(preset.profileSnapshot?.auth.kind === 'google-service-account');
    const newKeyOption = '__preset_rotation_new_key__';
    let showRotationDialog = $state(false);
    let rotationRow = $state<number | null>(null);
    let pendingRotationName = $state('');
    let pendingRotationKey = $state('');
    let rotationSelectVersion = $state(0);

    function setRotationRef(index: number, id: string) {
        if (id === newKeyOption) {
            rotationRow = index;
            pendingRotationName = '';
            pendingRotationKey = '';
            preset.rotationKeyRefs = (preset.rotationKeyRefs ?? []).map((ref, i) => i === index ? '' : ref);
            rotationSelectVersion++;
            showRotationDialog = true;
            return;
        }
        preset.rotationKeyRefs = (preset.rotationKeyRefs ?? []).map((ref, i) => i === index ? id : ref);
    }

    function cancelRotationDialog() {
        showRotationDialog = false;
        rotationRow = null;
        pendingRotationName = '';
        pendingRotationKey = '';
        rotationSelectVersion++;
    }

    function saveRotationKey() {
        if (rotationRow === null || !pendingRotationName.trim() || !pendingRotationKey) return;
        const entry = addApiKey({ name: pendingRotationName.trim(), key: pendingRotationKey, provider: providerBaseId });
        setRotationRef(rotationRow, entry.id);
        cancelRotationDialog();
    }

    // apiKeyRef points at a pooled key that no longer exists (deleted). Show a
    // "deleted key" fallback option instead of a blank select.
    const danglingRef = $derived(!!preset.apiKeyRef && !getApiKey(preset.apiKeyRef));

    // Invariant: direct mode never leaves a pool reference behind, or requests
    // would still resolve the pooled key (apiKeyRef wins in buildModelPresetCredential).
    $effect(() => {
        if (mode === 'direct' && preset.apiKeyRef) preset.apiKeyRef = undefined;
    });

    // Dedicated naming dialog. The shared alertInput modal dropped the typed
    // name (focus/IME) and had no empty-name guard, so we own a small dialog
    // here: explicit focus + disabled confirm when empty.
    let showSaveDialog = $state(false);
    let pendingName = $state('');
    let nameInput = $state<HTMLInputElement>();

    $effect(() => {
        if (showSaveDialog && nameInput) {
            const el = nameInput;
            requestAnimationFrame(() => el.focus());
        }
    });

    function openSaveDialog() {
        if (!hasDirectKey) return;
        pendingName = '';
        showSaveDialog = true;
    }

    function confirmSave() {
        const key = userValues[fieldKey];
        const name = pendingName.trim();
        if (typeof key !== 'string' || key.length === 0 || !name) return;
        const entry = addApiKey({ name, key, provider: providerBaseId });
        preset.apiKeyRef = entry.id;
        pendingName = '';
        showSaveDialog = false;
        mode = 'pool';
    }
</script>

<div class="flex flex-col gap-1">
    <div class="flex items-center justify-between gap-2">
        <span class="text-sm text-textcolor flex items-center gap-1">
            {schemaField.label}
            {#if schemaField.required}<span class="text-red-400">*</span>{/if}
        </span>
        <SegmentedControl
            bind:value={mode}
            size="sm"
            className="shrink-0 mb-0!"
            options={[
                { value: 'pool', label: language.apiKeyModePool },
                { value: 'direct', label: language.apiKeyModeDirect },
            ]}
        />
    </div>
    {#if localizedDescription}
        <span class="text-xs text-textcolor2">{localizedDescription}</span>
    {/if}

    {#if mode === 'pool'}
        {#if poolEntries.length === 0 && !danglingRef}<span class="text-xs text-textcolor2 py-1">{language.apiKeyPoolEmpty}</span>{/if}
        <div class="flex min-w-0 items-center gap-1">
            <div class="min-w-0 grow">
                <SelectInput bind:value={preset.apiKeyRef as string} className="w-full min-w-0">
                    <OptionInput value="">{language.apiKeySelectNone}</OptionInput>
                    {#if danglingRef}
                        <OptionInput value={preset.apiKeyRef as string}>{language.apiKeyDeletedOption}</OptionInput>
                    {/if}
                    {#each poolEntries as entry (entry.id)}
                        <OptionInput value={entry.id}>{entry.name}{showAll && entry.provider ? ` (${entry.provider})` : ''}</OptionInput>
                    {/each}
                </SelectInput>
            </div>
            <CopyKeyButton text={preset.apiKeyRef ? getApiKey(preset.apiKeyRef)?.key : undefined} />
            <button type="button" class="shrink-0 p-1 text-textcolor2 hover:text-textcolor" title={language.presetKeyRotationAdd} aria-label={language.presetKeyRotationAdd} onclick={() => { preset.rotationKeyRefs = [...(preset.rotationKeyRefs ?? []), '']; }}><PlusIcon size={18} /></button>
        </div>
    {:else}
        <div class="flex min-w-0 items-center gap-1">
            <div class="min-w-0 grow">
                <SecretInput
                    bind:value={userValues[fieldKey] as string}
                    placeholder={uiField.placeholder ?? ''}
                    fullwidth
                />
            </div>
            <CopyKeyButton text={hasDirectKey ? directKey as string : undefined} />
            <button type="button" class="shrink-0 p-1 text-textcolor2 hover:text-textcolor" title={language.presetKeyRotationAdd} aria-label={language.presetKeyRotationAdd} onclick={() => { preset.rotationKeyRefs = [...(preset.rotationKeyRefs ?? []), '']; }}><PlusIcon size={18} /></button>
        </div>
    {/if}

    <!-- PRESET-KEY-ROTATION: extra keys for automatic rotation. -->
    {#each preset.rotationKeyRefs ?? [] as ref, index (index)}
        {#key `${index}-${rotationSelectVersion}`}
            <div class="flex min-w-0 items-center gap-1">
                <div class="min-w-0 grow">
                    <SelectInput value={ref} className="w-full min-w-0" onchange={(event) => setRotationRef(index, event.currentTarget.value)}>
                        <OptionInput value="">{language.apiKeySelectNone}</OptionInput>
                        {#if ref && !getApiKey(ref)}<OptionInput value={ref}>{language.apiKeyDeletedOption}</OptionInput>{/if}
                        {#if ref && getApiKey(ref) && !poolEntries.some((entry) => entry.id === ref)}
                            <OptionInput value={ref}>{getApiKey(ref)?.name}</OptionInput>
                        {/if}
                        {#each poolEntries as entry (entry.id)}
                            <OptionInput value={entry.id}>{entry.name}{showAll && entry.provider ? ` (${entry.provider})` : ''}</OptionInput>
                        {/each}
                        <OptionInput value={newKeyOption}>{language.presetKeyRotationNew}</OptionInput>
                    </SelectInput>
                </div>
                <CopyKeyButton text={ref ? getApiKey(ref)?.key : undefined} />
                <button type="button" class="shrink-0 p-1 text-textcolor2 hover:text-red-400" title={language.presetKeyRotationRemove} aria-label={language.presetKeyRotationRemove} onclick={() => { preset.rotationKeyRefs = (preset.rotationKeyRefs ?? []).filter((_, i) => i !== index); }}><MinusIcon size={18} /></button>
            </div>
        {/key}
    {/each}
    {#if (preset.rotationKeyRefs?.length ?? 0) > 0}
        <span class="text-xs text-textcolor2">{language.presetKeyRotationHelp}{isVertex ? ` ${language.presetKeyRotationVertexHelp}` : ''}</span>
    {/if}

    {#if mode === 'pool'}
        <CheckInput bind:check={showAll} name={language.apiKeyShowAll} className="text-xs mt-1" />
    {:else}
        {#if hasDirectKey}
            <div class="flex justify-end mt-1">
                <ShButton variant="ghost" size="sm" onclick={openSaveDialog}>
                    {language.apiKeySave}
                </ShButton>
            </div>
        {/if}
    {/if}
</div>

<ShDialog bind:open={showSaveDialog} size="sm">
    {#snippet title()}{language.apiKeyNamePrompt}{/snippet}
    <input
        bind:this={nameInput}
        bind:value={pendingName}
        class="border border-darkborderc rounded-md px-3 py-2 text-textcolor bg-transparent focus:ring-borderc focus:ring-2 focus:outline-hidden w-full"
        placeholder={language.apiKeyName}
        autocomplete="off"
        onkeydown={(e) => { if (e.key === 'Enter' && !e.isComposing) confirmSave(); }}
    />
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { showSaveDialog = false; pendingName = ''; }}>{language.cancel}</ShButton>
        <ShButton variant="default" disabled={!pendingName.trim()} onclick={confirmSave}>{language.apiKeyFormSave}</ShButton>
    {/snippet}
</ShDialog>

<ShDialog bind:open={showRotationDialog} onOpenChange={(open) => { if (!open) cancelRotationDialog(); }} size="sm">
    {#snippet title()}{language.presetKeyRotationNew}{/snippet}
    <div class="flex flex-col gap-3 min-w-0">
        <input bind:value={pendingRotationName} class="w-full min-w-0 rounded-md border border-darkborderc bg-transparent px-3 py-2 text-textcolor" placeholder={language.apiKeyName} autocomplete="off" />
        <SecretInput bind:value={pendingRotationKey} fullwidth placeholder={language.apiKeyModeDirect} />
    </div>
    {#snippet footer()}
        <ShButton variant="outline" onclick={cancelRotationDialog}>{language.cancel}</ShButton>
        <ShButton variant="default" disabled={!pendingRotationName.trim() || !pendingRotationKey} onclick={saveRotationKey}>{language.apiKeyFormSave}</ShButton>
    {/snippet}
</ShDialog>
