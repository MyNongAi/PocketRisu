<script lang="ts">
    // The bot edit mode's row in the sidebar (editMode.ts; the user's choices,
    // 2026-10-28). The switch shows whether the Risu Access module is on for
    // this chat, so the module menu moves it too, as 🎨 and its module; while
    // on: whether the AI's writes are asked for, what can be undone, the undo.
    import { untrack } from 'svelte'
    import { language } from 'src/lang'
    import type { Chat, character as Bot } from 'src/ts/storage/database.svelte'
    import { editModeOn, revertEdits, setEditApproval, startEditMode, startSitting, stopEditMode } from 'src/ts/process/mcp/editMode'
    import { editBackupCount } from 'src/ts/process/mcp/editSession'
    import { chatToolBlock, toolBlockText } from 'src/ts/process/mcp/toolGate'
    import ShSwitch from '../UI/GUI/ShSwitch.svelte'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import Help from '../Others/Help.svelte'

    interface Props {
        character: Bot
        chat: Chat
    }

    let { character, chat }: Props = $props()

    let on = $derived(editModeOn(character, chat))
    let session = $derived(chat.nodeOnlyEditSession)
    let approval = $derived(session?.approval ?? 'ask')
    let count = $derived(editBackupCount(session))
    let block = $derived(on ? chatToolBlock(chat, true) : null)
    let busy = $state(false)
    // The switch shows the mode again when a question was cancelled.
    let switchKey = $state(0)

    // Turned on from the module menu: a new sitting (nothing backed up yet).
    let seen: { chat: Chat, on: boolean } | null = null
    $effect(() => {
        const now = { chat, on }
        untrack(() => {
            if (seen && seen.chat === now.chat && !seen.on && now.on && !busy) startSitting(now.chat)
            seen = now
        })
    })

    async function toggle(checked: boolean) {
        busy = true
        try {
            if (checked) await startEditMode(character, chat)
            else await stopEditMode(character, chat)
        } finally {
            busy = false
            switchKey++
        }
    }
</script>

<div class="w-full flex mt-2 items-center justify-between gap-2 min-h-10 rounded-md px-1">
    <span class="flex items-center gap-1 min-w-0">
        <span class="break-words">{language.editModeToggle}</span>
        <Help key="editMode" />
    </span>
    {#key switchKey}
        <ShSwitch className="shrink-0" checked={on} disabled={busy} onCheckedChange={(checked) => { void toggle(checked) }} />
    {/key}
</div>
{#if on}
    <div class="flex w-full flex-col gap-2 rounded-md border border-darkborderc p-2 text-sm" data-edit-mode>
        {#if block}
            <span class="break-words text-yellow-500">{toolBlockText(block)}</span>
        {/if}
        <div class="flex flex-col gap-1">
            <span>{language.editModeApproval}</span>
            <div class="grid grid-cols-2 gap-2">
                <ShButton size="sm" variant={approval === 'auto' ? 'primary' : 'outline'} className="h-auto min-h-8 whitespace-normal px-2 py-1" onclick={() => setEditApproval(chat, 'auto')}>{language.editModeAuto}</ShButton>
                <ShButton size="sm" variant={approval === 'ask' ? 'primary' : 'outline'} className="h-auto min-h-8 whitespace-normal px-2 py-1" onclick={() => setEditApproval(chat, 'ask')}>{language.editModeAsk}</ShButton>
            </div>
        </div>
        {#if count.characters + count.modules > 0}
            <span>{language.editModeBackups.replace('{chars}', String(count.characters)).replace('{modules}', String(count.modules))}</span>
            <ShButton size="sm" variant="outline" className="self-start" onclick={() => { void revertEdits(chat) }}>{language.editModeRevert}</ShButton>
        {:else}
            <span class="text-xs text-textcolor2">{language.editModeNoBackups}</span>
        {/if}
        <span class="text-xs text-textcolor2">{language.mcpToolsNoStreaming}</span>
    </div>
{/if}
