<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import { changeColorScheme, colorSchemeList } from 'src/ts/gui/colorscheme';
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte';
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte';

    const onSchemeInputChange = (e: Event) => {
        changeColorScheme((e.target as HTMLInputElement).value);
    };
</script>

<div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-textcolor">{language.colorScheme}</span>
        {#if language.help.colorScheme}<p class="text-xs text-textcolor2 mt-0.5">{language.help.colorScheme}</p>{/if}
    </div>
    <div class="shrink-0">
        <SelectInput className="w-48" size="sm" value={DBState.db.colorSchemeName} onchange={onSchemeInputChange}>
            {#each colorSchemeList as scheme}
                <OptionInput value={scheme}>{scheme}</OptionInput>
            {/each}
            <OptionInput value="custom">Custom</OptionInput>
        </SelectInput>
    </div>
</div>
