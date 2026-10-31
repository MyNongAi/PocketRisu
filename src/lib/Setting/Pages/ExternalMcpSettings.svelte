<script lang="ts">
    // The PocketRisu MCP server (externalBridge.ts, server/node/mcp-bridge.cjs;
    // the user's request, 2026-10-31): on or off, the address and token, which
    // page takes the calls, whether a write asks, what the apps changed and
    // the undo, and how each app is pointed here.
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShInput from "src/lib/UI/GUI/ShInput.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import { CopyIcon, LoaderCircleIcon, TriangleAlertIcon } from "@lucide/svelte";
    import { alertConfirm, notifyError, notifySuccess } from "src/ts/alert";
    import { DBState } from "src/ts/stores.svelte";
    import { editBackupCount, restoreEdits, type EditApproval } from "src/ts/process/mcp/editSession";
    import { mcpBridgePageId, mcpServerFetch, wakeExternalMcpBridge } from "src/ts/process/mcp/externalBridge";
    import { mcpClientSetups } from "src/ts/process/mcp/externalMcpSetup";

    type Status = {
        enabled: boolean
        token: string | null
        pages: number
        receiving: boolean
        receiverConnected: boolean
        stdioScript?: string
    }

    let status = $state<Status | null>(null);
    let failed = $state(false);
    let busy = $state(false);
    let showToken = $state(false);

    const address = `${location.origin}/mcp`;
    const MASK = "••••••••";

    let session = $derived(DBState.db.nodeOnlyExternalEditSession);
    let approval = $derived(session?.approval ?? 'ask');
    let count = $derived(editBackupCount(session));
    let setups = $derived(status?.token ? mcpClientSetups(address, status.token, status.stdioScript) : []);
    const hints: Partial<Record<string, () => string>> = {
        codex: () => language.externalMcpCodexHint,
        antigravity: () => language.externalMcpAntigravityHint,
        'claude-desktop': () => language.externalMcpDesktopHint,
    };

    async function load() {
        try {
            const res = await mcpServerFetch(`/api/mcp/status?page=${encodeURIComponent(mcpBridgePageId)}`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            status = await res.json();
            failed = false;
        } catch {
            failed = true;
        }
    }

    async function act(action: 'enable' | 'rotate' | 'disable') {
        if (action === 'rotate' && !await alertConfirm(language.externalMcpRotateConfirm)) return;
        if (action === 'disable' && !await alertConfirm(language.externalMcpOffConfirm)) return;
        busy = true;
        try {
            const res = await mcpServerFetch(`/api/mcp/${action}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ page: mcpBridgePageId }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            status = await res.json();
            wakeExternalMcpBridge();
            // This page connects a moment later.
            setTimeout(() => { void load() }, 1000);
        } catch (error) {
            notifyError(String(error));
        } finally {
            busy = false;
        }
    }

    function setApproval(next: EditApproval) {
        DBState.db.nodeOnlyExternalEditSession ??= { approval: 'ask', startedAt: Date.now() };
        DBState.db.nodeOnlyExternalEditSession.approval = next;
    }

    async function revert() {
        if (!session) return;
        const text = language.editModeRevertConfirm.replace('{chars}', String(count.characters)).replace('{modules}', String(count.modules));
        if (!await alertConfirm(text)) return;
        restoreEdits(session, DBState.db);
        notifySuccess(language.editModeReverted);
    }

    /** What the apps changed so far stays; the next change starts a new record. */
    function keep() {
        DBState.db.nodeOnlyExternalEditSession = { approval, startedAt: Date.now() };
    }

    function shown(text: string): string {
        return showToken || !status?.token ? text : text.split(status.token).join(MASK);
    }

    async function copy(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            notifySuccess(language.externalMcpCopied);
        } catch (error) {
            notifyError(String(error));
        }
    }

    $effect(() => {
        void load();
        // Which page takes the calls changes as pages are used.
        const timer = setInterval(() => { void load() }, 5000);
        return () => clearInterval(timer);
    });
</script>

<SettingPage title={language.externalMcp}>
<div class="flex min-w-0 flex-col gap-4">
    <p class="text-sm text-textcolor2 break-words">{language.externalMcpDesc}</p>

    {#if status === null && !failed}
        <div class="flex items-center justify-center py-8 text-textcolor2">
            <LoaderCircleIcon class="animate-spin" size={28} />
        </div>
    {:else if status === null}
        <div class="text-sm text-red-400">{language.remoteAccessError}</div>
    {:else if !status.enabled}
        <ShButton className="self-start" disabled={busy} onclick={() => act('enable')}>{language.externalMcpOn}</ShButton>
    {:else}
        <div class="flex min-w-0 flex-col gap-1">
            <span class="text-sm font-semibold">{language.externalMcpAddress}</span>
            <div class="flex min-w-0 items-center gap-2">
                <ShInput type="text" readonly value={address} className="min-w-0 flex-1 select-all" />
                <ShButton size="icon" variant="outline" aria-label={language.externalMcpAddress} onclick={() => copy(address)}><CopyIcon size={16} /></ShButton>
            </div>
        </div>

        <div class="flex min-w-0 flex-col gap-1">
            <span class="text-sm font-semibold">{language.externalMcpToken}</span>
            <div class="flex min-w-0 items-center gap-2">
                <ShInput type="text" readonly value={showToken ? (status.token ?? '') : MASK} className="min-w-0 flex-1 select-all font-mono" />
                <ShButton size="icon" variant="outline" aria-label={language.externalMcpToken} onclick={() => copy(status?.token ?? '')}><CopyIcon size={16} /></ShButton>
            </div>
            <div class="flex flex-wrap gap-2">
                <ShButton size="sm" variant="outline" onclick={() => { showToken = !showToken }}>{showToken ? language.externalMcpHideToken : language.externalMcpShowToken}</ShButton>
                <ShButton size="sm" variant="outline" disabled={busy} onclick={() => act('rotate')}>{language.externalMcpRotate}</ShButton>
                <ShButton size="sm" variant="destructive" disabled={busy} onclick={() => act('disable')}>{language.externalMcpOff}</ShButton>
            </div>
            <ShAlert variant="warning">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {language.externalMcpTokenWarning}
            </ShAlert>
        </div>

        <span class="text-sm" class:text-textcolor2={!status.receiving}>
            {status.receiving ? language.externalMcpReceivingHere : status.receiverConnected ? language.externalMcpReceivingOther : language.externalMcpNoPage}
        </span>

        <div class="flex flex-col gap-2 rounded-md border border-darkborderc p-2 text-sm">
            <span>{language.editModeApproval}</span>
            <div class="grid grid-cols-2 gap-2">
                <ShButton size="sm" variant={approval === 'auto' ? 'primary' : 'outline'} className="h-auto min-h-8 whitespace-normal px-2 py-1" onclick={() => setApproval('auto')}>{language.editModeAuto}</ShButton>
                <ShButton size="sm" variant={approval === 'ask' ? 'primary' : 'outline'} className="h-auto min-h-8 whitespace-normal px-2 py-1" onclick={() => setApproval('ask')}>{language.editModeAsk}</ShButton>
            </div>
            {#if count.characters + count.modules > 0}
                <span>{language.editModeBackups.replace('{chars}', String(count.characters)).replace('{modules}', String(count.modules))}</span>
                <div class="flex flex-wrap gap-2">
                    <ShButton size="sm" variant="outline" onclick={() => { void revert() }}>{language.editModeRevert}</ShButton>
                    <ShButton size="sm" variant="outline" onclick={keep}>{language.externalMcpNewSitting}</ShButton>
                </div>
            {:else}
                <span class="text-xs text-textcolor2 break-words">{language.externalMcpBackupsEmpty}</span>
            {/if}
        </div>

        <div class="flex min-w-0 flex-col gap-3">
            <span class="text-sm font-semibold">{language.externalMcpSetup}</span>
            <span class="text-xs text-textcolor2 break-words">{language.externalMcpSetupHint}</span>
            {#each setups as setup (setup.id)}
                <div class="flex min-w-0 flex-col gap-1" data-mcp-setup={setup.id}>
                    <div class="flex min-w-0 items-center gap-2">
                        <span class="text-sm font-semibold">{setup.name}</span>
                        <span class="min-w-0 grow truncate font-mono text-xs text-textcolor2">{setup.where}</span>
                        <ShButton size="icon-sm" variant="outline" aria-label={setup.name} onclick={() => copy(setup.text)}><CopyIcon size={14} /></ShButton>
                    </div>
                    <pre class="m-0 max-w-full select-all overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-darkborderc bg-darkbg p-2 text-xs">{shown(setup.text)}</pre>
                    {#if hints[setup.id]}
                        <span class="text-xs text-textcolor2 break-words">{hints[setup.id]?.()}</span>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</div>
</SettingPage>
