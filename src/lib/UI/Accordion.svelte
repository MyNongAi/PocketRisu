<script lang="ts">
    import type { language } from "src/lang";
    import Help from "../Others/Help.svelte";
    import ShAccordion from "./GUI/ShAccordion.svelte";

    interface Props {
        name?: string;
        styled?: boolean;
        help?: (keyof (typeof language.help))|'';
        disabled?: boolean;
        children?: import('svelte').Snippet;
        className?: string;
    }

    let {
        name = "",
        styled = false,
        help = '',
        disabled = false,
        children,
        className = ""
    }: Props = $props();

    // Evaluation override: force plain across all call sites so the variant
    // can be judged in real layouts. Restore styled→{card|plain} mapping
    // once the variant is decided.
    const variant = 'card';
</script>

{#snippet helpExtras()}
    <Help key={help as keyof (typeof language.help)} />
{/snippet}

{#if disabled}
    {@render children?.()}
{:else}
    <!-- mt-2 is a legacy quirk of the original <Accordion styled> wrapper: -->
    <!-- it baked the inter-section gap into the component itself. Kept here -->
    <!-- so call sites stay untouched. Drop when call sites migrate to -->
    <!-- ShAccordion direct + parent-controlled gap. -->
    <div class="mt-2">
        <ShAccordion
            {name}
            {variant}
            bodyClass={className}
            extras={help ? helpExtras : undefined}
        >
            {@render children?.()}
        </ShAccordion>
    </div>
{/if}
