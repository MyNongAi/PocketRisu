<script lang="ts">
    // Stale-build notice. Mounted globally in App.svelte and driven by
    // `staleBuildNotice` (src/ts/storage/buildFence.ts): the server serves a
    // newer client build, saving in this tab has already stopped, and the tab
    // held unsaved work, so it was not reloaded. The notice keeps that work
    // visible until the user reloads. It cannot be closed, only folded into a
    // bottom banner so the chat behind it can still be read and copied from;
    // the next refused request unfolds it again.
    import { language } from "src/lang";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { TriangleAlertIcon } from "@lucide/svelte";
    import { notifyError } from "src/ts/alert";
    import { downloadUnsavedEdits, reloadIntoNewBuild, staleBuildNotice } from "src/ts/storage/buildFence";

    const notice = $derived($staleBuildNotice);
    let foldedSeq = $state(-1);
    let copiedSeq = $state(-1);
    let textArea: HTMLTextAreaElement | undefined = $state();

    const folded = $derived(!!notice && foldedSeq === notice.seq);
    const copied = $derived(!!notice && copiedSeq === notice.seq);
    const holdsUnsaved = $derived(!!notice && (notice.unsavedText.length > 0 || notice.canDownloadEdits));

    async function copyText() {
        if (!notice) return;
        const seq = notice.seq;
        try {
            await navigator.clipboard.writeText(notice.unsavedText);
        } catch {
            // No clipboard API on plain-HTTP LAN origins: copy the selection.
            textArea?.select();
            if (!document.execCommand('copy')) return;
        }
        copiedSeq = seq;
    }

    async function download() {
        try {
            await downloadUnsavedEdits();
        } catch (error) {
            notifyError(error, { source: 'stale-build' });
        }
    }
</script>

{#if notice && folded}
    <!-- At the bottom: it covers only the chat input, which cannot save here
         anyway, and leaves the navigation at the top usable. -->
    <div
        class="fixed inset-x-0 bottom-0 z-[60] flex flex-wrap items-center justify-center gap-2 border-t border-draculared/40 bg-darkbg px-4 pt-2 text-sm text-textcolor shadow-lg"
        style="padding-bottom: max(0.5rem, env(safe-area-inset-bottom));"
        role="alert"
    >
        <TriangleAlertIcon class="size-4 shrink-0 text-red-400" />
        <span class="leading-relaxed">{language.staleBuildBanner}</span>
        <ShButton size="sm" variant="outline" onclick={() => { foldedSeq = -1; }}>
            {language.staleBuildShow}
        </ShButton>
        <ShButton size="sm" variant="primary" onclick={() => reloadIntoNewBuild()}>
            {language.staleBuildReload}
        </ShButton>
    </div>
{:else if notice}
    <ShDialog
        open={true}
        closable={false}
        closeOnEscape={false}
        closeOnOutsideClick={false}
        tier="top"
        size="default"
        footer={footerActions}
    >
        {#snippet title()}{language.staleBuildTitle}{/snippet}

        <div class="flex flex-col gap-3 text-sm leading-relaxed text-textcolor2">
            <p>{language.staleBuildDetail}</p>
            {#if notice.reloadTried}
                <div class="flex items-center gap-2.5 rounded-md border border-draculared/40 bg-draculared/20 px-4 py-3 text-red-300">
                    <TriangleAlertIcon class="size-4 shrink-0 text-red-400" />
                    <span>{language.staleBuildReloadTried}</span>
                </div>
            {/if}
            {#if notice.unsavedText}
                <div class="flex flex-col gap-1.5">
                    <div class="flex items-center justify-between gap-2">
                        <span class="font-medium text-textcolor">{language.staleBuildUnsentInput}</span>
                        <ShButton size="sm" variant="outline" onclick={copyText}>
                            {copied ? language.staleBuildCopied : language.staleBuildCopy}
                        </ShButton>
                    </div>
                    <textarea
                        bind:this={textArea}
                        class="h-32 w-full resize-y rounded-md border border-darkborderc bg-bgcolor p-2 text-sm text-textcolor"
                        readonly
                        value={notice.unsavedText}
                    ></textarea>
                </div>
            {/if}
        </div>
    </ShDialog>
{/if}

{#snippet footerActions()}
    <div class="flex flex-wrap justify-end gap-2">
        {#if notice}
            <ShButton variant="outline" onclick={() => { foldedSeq = notice.seq; }}>
                {language.staleBuildCollapse}
            </ShButton>
            {#if notice.canDownloadEdits}
                <ShButton variant="outline" onclick={download}>
                    {language.sessionUnsavedDownload}
                </ShButton>
            {/if}
            <ShButton variant={holdsUnsaved ? 'destructive' : 'primary'} onclick={() => reloadIntoNewBuild()}>
                {holdsUnsaved ? language.staleBuildReloadDiscard : language.staleBuildReload}
            </ShButton>
        {/if}
    </div>
{/snippet}
