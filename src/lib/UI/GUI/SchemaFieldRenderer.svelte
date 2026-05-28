<script lang="ts">
    import type { RegistryFieldSchema, RegistryUiField } from "src/ts/preset/types";
    import TextInput from "./TextInput.svelte";
    import TextAreaInput from "./TextAreaInput.svelte";
    import NumberInput from "./NumberInput.svelte";
    import SliderInput from "./SliderInput.svelte";
    import SelectInput from "./SelectInput.svelte";
    import OptionInput from "./OptionInput.svelte";
    import CheckInput from "./CheckInput.svelte";

    interface Props {
        schemaField: RegistryFieldSchema;
        uiField: RegistryUiField;
        userValues: Record<string, unknown>;
    }

    let { schemaField, uiField, userValues = $bindable() }: Props = $props();

    const fieldKey = $derived(schemaField.key);

    // JSON widget: stringify on read, parse on write. Errors surface inline.
    // We seed jsonText from userValues once on mount, then user edits jsonText
    // and an $effect parses+commits on every change (invalid JSON keeps the
    // last good value but shows the error).
    let jsonText = $state('');
    let jsonError = $state<string | null>(null);
    let jsonInitialized = $state(false);

    $effect(() => {
        if (uiField.widget !== 'json' && uiField.widget !== 'key-value') return;
        if (jsonInitialized) return;
        const v = userValues[fieldKey];
        try {
            jsonText = v === undefined || v === null ? '' : JSON.stringify(v, null, 2);
        } catch {
            jsonText = '';
        }
        jsonInitialized = true;
    });

    $effect(() => {
        if (uiField.widget !== 'json' && uiField.widget !== 'key-value') return;
        if (!jsonInitialized) return;
        if (jsonText.trim() === '') {
            userValues[fieldKey] = undefined;
            jsonError = null;
            return;
        }
        try {
            userValues[fieldKey] = JSON.parse(jsonText);
            jsonError = null;
        } catch (e) {
            jsonError = e instanceof Error ? e.message : String(e);
        }
    });
</script>

<div class="flex flex-col gap-1">
    <span class="text-sm text-textcolor flex items-center gap-1">
        {schemaField.label}
        {#if schemaField.required}<span class="text-red-400">*</span>{/if}
    </span>
    {#if schemaField.description}
        <span class="text-xs text-textcolor2">{schemaField.description}</span>
    {/if}

    {#if uiField.widget === 'text'}
        <TextInput
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
        />
    {:else if uiField.widget === 'secret'}
        <TextInput
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
            hideText
        />
    {:else if uiField.widget === 'textarea'}
        <TextAreaInput
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
            autocomplete="off"
            height="24"
        />
    {:else if uiField.widget === 'number-input'}
        <NumberInput
            bind:value={userValues[fieldKey] as number}
            min={schemaField.min}
            max={schemaField.max}
            fullwidth
        />
    {:else if uiField.widget === 'slider'}
        <SliderInput
            bind:value={userValues[fieldKey] as number}
            min={schemaField.min ?? 0}
            max={schemaField.max ?? 100}
            step={schemaField.step ?? 1}
        />
    {:else if uiField.widget === 'select'}
        <SelectInput bind:value={userValues[fieldKey] as string}>
            {#each schemaField.enum ?? [] as opt}
                <OptionInput value={String(opt.value)}>{opt.label}</OptionInput>
            {/each}
        </SelectInput>
    {:else if uiField.widget === 'segmented'}
        <SelectInput bind:value={userValues[fieldKey] as string}>
            {#each schemaField.enum ?? [] as opt}
                <OptionInput value={String(opt.value)}>{opt.label}</OptionInput>
            {/each}
        </SelectInput>
    {:else if uiField.widget === 'toggle'}
        <CheckInput bind:check={userValues[fieldKey] as boolean} name={schemaField.label} />
    {:else if uiField.widget === 'json' || uiField.widget === 'key-value'}
        <TextAreaInput
            bind:value={jsonText}
            placeholder={uiField.placeholder ?? '{}'}
            fullwidth
            autocomplete="off"
            height="32"
        />
        {#if jsonError}
            <span class="text-xs text-red-400">{jsonError}</span>
        {/if}
    {/if}
</div>
