<script lang="ts">
    // Developer-only panel. Mounted from NodeOnlySettings.svelte behind a
    // localStorage toggle: localStorage.setItem('risu-dev-panel', '1') to show.
    // Used for component previews, migration validation, and other debug widgets
    // that shouldn't ship to normal users.
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShAlertDialog from "src/lib/UI/GUI/ShAlertDialog.svelte";
    import ShLoadingDialog from "src/lib/UI/GUI/ShLoadingDialog.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { alertWait, alertClear, alertError } from "src/ts/alert";

    let dialogOpen = $state(false);
    let dialogNoCloseOpen = $state(false);
    let dialogLargeOpen = $state(false);
    let alertOpen = $state(false);
    let alertDestructiveOpen = $state(false);
    let inputOpen = $state(false);
    let inputValue = $state('');
    let selectOpen = $state(false);
    let markdownOpen = $state(false);
    let loadingOpen = $state(false);
    let loadingProgressOpen = $state(false);
    let progressValue = $state(0);
    let progressTimer: number | null = null;
    let lastResult = $state('');

    function submitInput() {
        lastResult = `input: "${inputValue}"`;
        inputOpen = false;
    }

    function triggerWait() {
        alertWait('Loading... (3s)');
        lastResult = 'wait: shown (auto-clears in 3s). Try ESC — settings should close (doingAlert() false for wait).';
        setTimeout(() => alertClear(), 3000);
    }

    function triggerErrorWithStack() {
        alertError(new Error('Sample error with stack trace'));
        lastResult = 'alertError(new Error(...)): stack trace visible via Show details';
    }

    function triggerErrorNoStack() {
        alertError('Simple error message (no stack trace)');
        lastResult = 'alertError("..."): string form, no stack trace';
    }

    function openLoading(durationMs = 3000) {
        loadingOpen = true;
        lastResult = 'loading: shown (auto-closes in ' + (durationMs / 1000) + 's). ESC fully blocked.';
        setTimeout(() => { loadingOpen = false }, durationMs);
    }

    function openProgress() {
        progressValue = 0;
        loadingProgressOpen = true;
        lastResult = 'progress: simulating 0 → 100%';
        if (progressTimer != null) clearInterval(progressTimer);
        progressTimer = window.setInterval(() => {
            progressValue += 5;
            if (progressValue >= 100) {
                progressValue = 100;
                if (progressTimer != null) clearInterval(progressTimer);
                progressTimer = null;
                setTimeout(() => { loadingProgressOpen = false }, 400);
            }
        }, 150);
    }

    function disablePanel() {
        localStorage.removeItem('risu-dev-panel');
        location.reload();
    }
</script>

<div class="mt-8 flex flex-col gap-3 border-t border-darkborderc pt-6">
    <div class="flex items-center justify-between flex-wrap gap-2">
        <h2 class="text-lg font-semibold text-textcolor">Dev Panel</h2>
        <ShButton variant="ghost" size="sm" onclick={disablePanel}>
            Disable panel
        </ShButton>
    </div>
    <p class="text-xs text-textcolor2">
        Toggled via <code class="bg-bgcolor px-1 py-0.5 rounded">localStorage['risu-dev-panel']='1'</code>.
        Not shipped to users unless they opt in from devtools.
    </p>

    <div class="mt-2 flex flex-col gap-2">
        <h3 class="text-sm font-semibold text-textcolor">Sh Popup Preview</h3>
        <p class="text-xs text-textcolor2">
            Each button either opens a raw Sh* dialog (design preview) or triggers a real alert* call (phase validation).
            ESC is blocked for all Sh dialogs; dismissal via X button, backdrop click (when allowed), or footer actions only.
        </p>

        <div class="flex flex-wrap gap-2 mt-2">
            <ShButton variant="destructive" onclick={triggerErrorWithStack}>alertError (with stack)</ShButton>
            <ShButton variant="destructive" onclick={triggerErrorNoStack}>alertError (no stack)</ShButton>
            <ShButton onclick={() => { dialogOpen = true }}>Dialog (default)</ShButton>
            <ShButton variant="outline" onclick={() => { dialogNoCloseOpen = true }}>Dialog (no close)</ShButton>
            <ShButton variant="secondary" onclick={() => { dialogLargeOpen = true }}>Dialog (lg)</ShButton>
            <ShButton variant="secondary" onclick={() => { markdownOpen = true }}>Markdown preview</ShButton>
            <ShButton variant="outline" onclick={() => { inputValue = ''; inputOpen = true }}>Input (text)</ShButton>
            <ShButton variant="outline" onclick={() => { selectOpen = true }}>Select (options)</ShButton>
            <ShButton variant="outline" onclick={() => { alertOpen = true }}>AlertDialog (YES/NO)</ShButton>
            <ShButton variant="destructive" onclick={() => { alertDestructiveOpen = true }}>AlertDialog (destructive)</ShButton>
            <ShButton variant="ghost" onclick={triggerWait}>Trigger alertWait (3s)</ShButton>
            <ShButton variant="secondary" onclick={() => openLoading()}>ShLoadingDialog (spinner)</ShButton>
            <ShButton variant="secondary" onclick={openProgress}>ShLoadingDialog (progress)</ShButton>
        </div>

        {#if lastResult}
            <div class="mt-3 p-3 bg-bgcolor border border-darkborderc rounded-md text-sm text-textcolor font-mono break-all">
                last result: {lastResult}
            </div>
        {/if}
    </div>
</div>

<ShDialog bind:open={dialogOpen}>
    {#snippet title()}Sample Dialog{/snippet}
    {#snippet description()}
        Closable via X button, outside click, or footer actions.
    {/snippet}
    <p class="text-sm text-textcolor2">
        Body content goes here. Max height is 90vh with scroll.
    </p>
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { dialogOpen = false; lastResult = 'dialog: cancel' }}>Cancel</ShButton>
        <ShButton onclick={() => { dialogOpen = false; lastResult = 'dialog: OK' }}>OK</ShButton>
    {/snippet}
</ShDialog>

<ShDialog bind:open={dialogNoCloseOpen} closable={false} closeOnOutsideClick={false}>
    {#snippet title()}Forced Choice{/snippet}
    {#snippet description()}
        Outside click blocked. X button hidden. User must pick a footer action.
    {/snippet}
    <p class="text-sm text-textcolor2">
        Fits <code class="text-xs bg-bgcolor px-1 py-0.5 rounded">select</code> and
        <code class="text-xs bg-bgcolor px-1 py-0.5 rounded">input</code> types that require explicit commit.
    </p>
    {#snippet footer()}
        <ShButton onclick={() => { dialogNoCloseOpen = false; lastResult = 'forced: committed' }}>Commit</ShButton>
    {/snippet}
</ShDialog>

<ShDialog bind:open={dialogLargeOpen} size="lg">
    {#snippet title()}Large Dialog{/snippet}
    {#snippet description()}Wider content area (max-w-2xl).{/snippet}
    <div class="flex flex-col gap-2 text-sm text-textcolor2">
        <p>Useful for markdown previews, longer form content, card details.</p>
        <p>Available sizes: <code class="text-xs bg-bgcolor px-1 py-0.5 rounded">sm</code>, <code class="text-xs bg-bgcolor px-1 py-0.5 rounded">default</code>, <code class="text-xs bg-bgcolor px-1 py-0.5 rounded">lg</code>, <code class="text-xs bg-bgcolor px-1 py-0.5 rounded">xl</code>.</p>
    </div>
    {#snippet footer()}
        <ShButton onclick={() => { dialogLargeOpen = false; lastResult = 'lg: closed' }}>Close</ShButton>
    {/snippet}
</ShDialog>

<ShDialog bind:open={inputOpen} closable={false} closeOnOutsideClick={false}>
    {#snippet title()}Enter a value{/snippet}
    {#snippet description()}
        Text input with Enter-to-submit. Outside click blocked.
    {/snippet}
    <input
        type="text"
        class="w-full h-10 px-3 bg-bgcolor border border-darkborderc rounded-md text-textcolor
               placeholder:text-textcolor2/60 outline-none
               focus-visible:ring-2 focus-visible:ring-borderc/50 focus-visible:border-borderc
               transition-colors"
        placeholder="Type something and press Enter"
        bind:value={inputValue}
        onkeydown={(e) => { if (e.key === 'Enter' && !e.isComposing) submitInput() }}
    />
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { inputValue = ''; inputOpen = false; lastResult = 'input: cancel' }}>Cancel</ShButton>
        <ShButton onclick={submitInput}>OK</ShButton>
    {/snippet}
</ShDialog>

<ShDialog bind:open={selectOpen} closable={false} closeOnOutsideClick={false}>
    {#snippet title()}Pick an option{/snippet}
    {#snippet description()}
        Mutually exclusive choice. User must pick one to commit.
    {/snippet}
    <div class="flex flex-col gap-2">
        {#each ['Option A', 'Option B', 'Option C'] as opt, i}
            <button
                class="w-full text-left px-3 h-10 flex items-center border border-darkborderc rounded-md
                       text-textcolor bg-transparent hover:bg-selected/30 transition-colors
                       focus-visible:ring-2 focus-visible:ring-borderc/50 focus-visible:border-borderc
                       outline-none cursor-pointer"
                onclick={() => { selectOpen = false; lastResult = `select: ${opt} (index ${i})` }}
            >
                {opt}
            </button>
        {/each}
    </div>
</ShDialog>

<ShDialog bind:open={markdownOpen} size="lg">
    {#snippet title()}Markdown Preview (lg size){/snippet}
    <div class="prose prose-invert max-w-none text-sm text-textcolor">
        <h3>Longer content sample</h3>
        <p>Use <code>size="lg"</code> for markdown / long-form content. Max height 90vh with scroll.</p>
        <ul>
            <li>Item one</li>
            <li>Item two</li>
            <li>Item three</li>
        </ul>
        <pre class="bg-bgcolor border border-darkborderc p-2 rounded-md text-xs overflow-x-auto"><code>alertMd(msg)  // renders parsed markdown inside ShDialog</code></pre>
    </div>
    {#snippet footer()}
        <ShButton onclick={() => { markdownOpen = false; lastResult = 'markdown: OK' }}>OK</ShButton>
    {/snippet}
</ShDialog>

<ShAlertDialog bind:open={alertOpen}>
    {#snippet title()}Confirm Action{/snippet}
    {#snippet description()}
        AlertDialog — no X button, outside click blocked. User must pick YES or NO.
    {/snippet}
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { alertOpen = false; lastResult = 'alert: no' }}>NO</ShButton>
        <ShButton onclick={() => { alertOpen = false; lastResult = 'alert: yes' }}>YES</ShButton>
    {/snippet}
</ShAlertDialog>

<ShAlertDialog bind:open={alertDestructiveOpen}>
    {#snippet title()}Delete This Item?{/snippet}
    {#snippet description()}
        This action cannot be undone. The destructive variant of ShButton is reserved for
        permanent deletions. Plugin warnings use the same <code class="text-xs bg-bgcolor px-1 py-0.5 rounded">draculared</code> tone.
    {/snippet}
    {#snippet footer()}
        <ShButton variant="outline" onclick={() => { alertDestructiveOpen = false; lastResult = 'destructive: cancel' }}>Cancel</ShButton>
        <ShButton variant="destructive" onclick={() => { alertDestructiveOpen = false; lastResult = 'destructive: delete' }}>Delete</ShButton>
    {/snippet}
</ShAlertDialog>

<ShLoadingDialog
    bind:open={loadingOpen}
    message="Saving local backup..."
    submessage="Do not close the app."
/>

<ShLoadingDialog
    bind:open={loadingProgressOpen}
    message="Uploading character assets"
    submessage="Progress auto-simulated for preview"
    progress={progressValue}
/>
