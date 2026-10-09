<script lang="ts">
    // Right-click menu (a long press on touch) for one element, in the look of
    // ShDropdownMenuContent; bits-ui shares menu items between the two, so
    // `items` holds ShDropdownMenuItem rows. `trigger` gets the props to
    // spread on the element first; its own attributes after them win.
    // z-[45]: above a base-tier dialog (z-40), under the alert it may open (z-50).
    import { ContextMenu } from 'bits-ui';
    import type { Snippet } from 'svelte';
    import { cn } from 'src/lib/utils';

    interface Props {
        trigger: Snippet<[Record<string, unknown>]>;
        items: Snippet;
        disabled?: boolean;
        class?: string;
    }

    let { trigger, items, disabled = false, class: className }: Props = $props();
</script>

<ContextMenu.Root>
    <ContextMenu.Trigger {disabled} tabindex={0}>
        {#snippet child({ props })}
            {@render trigger(props)}
        {/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
        <ContextMenu.Content
            class={cn(
                'z-[45] min-w-32 rounded-md border border-darkborderc bg-darkbg text-textcolor p-1 shadow-md outline-none ' +
                'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
                'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ' +
                'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
                className
            )}
        >
            {@render items()}
        </ContextMenu.Content>
    </ContextMenu.Portal>
</ContextMenu.Root>
