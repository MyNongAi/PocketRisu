// The bot edit mode (the user's choices, 2026-10-28): the chat's model edits
// bots, modules and prompt presets through the built-in Risu Access MCP. The mode is that
// module being on for the chat, like 🎨 and its module: the sidebar's switch
// turns the module on or off for the chat, and turning the module on or off
// in the module menu moves the switch (it reads the module). With it on, the
// chat's main requests carry tools whatever the preset (toolGate.ts). On, the
// switch asks where (a new edit chat or this one), and makes the module when
// there is none; off, it asks whether to keep what the AI changed or put it
// back (editSession.ts). The chat's model is the main model, or the sub
// model when the user picked it (toolGate.ts mainRouteMode, 2026-11-08).
//
// The sidebar shows it as a dropdown (the user's choice, 2026-11-01): off by
// default, built-in (the above), or Codex, Claude Code or Antigravity editing
// from their own app through the PocketRisu MCP server (externalBridge.ts).
// One at a time: built-in here ends the apps' turn, an app ends this chat's
// built-in mode. The app is the database's, like the apps' own edit sitting,
// since an app can edit any bot.
import { get } from 'svelte/store'
import { v4 } from 'uuid'
import { language } from 'src/lang'
import { alertConfirm, alertSelect, notifyError, notifyInfo, notifySuccess } from 'src/ts/alert'
import { changeChatTo, requestImmediateSave } from 'src/ts/globalApi.svelte'
import { newChatModelDefaults, type Chat, type character } from 'src/ts/storage/database.svelte'
import { DBState, ReloadGUIPointer, selIdState } from 'src/ts/stores.svelte'
import { addModuleToDatabase, captureModuleRuntimeContext, getModuleMcps } from '../modules'
import { getMCPMeta, mcpModuleOf } from './mcp'
import { editBackupCount, restoreEdits, type EditApproval } from './editSession'
import { RISU_ACCESS_URL } from './toolGate'

/** The mode is on: the Risu Access module is on for this chat (here, the bot's, everywhere, ...). */
export function editModeOn(char: character, chat: Chat): boolean {
    return getModuleMcps(captureModuleRuntimeContext(char, chat)).includes(RISU_ACCESS_URL)
}

export type ExternalEditApp = 'codex' | 'claude-code' | 'antigravity'
export type EditModeChoice = 'off' | 'builtin' | ExternalEditApp
export const EXTERNAL_EDIT_APPS: readonly ExternalEditApp[] = ['codex', 'claude-code', 'antigravity']

export function externalEditAppLabel(app: ExternalEditApp): string {
    if (app === 'codex') return language.editModeChoiceCodex
    if (app === 'claude-code') return language.editModeChoiceClaudeCode
    return language.editModeChoiceAntigravity
}

/** What the dropdown shows for this chat. */
export function editModeChoice(char: character, chat: Chat): EditModeChoice {
    if (editModeOn(char, chat)) return 'builtin'
    return DBState.db.nodeOnlyExternalEditApp ?? 'off'
}

/** Why a call from an app outside may not run now: no app is chosen. */
export function externalEditRefusal(): string | null {
    return DBState.db.nodeOnlyExternalEditApp ? null : language.externalMcpEditModeOff
}

/**
 * The dropdown picked `next`. `enable` turns the MCP server on (its token
 * kept), for an app. False when a question was cancelled or the server could
 * not be turned on: nothing changes then.
 */
export async function chooseEditMode(char: character, chat: Chat, next: EditModeChoice, enable: () => Promise<boolean>): Promise<boolean> {
    if (next === editModeChoice(char, chat)) return true
    if (next === 'builtin') {
        if (!await startEditMode(char, chat)) return false
        delete DBState.db.nodeOnlyExternalEditApp
        return true
    }
    // The server first: on alone, it still refuses every call (externalEditRefusal).
    if (next !== 'off' && !await enable()) {
        notifyError(language.editModeExternalFailed)
        return false
    }
    if (editModeOn(char, chat) && !await stopEditMode(char, chat)) return false
    if (next === 'off') delete DBState.db.nodeOnlyExternalEditApp
    else DBState.db.nodeOnlyExternalEditApp = next
    changed()
    return true
}

function risuAccessIds(): Set<string> {
    return new Set(DBState.db.modules.filter((module) => module?.mcp?.url === RISU_ACCESS_URL).map((module) => module.id))
}

/** The Risu Access module, made like the MCP import makes it when there is none (said in one line). */
async function risuAccessModule(): Promise<string | null> {
    const found = DBState.db.modules.find((module) => module?.mcp?.url === RISU_ACCESS_URL)
    if (found) return found.id
    const meta = (await getMCPMeta([RISU_ACCESS_URL]))[RISU_ACCESS_URL]
    if (!meta) return null
    const module = mcpModuleOf(RISU_ACCESS_URL, meta)
    addModuleToDatabase(module)
    notifyInfo(language.editModeModuleAdded)
    return module.id
}

/** A new chat at the top of the bot's list, opened like the sidebar's "new chat". */
function openEditChat(char: character): Chat {
    const chat = {
        message: [], note: '', name: language.editModeChatName, localLore: [], fmIndex: -1, id: v4(),
        ...newChatModelDefaults(),
    } as Chat
    char.chats = [chat, ...char.chats]
    if (DBState.db.characters[selIdState.selId] === char) changeChatTo(0)
    else char.chatPage = 0
    return char.chats[0]
}

function changed() {
    ReloadGUIPointer.set(get(ReloadGUIPointer) + 1)
    void requestImmediateSave()
}

/** A new edit sitting: nothing backed up yet, the approval kept. */
export function startSitting(chat: Chat): void {
    chat.nodeOnlyEditSession = { approval: chat.nodeOnlyEditSession?.approval ?? 'ask', startedAt: Date.now() }
}

/** Turn the mode on: where, then the module on for that chat. */
export async function startEditMode(char: character, chat: Chat): Promise<boolean> {
    const where = await alertSelect(
        [language.editModeNewChat, language.editModeThisChat, language.cancel],
        language.editModeWhere,
    )
    if (where !== '0' && where !== '1') return false
    const moduleId = await risuAccessModule()
    if (!moduleId) {
        notifyError(language.editModeModuleFailed)
        return false
    }
    const approval = chat.nodeOnlyEditSession?.approval
    const target = where === '0' ? openEditChat(char) : chat
    if (!editModeOn(char, target)) target.modules = [...(target.modules ?? []), moduleId]
    startSitting(target)
    if (approval) setEditApproval(target, approval)
    changed()
    return true
}

export function setEditApproval(chat: Chat, approval: EditApproval): void {
    if (!chat.nodeOnlyEditSession) startSitting(chat)
    chat.nodeOnlyEditSession!.approval = approval
}

function countText(text: string, count: { characters: number, modules: number, presets: number }): string {
    return text.replace('{chars}', String(count.characters)).replace('{modules}', String(count.modules)).replace('{presets}', String(count.presets))
}

/** Put back what the AI changed in this sitting; the mode stays on. */
export async function revertEdits(chat: Chat): Promise<void> {
    const session = chat.nodeOnlyEditSession
    const count = editBackupCount(session)
    if (!session || count.characters + count.modules + count.presets === 0) return
    if (!await alertConfirm(countText(language.editModeRevertConfirm, count))) return
    restoreEdits(session, DBState.db)
    notifySuccess(language.editModeReverted)
}

/** Turn the mode off: keep or put back what the AI changed, then the module off for this chat. */
export async function stopEditMode(char: character, chat: Chat): Promise<boolean> {
    const session = chat.nodeOnlyEditSession
    const count = editBackupCount(session)
    if (session && count.characters + count.modules + count.presets > 0) {
        const choice = await alertSelect(
            [language.editModeKeep, language.editModeStopRevert, language.cancel],
            countText(language.editModeStopAsk, count),
        )
        if (choice !== '0' && choice !== '1') return false
        if (choice === '1') {
            restoreEdits(session, DBState.db)
            notifySuccess(language.editModeReverted)
        }
    }
    const ids = risuAccessIds()
    if (chat.modules?.some((id) => ids.has(id))) chat.modules = chat.modules.filter((id) => !ids.has(id))
    if (chat.nodeOnlyEditSession) startSitting(chat)
    changed()
    // On for the bot, everywhere or by the prompt preset: the module menu turns that off.
    if (editModeOn(char, chat)) notifyInfo(language.editModeStillOn)
    return true
}
