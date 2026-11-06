<script lang="ts">
    import { tick } from 'svelte';
    import { language } from 'src/lang';
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte';
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte';
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte';
    import { closeProtonLinkPrompt, protonLinkPromptState } from 'src/ts/protonLinkPrompt.svelte';

    let form: HTMLFormElement | undefined = $state();

    $effect(() => {
        if (!protonLinkPromptState.open) return;
        let cancelled = false;
        let frame: number | undefined;
        // Focus after the dialog's own focus scope has opened.
        void tick().then(() => {
            if (cancelled) return;
            frame = requestAnimationFrame(() => form?.querySelector('input')?.focus());
        });
        return () => {
            cancelled = true;
            if (frame !== undefined) cancelAnimationFrame(frame);
        };
    });
</script>

<ShDialog
    bind:open={protonLinkPromptState.open}
    onOpenChange={(open) => { if (!open) closeProtonLinkPrompt(); }}
    size="lg"
    tier="base"
    closeOnEscape={true}
    closeOnOutsideClick={false}
>
    {#snippet title()}{protonLinkPromptState.destination === 'character' ? language.importFromProtonAsBot : language.importFromProtonAsModule}{/snippet}

    <div class="flex flex-col gap-3">
        <p class="text-sm text-textcolor2">{protonLinkPromptState.destination === 'character' ? language.protonLinkCharacterDesc : language.protonLinkModuleDesc}</p>
        <form bind:this={form} class="flex gap-2" onsubmit={(e) => {
            e.preventDefault();
            if (protonLinkPromptState.text.trim()) closeProtonLinkPrompt(protonLinkPromptState.text);
        }}>
            <ShInput
                bind:value={protonLinkPromptState.text}
                className="flex-1 min-w-0"
                placeholder="https://drive.proton.me/urls/..."
                aria-label={language.protonDriveUrlPrompt}
                autocomplete="off"
                spellcheck={false}
            />
            <ShButton type="submit" variant="primary" disabled={!protonLinkPromptState.text.trim()}>{language.protonImportOpen}</ShButton>
        </form>
        <p class="text-xs text-textcolor2">{language.protonLinkServerNotice}</p>
        <div class="flex justify-end">
            <ShButton size="sm" variant="outline" onclick={() => closeProtonLinkPrompt()}>{language.cancel}</ShButton>
        </div>
    </div>
</ShDialog>
