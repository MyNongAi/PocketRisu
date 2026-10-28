// The bot edit mode's record on its chat (editMode.ts; the user's choices,
// 2026-10-28). While the mode is on, each bot the AI changes through the Risu
// Access MCP is copied right before its first change into a backup bot in the
// same folder (editBackup.ts), so the AI and the user can read the two side
// by side; a module is copied into this record. 'auto' lets the AI write
// without asking, like a coding agent's auto mode; 'ask' asks for every
// write, as the MCP always did.

export type EditApproval = 'auto' | 'ask'

/** What the MCP's character tools can change (risuaccess/characters.ts). */
export const CHARACTER_EDIT_FIELDS = [
    'name', 'firstMessage', 'desc', 'replaceGlobalNote', 'alternateGreetings', 'backgroundHTML',
    'globalLore', 'customscript', 'triggerscript', 'additionalAssets', 'additionalAssetManifest',
] as const

/** What the MCP's module tools can change (risuaccess/modules.ts); on or off goes in `enabled`. */
export const MODULE_EDIT_FIELDS = [
    'name', 'description', 'lowLevelAccess', 'backgroundEmbedding', 'customModuleToggle',
    'lorebook', 'regex', 'trigger',
] as const

/** The fields a target held (one it lacked is absent here and taken off again on undo). */
export type EditBackup = Record<string, unknown>

export interface EditSession {
    approval: EditApproval
    startedAt: number
    /** Bots copied before their first change in this sitting: the bot's id → its backup bot's id. */
    characters?: Record<string, string>
    modules?: Record<string, EditBackup & { enabled?: boolean }>
}

/** A backup bot's own marks: whose copy it is, when, and the name to put back. */
export interface BackupMarks {
    nodeOnlyEditBackupOf?: string
    nodeOnlyEditBackupAt?: number
    nodeOnlyEditBackupName?: string
}

type Target = Record<string, unknown>

function copy<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function snapshot(target: Target, fields: readonly string[]): EditBackup {
    const backup: EditBackup = {}
    for (const field of fields) {
        if (target[field] !== undefined) backup[field] = copy(target[field])
    }
    return backup
}

function putBack(target: Target, backup: EditBackup, fields: readonly string[]): void {
    for (const field of fields) {
        if (field in backup) target[field] = copy(backup[field])
        else delete target[field]
    }
}

/** Copy a module before its first change in this sitting, with whether it was on everywhere. */
export function backupModule(session: EditSession, module: { id: string }, enabledModules: readonly string[] | undefined): void {
    session.modules ??= {}
    if (session.modules[module.id]) return
    session.modules[module.id] = {
        ...snapshot(module as unknown as Target, MODULE_EDIT_FIELDS),
        enabled: (enabledModules ?? []).includes(module.id),
    }
}

/** Put a bot back as its backup bot holds it (the name the backup kept aside). */
export function restoreCharacterFrom(original: object, backup: object & BackupMarks): void {
    const fields = snapshot(backup as unknown as Target, CHARACTER_EDIT_FIELDS)
    if (backup.nodeOnlyEditBackupName !== undefined) fields.name = backup.nodeOnlyEditBackupName
    putBack(original as unknown as Target, fields, CHARACTER_EDIT_FIELDS)
}

export function editBackupCount(session: EditSession | null | undefined): { characters: number, modules: number } {
    return {
        characters: Object.keys(session?.characters ?? {}).length,
        modules: Object.keys(session?.modules ?? {}).length,
    }
}

/**
 * Put every bot and module the AI changed in this sitting back as it was, and
 * start the sitting afresh (the backup bots stay). Anything gone since is
 * skipped. Returns how many were put back.
 */
export function restoreEdits(
    session: EditSession,
    db: { characters: readonly ((object & { chaId: string } & BackupMarks) | null | undefined)[], modules: readonly ({ id: string } | null | undefined)[], enabledModules?: string[] },
): { characters: number, modules: number } {
    let characters = 0
    let modules = 0
    for (const [chaId, backupId] of Object.entries(session.characters ?? {})) {
        const original = db.characters.find((c) => c?.chaId === chaId)
        const backup = db.characters.find((c) => c?.chaId === backupId)
        if (!original || !backup) continue
        restoreCharacterFrom(original, backup)
        characters++
    }
    for (const [id, backup] of Object.entries(session.modules ?? {})) {
        const module = db.modules.find((m) => m?.id === id)
        if (!module) continue
        const { enabled, ...fields } = backup
        putBack(module as unknown as Target, fields, MODULE_EDIT_FIELDS)
        const on = (db.enabledModules ?? []).includes(id)
        if (enabled !== undefined && on !== enabled) {
            db.enabledModules = enabled ? [...(db.enabledModules ?? []), id] : (db.enabledModules ?? []).filter((m) => m !== id)
        }
        modules++
    }
    session.characters = {}
    session.modules = {}
    return { characters, modules }
}
