<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { SettingItem } from 'src/ts/setting/types';
    import { getLabel } from 'src/ts/setting/utils';
    import SettingFieldLabel from './SettingFieldLabel.svelte';

    interface Props {
        item: SettingItem;
        /** The control, rendered right-aligned and vertically centered. */
        control?: Snippet;
        /** Free-text controls: in a row narrower than `@md` the control drops
         * under the label at full width instead of squeezing the label into a
         * narrow column. The row's own width decides, not the window's: the
         * same pages also open in the narrow Ctrl+Q side panel. */
        wideControl?: boolean;
    }

    let { item, control, wideControl = false }: Props = $props();
</script>

<!-- data-setting-id: anchor for settings search deep-links (searchIndex.ts) -->
<div class="@container border-t border-darkborderc" data-setting-id={item.id}>
    <div class="flex justify-between py-3 {wideControl ? 'flex-col gap-2 @md:flex-row @md:items-center @md:gap-3' : 'items-center gap-3'}">
        <div class="flex flex-col min-w-0">
            <SettingFieldLabel
                label={getLabel(item)}
                helpKey={item.helpKey}
                helpUnrecommended={item.helpUnrecommended}
                showExperimental={item.showExperimental}
            />
        </div>
        <div class="shrink-0 {wideControl ? 'w-full @md:w-auto' : ''}">{@render control?.()}</div>
    </div>
</div>
