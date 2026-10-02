<script lang="ts">
    // The round button a question alert folds into when a tap lands outside
    // it (AlertComp). The question stays unanswered, and the app usable,
    // until the button brings it back.
    import { MessageCircleQuestionMarkIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import { alertMinimizedStore, alertStore } from 'src/ts/stores.svelte';

    const QUESTION_TYPES = new Set(['ask', 'pluginconfirm', 'select', 'confirmMulti', 'input', 'tos']);
</script>

{#if $alertMinimizedStore && QUESTION_TYPES.has($alertStore.type)}
    <button
        type="button"
        class="fixed right-4 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-50 flex size-12 items-center justify-center rounded-full border border-darkborderc bg-darkbg text-textcolor shadow-lg ring-2 ring-borderc hover:bg-selected"
        title={language.alertMinimizedReopen}
        aria-label={language.alertMinimizedReopen}
        onclick={() => alertMinimizedStore.set(false)}
    >
        <span class="pointer-events-none absolute inset-0 animate-ping rounded-full ring-2 ring-borderc opacity-40"></span>
        <MessageCircleQuestionMarkIcon size={22} />
    </button>
{/if}
