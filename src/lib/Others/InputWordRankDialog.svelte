<script lang="ts">
    import { language } from "src/lang";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { cn } from "src/lib/utils";
    import { DBState, selectedCharID } from "src/ts/stores.svelte";
    import {
        inputWordRankOpen, loadInputWordRankOptions, rankInputWords, saveInputWordRankOptions,
        type InputWordRankOptions, type InputWordRankResult, type InputWordRankScope,
    } from "src/ts/inputWordRank";

    type Tab = 'words' | 'phrases' | 'sentences';

    let options = $state<InputWordRankOptions>(loadInputWordRankOptions());
    let result = $state<InputWordRankResult | null>(null);
    let running = $state(false);
    let error = $state('');
    let tab = $state<Tab>('words');
    let showText = $state(false);
    let controller: AbortController | null = null;

    // The bot and chat open now, for "this chat" and "this bot".
    let current = $derived.by(() => {
        const character = DBState.db.characters?.[$selectedCharID];
        if (!character?.chaId) return null;
        return { chaId: character.chaId, chatId: character.chats?.[character.chatPage ?? 0]?.id };
    });

    // Functions, not constants: the popup is mounted at startup, before the
    // app language is set, and reads the labels each time it opens.
    const scopes = (): { value: InputWordRankScope; label: string }[] => [
        { value: 'chat', label: language.inputWordRankScopeChat },
        { value: 'char', label: language.inputWordRankScopeChar },
        { value: 'all', label: language.inputWordRankScopeAll },
    ];
    const checks = (): { key: 'particles' | 'parens' | 'english' | 'botInputs'; label: string }[] => [
        { key: 'particles', label: language.inputWordRankParticles },
        { key: 'parens', label: language.inputWordRankParens },
        { key: 'english', label: language.inputWordRankEnglish },
        { key: 'botInputs', label: language.inputWordRankBotInputs },
    ];
    const tabs = (): { value: Tab; label: string }[] => [
        { value: 'words', label: language.inputWordRankWords },
        { value: 'phrases', label: language.inputWordRankPhrases },
        { value: 'sentences', label: language.inputWordRankSentences },
    ];

    let rows = $derived(result ? result[tab] : []);
    let top = $derived(rows[0]?.[1] ?? 1);
    let asText = $derived(rows.map(([text, n], i) => `${i + 1}. ${text} (${n})`).join('\n'));
    let summary = $derived.by(() => {
        const t = result?.totals;
        if (!t) return '';
        return [
            language.inputWordRankTotals(t.bots, t.deactivatedBots, t.chats, t.inputs, t.words),
            t.copies ? language.inputWordRankCopies(t.copies) : '',
            t.botInputs ? language.inputWordRankBotInputsLeft(t.botInputs) : '',
            t.failed ? language.inputWordRankFailed(t.failed) : '',
            t.approximate ? language.inputWordRankApprox : '',
        ].filter(Boolean).join(' · ');
    });

    async function run() {
        if (running) return;
        if (options.scope !== 'all' && !current) { error = language.inputWordRankOpenChat; return; }
        running = true;
        error = '';
        result = null;
        const request = $state.snapshot(options);
        saveInputWordRankOptions(request);
        const ownController = new AbortController();
        controller = ownController;
        try {
            const answer = await rankInputWords({ ...request, chaId: current?.chaId, chatId: current?.chatId }, ownController.signal);
            if (ownController.signal.aborted) return;
            if (!answer) { error = language.inputWordRankGone; return; }
            result = answer;
            tab = 'words';
            showText = false;
        } catch (e) {
            if (!ownController.signal.aborted) error = e instanceof Error ? e.message : String(e);
        } finally {
            if (controller === ownController) { controller = null; running = false; }
        }
    }

    function cancel() {
        controller?.abort();
        controller = null;
        running = false;
    }

    $effect(() => {
        if (!$inputWordRankOpen) cancel();
    });

    const chip = (on: boolean) => cn(
        'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm cursor-pointer select-none',
        on ? 'border-primary bg-primary/15 text-textcolor' : 'border-darkborderc bg-darkbutton text-textcolor2',
    );
</script>

<ShDialog
    bind:open={$inputWordRankOpen}
    size="lg"
    tier="base"
    ariaLabel={language.inputWordRank}
    contentClass="gap-3"
>
    {#snippet title()}{language.inputWordRank}{/snippet}
    {#snippet description()}{language.inputWordRankDesc}{/snippet}

    <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label={language.inputWordRank}>
        {#each scopes() as scope (scope.value)}
            <label class={chip(options.scope === scope.value)}>
                <input type="radio" class="accent-primary" name="input-word-rank-scope" value={scope.value} bind:group={options.scope} disabled={running} />
                {scope.label}
            </label>
        {/each}
        {#if options.scope === 'all'}
            <label class={chip(options.deactivated)}>
                <input type="checkbox" class="accent-primary" bind:checked={options.deactivated} disabled={running} />
                {language.inputWordRankDeactivated}
            </label>
        {/if}
    </div>
    <div class="flex flex-wrap gap-1.5">
        {#each checks() as check (check.key)}
            <label class={chip(options[check.key])}>
                <input type="checkbox" class="accent-primary" bind:checked={options[check.key]} disabled={running} />
                {check.label}
            </label>
        {/each}
    </div>
    <input
        type="text"
        class="w-full rounded-md border border-darkborderc bg-darkbutton px-3 py-2 text-sm text-textcolor placeholder:text-textcolor2"
        placeholder={language.inputWordRankExclude}
        bind:value={options.exclude}
        disabled={running}
    />
    <div class="flex items-center gap-2">
        {#if running}
            <ShButton variant="outline" onclick={cancel}>{language.cancel}</ShButton>
            <span class="text-sm text-textcolor2" aria-live="polite">{language.inputWordRankCounting}</span>
        {:else}
            <ShButton variant="primary" onclick={run} data-input-word-rank-run>{language.inputWordRankRun}</ShButton>
        {/if}
    </div>
    {#if error}
        <p class="text-sm text-red-500" role="alert">{error}</p>
    {/if}

    {#if result}
        <p class="text-xs text-textcolor2 break-keep" data-input-word-rank-summary>{summary}</p>
        <div class="grid grid-cols-3 gap-1.5" role="tablist">
            {#each tabs() as t (t.value)}
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === t.value}
                    class={cn('rounded-md border px-2 py-1.5 text-sm', tab === t.value ? 'border-primary bg-primary/15 text-textcolor' : 'border-darkborderc bg-darkbutton text-textcolor2')}
                    onclick={() => { tab = t.value; showText = false; }}
                >{t.label} {result[t.value].length}</button>
            {/each}
        </div>
        {#if rows.length === 0}
            <p class="text-sm text-textcolor2">{tab === 'words' ? language.inputWordRankNoWords : language.inputWordRankNoRepeats}</p>
        {:else}
            {#if tab !== 'words'}
                <p class="text-xs text-textcolor2">{language.inputWordRankRepeatsOnly}</p>
            {/if}
            <ol class="flex flex-col" data-input-word-rank-list>
                {#each rows as [text, n], i (i)}
                    <li class="grid grid-cols-[2.2em_1fr_auto] items-center gap-x-2 gap-y-1 border-b border-darkborderc/60 px-1 py-1.5 text-sm">
                        <span class="text-right text-xs text-textcolor2">{i + 1}</span>
                        <span class="text-textcolor [overflow-wrap:anywhere]">{text}</span>
                        <span class="tabular-nums text-textcolor2">{n.toLocaleString()}</span>
                        <span class="col-start-2 col-end-4 h-[3px] rounded-sm bg-primary/70" style:width="{Math.max(2, Math.round(n / top * 100))}%"></span>
                    </li>
                {/each}
            </ol>
            <div>
                <ShButton variant="outline" size="sm" onclick={() => { showText = !showText; }}>{language.inputWordRankAsText}</ShButton>
            </div>
            {#if showText}
                <textarea
                    readonly
                    class="min-h-48 w-full rounded-md border border-darkborderc bg-darkbutton p-2 text-xs text-textcolor"
                    value={asText}
                    onfocus={(e) => e.currentTarget.select()}
                ></textarea>
            {/if}
        {/if}
    {/if}
</ShDialog>
