<script lang="ts">
  // A bot thumbnail's border (characterRings.svelte.ts): yellow round the bot
  // on screen, green round one whose reply came in. Placed inside the
  // thumbnail's own positioned box, over the image and under the marks.
  import { characterRings } from "src/ts/gui/characterRings.svelte";
  import { language } from "src/lang";

  interface Props {
    chaId: string | undefined;
    rounded: boolean;
    /** Thumbnails of 40px and less. */
    thin?: boolean;
  }

  let { chaId, rounded, thin = false }: Props = $props();

  let ring = $derived(characterRings.of(chaId));
  let label = $derived(ring === 'current' ? language.currentCharacterRing : language.replyArrivedRing);
</script>

{#if ring}
  <span class="pointer-events-none absolute inset-0 z-5 {thin ? 'border-2' : 'border-[3px]'} {ring === 'current' ? 'border-yellow-400' : 'border-emerald-400'}"
    class:rounded-md={!rounded} class:rounded-full={rounded}
    data-ring={ring}
    aria-label={label}
    title={label}></span>
{/if}
