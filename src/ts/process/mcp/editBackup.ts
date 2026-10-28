// A bot's backup before the AI's first change to it in an edit sitting
// (editSession.ts): a copy of the bot, without its chats, named with a backup
// mark and the time, put in the original's folder so the original and its
// backups are read side by side (the user's request, 2026-10-28). Each bot
// keeps its 3 newest backups; older ones go to the trash.
import { v4 } from 'uuid'
import { language } from 'src/lang'
import { findPlacement, moveCharacterToFolder, type OrderEntry } from 'src/ts/characterOrder'
import { removeChar } from 'src/ts/characters'
import { checkCharOrder } from 'src/ts/globalApi.svelte'
import { newChatModelDefaults, type character } from 'src/ts/storage/database.svelte'
import { DBState } from 'src/ts/stores.svelte'
import type { BackupMarks } from './editSession'

export const KEPT_BACKUPS = 3

function stamp(at: number): string {
    const date = new Date(at)
    const two = (n: number) => String(n).padStart(2, '0')
    return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

/** The original's place: its folder, or right after it at the top. */
export function placeBackup(order: readonly OrderEntry[], originalId: string, backupId: string): OrderEntry[] {
    const placement = findPlacement([...order], originalId)
    if (placement?.folderId) return moveCharacterToFolder([...order], backupId, placement.folderId)
    const next = [...order]
    const at = next.indexOf(originalId)
    next.splice(at < 0 ? next.length : at + 1, 0, backupId)
    return next
}

/** The backups of a bot, newest first. */
export function backupsOf(characters: readonly ((BackupMarks & { chaId: string }) | null | undefined)[], originalId: string) {
    return characters
        .filter((c): c is BackupMarks & { chaId: string } => !!c && c.nodeOnlyEditBackupOf === originalId)
        .sort((a, b) => (b.nodeOnlyEditBackupAt ?? 0) - (a.nodeOnlyEditBackupAt ?? 0))
}

/** Make the backup bot and return its id. */
export function backupCharacterCopy(original: character, at = Date.now()): string {
    const { chats: _chats, ...rest } = original
    const backup = JSON.parse(JSON.stringify(rest)) as character & BackupMarks
    backup.chaId = v4()
    backup.name = language.editModeBackupName.replace('{name}', original.name || 'Unnamed').replace('{time}', stamp(at))
    backup.chats = [{ message: [], note: '', name: 'Chat 1', localLore: [], fmIndex: -1, id: v4(), ...newChatModelDefaults() } as character['chats'][number]]
    backup.chatPage = 0
    backup.nodeOnlyEditBackupOf = original.chaId
    backup.nodeOnlyEditBackupAt = at
    backup.nodeOnlyEditBackupName = original.name
    DBState.db.characters.push(backup)
    DBState.db.characterOrder = placeBackup(DBState.db.characterOrder ?? [], original.chaId, backup.chaId)
    checkCharOrder()
    void pruneBackups(original.chaId)
    return backup.chaId
}

/** Older backups of a bot, beyond the newest few, to the trash (not deleted). */
async function pruneBackups(originalId: string): Promise<void> {
    for (const old of backupsOf(DBState.db.characters as (character & BackupMarks)[], originalId).slice(KEPT_BACKUPS)) {
        await removeChar(old.chaId, (old as character).name, 'normal', { skipConfirm: true })
    }
}
