// Every write of the Risu Access MCP asks first, as it always did, unless the
// chat's bot edit mode is set to 'auto' (editSession.ts). An approved write
// backs its bot or module up first, once per edit sitting: a write through
// this MCP is the edit mode, however the module was turned on.
import { language } from 'src/lang'
import { alertConfirm } from 'src/ts/alert'
import { getCurrentChat, type character } from 'src/ts/storage/database.svelte'
import { DBState } from 'src/ts/stores.svelte'
import { backupModule, type BackupMarks, type EditSession } from '../editSession'
import { backupCharacterCopy } from '../editBackup'

export type WriteTarget =
    | { kind: 'character', value: character }
    | { kind: 'module', value: { id: string } }

function backupCharacterOnce(session: EditSession, char: character & BackupMarks): void {
    if (char.nodeOnlyEditBackupOf) return
    session.characters ??= {}
    if (session.characters[char.chaId]) return
    session.characters[char.chaId] = backupCharacterCopy(char)
}

export async function mcpWriteAccess(tool: string, action: string, target?: WriteTarget): Promise<boolean> {
    const chat = getCurrentChat()
    const allowed = chat?.nodeOnlyEditSession?.approval === 'auto'
        || await alertConfirm(language.mcpAccessPrompt.replace('{{tool}}', tool).replace('{{action}}', action))
    if (allowed && chat && target) {
        chat.nodeOnlyEditSession ??= { approval: 'ask', startedAt: Date.now() }
        // Read back: the stored object is the reactive one.
        const session = chat.nodeOnlyEditSession
        if (target.kind === 'character') backupCharacterOnce(session, target.value)
        else backupModule(session, target.value, DBState.db.enabledModules)
    }
    return allowed
}
