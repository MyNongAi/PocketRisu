<script lang="ts">
    // The bot edit mode's row in the sidebar (editMode.ts; the user's choices,
    // 2026-10-28 and 2026-11-01). The dropdown picks who edits: nobody (the
    // default), this chat's model through the Risu Access module, which the
    // module menu moves too, as 🎨 and its module, or Codex, Claude Code or
    // Antigravity from their own app through the PocketRisu MCP server. Below
    // it: whether a write is asked for, what can be undone, the undo, and for
    // an app what to put into it.
    import { untrack } from 'svelte'
    import { CopyIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type { Chat, character as Bot } from 'src/ts/storage/database.svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import { isNodeServer } from 'src/ts/platform'
    import { openSettings, SettingsRoute } from 'src/ts/routing'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import {
        chooseEditMode, editModeChoice, externalEditAppLabel, revertEdits, setEditApproval, startSitting,
        EXTERNAL_EDIT_APPS, type EditModeChoice,
    } from 'src/ts/process/mcp/editMode'
    import { editBackupCount, restoreEdits, type EditApproval } from 'src/ts/process/mcp/editSession'
    import { chatToolBlock, toolBlockText } from 'src/ts/process/mcp/toolGate'
    import { enableExternalMcp, externalMcpStatus, type ExternalMcpStatus } from 'src/ts/process/mcp/externalBridge'
    import { mcpClientSetups } from 'src/ts/process/mcp/externalMcpSetup'
    import SelectInput from '../UI/GUI/SelectInput.svelte'
    import OptionInput from '../UI/GUI/OptionInput.svelte'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import Help from '../Others/Help.svelte'

    interface Props {
        character: Bot
        chat: Chat
    }

    let { character, chat }: Props = $props()

    const MASK = '••••••••'

    let choice = $derived(editModeChoice(character, chat))
    let on = $derived(choice === 'builtin')
    let app = $derived(choice === 'off' || choice === 'builtin' ? null : choice)
    let session = $derived(app ? DBState.db.nodeOnlyExternalEditSession : chat.nodeOnlyEditSession)
    let approval = $derived(session?.approval ?? 'ask')
    let count = $derived(editBackupCount(session))
    let block = $derived(on ? chatToolBlock(chat, true) : null)
    let busy = $state(false)
    // The dropdown shows the mode again when a question was cancelled.
    let selectKey = $state(0)
    let status = $state<ExternalMcpStatus | null>(null)
    let setup = $derived(app && status?.token
        ? mcpClientSetups(`${location.origin}/mcp`, status.token, status.stdioScript).find((s) => s.id === app)
        : undefined)
    const hints: Partial<Record<string, () => string>> = {
        codex: () => language.externalMcpCodexHint,
        antigravity: () => language.externalMcpAntigravityHint,
    }

    // Read when shown: the sidebar can mount before the app language is set.
    const choices = (): { value: EditModeChoice, label: string }[] => [
        { value: 'off', label: language.editModeChoiceOff },
        { value: 'builtin', label: language.editModeChoiceBuiltin },
        // The MCP server is the node server's.
        ...(isNodeServer || app ? EXTERNAL_EDIT_APPS.map((value) => ({ value, label: externalEditAppLabel(value) })) : []),
    ]

    // Turned on from the module menu: a new sitting (nothing backed up yet).
    let seen: { chat: Chat, on: boolean } | null = null
    $effect(() => {
        const now = { chat, on }
        untrack(() => {
            if (seen && seen.chat === now.chat && !seen.on && now.on && !busy) startSitting(now.chat)
            seen = now
        })
    })

    // An app's setting carries the server's token.
    $effect(() => {
        if (!app || status?.token) return
        void externalMcpStatus().then((next) => { status = next }).catch(() => {})
    })

    async function enable(): Promise<boolean> {
        try {
            status = await enableExternalMcp()
            return status.enabled
        } catch {
            return false
        }
    }

    async function pick(next: EditModeChoice) {
        busy = true
        try {
            await chooseEditMode(character, chat, next, enable)
        } finally {
            busy = false
            selectKey++
        }
    }

    function setApproval(next: EditApproval) {
        if (!app) {
            setEditApproval(chat, next)
            return
        }
        DBState.db.nodeOnlyExternalEditSession ??= { approval: 'ask', startedAt: Date.now() }
        DBState.db.nodeOnlyExternalEditSession.approval = next
    }

    async function revert() {
        if (!app) {
            await revertEdits(chat)
            return
        }
        const external = DBState.db.nodeOnlyExternalEditSession
        if (!external) return
        const text = language.editModeRevertConfirm.replace('{chars}', String(count.characters)).replace('{modules}', String(count.modules))
        if (!await alertConfirm(text)) return
        restoreEdits(external, DBState.db)
        notifySuccess(language.editModeReverted)
    }

    async function copy(text: string) {
        try {
            await navigator.clipboard.writeText(text)
            notifySuccess(language.externalMcpCopied)
        } catch (error) {
            notifyError(String(error))
        }
    }

</script>

<div class="w-full flex mt-2 flex-col gap-1 rounded-md px-1">
    <span class="flex items-center gap-1 min-w-0">
        <span class="break-words">{language.editModeToggle}</span>
        <Help key="editMode" />
    </span>
    {#key selectKey}
        <SelectInput className="w-full" value={choice} onchange={(e) => { void pick(e.currentTarget.value as EditModeChoice) }}>
            {#each choices() as option (option.value)}
                <OptionInput value={option.value}>{option.label}</OptionInput>
            {/each}
        </SelectInput>
    {/key}
</div>
{#if on || app}
    <div class="flex w-full flex-col gap-2 rounded-md border border-darkborderc p-2 text-sm" data-edit-mode={choice}>
        {#if block}
            <span class="break-words text-yellow-500">{toolBlockText(block)}</span>
        {/if}
        {#if app}
            <span class="break-words">{language.editModeExternalHow.replaceAll('{app}', externalEditAppLabel(app))}</span>
            {#if setup}
                <div class="flex min-w-0 flex-col gap-1" data-mcp-setup={setup.id}>
                    <div class="flex min-w-0 items-center gap-2">
                        <span class="min-w-0 grow truncate font-mono text-xs text-textcolor2">{setup.where}</span>
                        <ShButton size="icon-sm" variant="outline" aria-label={setup.name} onclick={() => copy(setup.text)}><CopyIcon size={14} /></ShButton>
                    </div>
                    <pre class="m-0 max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-darkborderc bg-darkbg p-2 text-xs">{status?.token ? setup.text.split(status.token).join(MASK) : setup.text}</pre>
                    {#if hints[setup.id]}
                        <span class="text-xs text-textcolor2 break-words">{hints[setup.id]?.()}</span>
                    {/if}
                </div>
            {/if}
        {/if}
        <div class="flex flex-col gap-1">
            <span>{language.editModeApproval}</span>
            <div class="grid grid-cols-2 gap-2">
                <ShButton size="sm" variant={approval === 'auto' ? 'primary' : 'outline'} className="h-auto min-h-8 whitespace-normal px-2 py-1" onclick={() => setApproval('auto')}>{language.editModeAuto}</ShButton>
                <ShButton size="sm" variant={approval === 'ask' ? 'primary' : 'outline'} className="h-auto min-h-8 whitespace-normal px-2 py-1" onclick={() => setApproval('ask')}>{language.editModeAsk}</ShButton>
            </div>
        </div>
        {#if count.characters + count.modules > 0}
            <span>{language.editModeBackups.replace('{chars}', String(count.characters)).replace('{modules}', String(count.modules))}</span>
            <ShButton size="sm" variant="outline" className="self-start" onclick={() => { void revert() }}>{language.editModeRevert}</ShButton>
        {:else}
            <span class="text-xs text-textcolor2">{app ? language.externalMcpBackupsEmpty : language.editModeNoBackups}</span>
        {/if}
        {#if app}
            <span class="text-xs text-textcolor2 break-words">{language.editModeExternalAnyApp}</span>
            <ShButton size="sm" variant="outline" className="self-start" onclick={() => openSettings(SettingsRoute.ExternalMcp)}>{language.editModeExternalSettings}</ShButton>
        {:else}
            <span class="text-xs text-textcolor2">{language.mcpToolsNoStreaming}</span>
        {/if}
    </div>
{/if}
