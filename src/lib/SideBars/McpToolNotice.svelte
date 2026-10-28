<script lang="ts">
    // An MCP module on in this chat while its main requests go without tools
    // (toolGate.ts): said in the sidebar, with the chat's own switch that
    // turns tools on for it without changing the model preset (the user's
    // report and choice, 2026-10-28). The Risu Access MCP is the bot edit
    // mode's (EditModeToggle.svelte), which turns tools on by itself: one row,
    // not two.
    import { language } from 'src/lang'
    import type { Chat, character as Bot } from 'src/ts/storage/database.svelte'
    import { captureModuleRuntimeContext, getModuleMcps } from 'src/ts/process/modules'
    import { RISU_ACCESS_URL, chatToolBlock, toolBlockText } from 'src/ts/process/mcp/toolGate'
    import ShSwitch from '../UI/GUI/ShSwitch.svelte'

    interface Props {
        character: Bot
        chat: Chat
    }

    let { character, chat }: Props = $props()

    let mcps = $derived(getModuleMcps(captureModuleRuntimeContext(character, chat)))
    let others = $derived(mcps.filter((url) => url !== RISU_ACCESS_URL).length > 0)
    let block = $derived(chatToolBlock(chat, mcps.includes(RISU_ACCESS_URL)))
</script>

{#if others && (block || chat.nodeOnlyToolUse)}
    <div
        class="mt-2 flex w-full flex-col gap-2 rounded-md border p-2 text-sm {block ? 'border-yellow-600/50 bg-yellow-500/10' : 'border-darkborderc'}"
        data-mcp-tool-notice
    >
        {#if block}
            <span class="break-words text-yellow-500">{toolBlockText(block)}</span>
        {/if}
        {#if block !== 'unsupported'}
            <div class="flex min-h-10 items-center justify-between gap-2">
                <span class="min-w-0 break-words">{language.mcpToolsChatSwitch}</span>
                <ShSwitch
                    className="shrink-0"
                    checked={!!chat.nodeOnlyToolUse}
                    onCheckedChange={(checked) => {
                        if (checked) chat.nodeOnlyToolUse = true
                        else delete chat.nodeOnlyToolUse
                    }}
                />
            </div>
            {#if chat.nodeOnlyToolUse}
                <span class="text-xs text-textcolor2">{language.mcpToolsNoStreaming}</span>
            {/if}
        {/if}
    </div>
{/if}
