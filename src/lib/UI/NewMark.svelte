<script lang="ts">
    // The mark on a bot or module received and not looked at yet
    // (newMarks.svelte.ts). It was the 🆕 emoji, which some screens draw
    // white and hard to tell apart (the user's report, 2026-10-26): a filled
    // NEW badge reads the same on every screen and theme.
    import { language } from "src/lang";

    let { class: className = '' }: { class?: string } = $props();
</script>

<span class="inline-block shrink-0 select-none rounded bg-yellow-400 px-[3px] align-middle text-[9px] font-bold leading-[13px] text-black {className}" aria-label={language.newlyReceived} title={language.newlyReceived}>NEW</span>
