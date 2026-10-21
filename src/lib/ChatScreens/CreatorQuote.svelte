<div class="flex w-full justify-center mt-4 max-w-100vw">
    <!-- A Proton share link here opens in the app (openBotNotesProtonLink). -->
    <div class="w-5/6 max-w-80vw bg-darkbg rounded-md p-3 text-textcolor text-sm" role="presentation" onclickcapture={openProtonLink}>
        <h1 class="font-bold mb-2">{language.creatorNotes}
            <button class="float-right" onclick={onRemove}>
                <XIcon />
            </button>
        </h1>
        <MultiLangDisplay value={quote} markdown={true} />
    </div>
</div>
<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import MultiLangDisplay from "../UI/GUI/MultiLangDisplay.svelte";
    import { openBotNotesProtonLink, protonShareLinkOf } from "src/ts/realmCompanionModule";

    interface Props {
        onRemove: () => void;
        quote: string;
        /** The bot the notes belong to: modules from a clicked Proton link pair with it. */
        chaId?: string;
    }

    let { onRemove, quote, chaId }: Props = $props();

    // A Proton share link in the notes opens the Proton browser in the app
    // instead of the site; what is imported from it is paired with this bot
    // (the user's request, 2026-10-22). Other links behave as before.
    function openProtonLink(event: MouseEvent) {
        if (!chaId || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return
        const link = protonShareLinkOf((event.target as Element | null)?.closest('a[href]') ?? null)
        if (!link) return
        event.preventDefault()
        event.stopPropagation()
        void openBotNotesProtonLink(chaId, link)
    }
</script>