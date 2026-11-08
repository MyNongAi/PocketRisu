<script lang="ts">
    // The bot edit mode's row in the sidebar (editMode.ts; the user's choices,
    // 2026-10-28, 2026-11-01 and 2026-11-05). The row opens like a dropdown:
    // inside, an on switch (off by default) and who edits: this chat's model
    // through the Risu Access module, which the module menu moves too, as 🎨
    // and its module, or Codex, Claude Code or Antigravity from their own app
    // through the PocketRisu MCP server. Picked while off, the choice waits for
    // the switch. Below them: whether a write is asked for, what can be
    // undone, the undo, and for an app what to put into it.
    import { untrack } from 'svelte'
    import { ChevronDownIcon, CopyIcon } from '@lucide/svelte'
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
    import { chatToolBlock, mainRouteMode, toolBlockText } from 'src/ts/process/mcp/toolGate'
    import { classicModelIdFor, resolveChatModelBinding } from 'src/ts/process/request/modelPresetBinding'
    import { getGenerationModelString } from 'src/ts/process/models/modelString'
    import { enableExternalMcp, externalMcpStatus, type ExternalMcpStatus } from 'src/ts/process/mcp/externalBridge'
    import { mcpClientSetups } from 'src/ts/process/mcp/externalMcpSetup'
    import SelectInput from '../UI/GUI/SelectInput.svelte'
    import OptionInput from '../UI/GUI/OptionInput.svelte'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import ShSwitch from '../UI/GUI/ShSwitch.svelte'
    import Help from '../Others/Help.svelte'

    type Engine = Exclude<EditModeChoice, 'off'>
    // The choice made while the switch is off, kept on this device.
    const ENGINE_KEY = 'risu-edit-mode-engine'

    function loadEngine(): Engine {
        try {
            const saved = localStorage.getItem(ENGINE_KEY)
            if (saved === 'builtin' || (EXTERNAL_EDIT_APPS as readonly string[]).includes(saved ?? '')) return saved as Engine
        } catch { /* storage off */ }
        return 'builtin'
    }

    function saveEngine(next: Engine) {
        try { localStorage.setItem(ENGINE_KEY, next) } catch { /* storage off */ }
    }

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
    // The model the built-in mode's requests go to (toolGate.ts; the user's request, 2026-11-08).
    let editModel = $derived<'main' | 'sub'>(DBState.db.nodeOnlyEditModeModel === 'sub' ? 'sub' : 'main')
    let routeLabel = $derived.by(() => {
        if (!on) return null
        const mode = mainRouteMode(true)
        const binding = resolveChatModelBinding(chat, mode)
        if (binding.kind === 'block') return null
        if (binding.kind === 'modelPreset') return binding.preset.name
        return getGenerationModelString(classicModelIdFor(binding, mode))
    })
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

    let open = $state(false)
    let engine = $state<Engine>(loadEngine())
    let shownEngine = $derived<Engine>(choice === 'off' ? engine : choice)

    function engineLabel(value: Engine): string {
        return value === 'builtin' ? language.editModeChoiceBuiltin : externalEditAppLabel(value)
    }

    // Read when shown: the sidebar can mount before the app language is set.
    const engines = (): { value: Engine, label: string }[] => [
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

    function setEditModel(next: 'main' | 'sub') {
        if (next === 'sub') DBState.db.nodeOnlyEditModeModel = 'sub'
        else delete DBState.db.nodeOnlyEditModeModel
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

    /** The switch: on runs the chosen way, off stops whichever is on and keeps it chosen. */
    function toggle(checked: boolean) {
        if (!checked && choice !== 'off') {
            engine = choice
            saveEngine(choice)
        }
        void pick(checked ? engine : 'off')
    }

    /** Who edits: on, it switches right away; off, it waits for the switch. */
    function pickEngine(next: Engine) {
        engine = next
        saveEngine(next)
        if (choice !== 'off') void pick(next)
    }
</script>

<div class="w-full flex mt-2 flex-col gap-1 rounded-md px-1">
    <div class="flex items-center gap-1 min-w-0 min-h-10">
        <button type="button" class="flex min-w-0 grow items-center gap-1 text-left" aria-expanded={open} data-edit-mode-open onclick={() => { open = !open }}>
            <ChevronDownIcon size={16} class={'shrink-0 transition-transform ' + (open ? '' : '-rotate-90')} />
            <span class="shrink-0 whitespace-nowrap">{language.editModeToggle}</span>
            <span class="ml-1 min-w-0 truncate text-xs" class:text-textcolor2={choice === 'off'} class:text-primary={choice !== 'off'}>
                {choice === 'off' ? language.editModeChoiceOff : choice === 'builtin' ? language.editModeBuiltinShort + (editModel === 'sub' ? ' · ' + language.editModeModelSubShort : '') : engineLabel(choice)}
            </span>
        </button>
        <Help key="editMode" />
    </div>
    {#if open}
        <div class="flex items-center justify-between gap-2 pl-5">
            <span>{language.editModeEnabled}</span>
            {#key selectKey}
                <ShSwitch className="shrink-0" checked={choice !== 'off'} disabled={busy} onCheckedChange={toggle} />
            {/key}
        </div>
        <div class="flex flex-col gap-1 pl-5 text-sm">
            <span class="text-textcolor2">{language.editModeEngine}</span>
            {#key selectKey}
                <SelectInput className="w-full" value={shownEngine} onchange={(e) => pickEngine(e.currentTarget.value as Engine)}>
                    {#each engines() as option (option.value)}
                        <OptionInput value={option.value}>{option.label}</OptionInput>
                    {/each}
                </SelectInput>
            {/key}
        </div>
    {/if}
</div>
{#if open && (on || app)}
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
        {#if !app}
            <div class="flex flex-col gap-1" data-edit-model={editModel}>
                <span>{language.editModeModel}</span>
                <div class="grid grid-cols-2 gap-2">
                    <ShButton size="sm" variant={editModel === 'main' ? 'primary' : 'outline'} className="h-auto min-h-8 whitespace-normal px-2 py-1" onclick={() => setEditModel('main')}>{language.editModeModelMain}</ShButton>
                    <ShButton size="sm" variant={editModel === 'sub' ? 'primary' : 'outline'} className="h-auto min-h-8 whitespace-normal px-2 py-1" onclick={() => setEditModel('sub')}>{language.editModeModelSub}</ShButton>
                </div>
                <span class="text-xs text-textcolor2 break-words" data-edit-model-route>{routeLabel ? language.editModeModelTo.replace('{model}', routeLabel) : language.editModeModelUnset}</span>
            </div>
        {/if}
        <div class="flex flex-col gap-1">
            <span>{language.editModeApproval}</span>
            <div class="grid grid-cols-2 gap-2">
                <ShButton size="sm" variant={approval === 'auto' ? 'primary' : 'outline'} className="h-auto min-h-8 whitespace-normal px-2 py-1" onclick={() => setApproval('auto')}>{language.editModeAuto}</ShButton>
                <ShButton size="sm" variant={approval === 'ask' ? 'primary' : 'outline'} className="h-auto min-h-8 whitespace-normal px-2 py-1" onclick={() => setApproval('ask')}>{language.editModeAsk}</ShButton>
            </div>
        </div>
        <!-- Whether a bot is copied into a backup bot before its first change
             (the user's request, 2026-11-08); one setting for here and the apps. -->
        <div class="flex items-center justify-between gap-2">
            <span>{language.editModeBotBackup}</span>
            <ShSwitch className="shrink-0" checked={DBState.db.nodeOnlyEditBotBackup !== false} onCheckedChange={(checked) => { DBState.db.nodeOnlyEditBotBackup = checked }} />
        </div>
        {#if DBState.db.nodeOnlyEditBotBackup === false}
            <span class="text-xs text-textcolor2 break-words" data-edit-backup-off>{language.editModeBotBackupOffNote}</span>
        {/if}
        {#if count.characters + count.modules > 0}
            <span>{language.editModeBackups.replace('{chars}', String(count.characters)).replace('{modules}', String(count.modules))}</span>
            <ShButton size="sm" variant="outline" className="self-start" onclick={() => { void revert() }}>{language.editModeRevert}</ShButton>
        {:else if DBState.db.nodeOnlyEditBotBackup !== false}
            <!-- Off, the note above says what is kept instead. -->
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
