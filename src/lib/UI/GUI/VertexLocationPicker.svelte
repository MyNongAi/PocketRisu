<script lang="ts">
    import { pickRegistryLocale } from 'src/ts/preset/registry/i18n';
    import { language } from 'src/lang';
    import { VERTEX_LOCATIONS, isKnownVertexLocation, isVertexGlobalOnlyModel, vertexLocationLabel } from 'src/ts/preset/vertexLocations';
    import ShSelect from './ShSelect.svelte';
    import OptionInput from './OptionInput.svelte';
    import TextInput from './TextInput.svelte';

    interface Props {
        value: string | undefined;
        placeholder?: string;
        modelId?: string;
    }

    let { value = $bindable(), placeholder = '', modelId }: Props = $props();
    const customOption = '__vertex_custom_location__';
    const locale = $derived(pickRegistryLocale());
    // "직접 입력" picked while the value is still a listed region (or blank).
    let customSelected = $state(false);
    // The field's reset button clears the value: show the list again.
    $effect(() => {
        if (value === undefined) customSelected = false;
    });
    // Blank means global (the adapter's default), shown without writing it.
    const selected = $derived(
        customSelected || (value !== undefined && value !== '' && !isKnownVertexLocation(value))
            ? customOption
            : value || 'global'
    );

    function selectLocation(event: Event & { currentTarget: EventTarget & HTMLSelectElement }) {
        const picked = event.currentTarget.value;
        if (picked === customOption) {
            customSelected = true;
        } else {
            customSelected = false;
            value = picked;
        }
    }
</script>

<div class="flex w-full min-w-0 flex-col gap-2">
    <ShSelect value={selected} onchange={selectLocation} className="w-full min-w-0">
        {#each VERTEX_LOCATIONS as location}
            <OptionInput value={location.value}>{vertexLocationLabel(location.value, locale)}</OptionInput>
        {/each}
        <OptionInput value={customOption}>{locale === 'ko' ? '직접 입력' : 'Custom…'}</OptionInput>
    </ShSelect>
    {#if selected === customOption}
        <TextInput bind:value={value as string} {placeholder} fullwidth className="min-w-0 max-w-full" />
    {/if}
    <!-- VERTEX-LOCATION-PICKER: global-only models warn on a regional Location. -->
    {#if value && value !== 'global' && isVertexGlobalOnlyModel(modelId)}
        <span class="min-w-0 max-w-full text-xs text-warning break-words">{language.vertexGlobalOnlyLocationWarning}</span>
    {/if}
</div>
