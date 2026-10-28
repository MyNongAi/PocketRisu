// Read-only tools over the bot list's folders (the user's request,
// 2026-10-28: "MCP 하나로 폴더 안의 모든 봇을 보는 기능"): the folders, the
// bots in one with a short description, and their lorebook entry names at
// once. The bot edit mode's backups (editBackup.ts) sit in their original's
// folder; each is marked with the bot it copies, and each bot lists its
// backups, so the two can be read side by side. Nothing here reads prompt
// texts (presets, templates, memory prompts).
import { getArchivedStubs } from 'src/ts/characterArchive'
import { isFolderEntry, type OrderEntry } from 'src/ts/characterOrder'
import { folderParents } from 'src/ts/folderNesting'
import type { character, folder } from 'src/ts/storage/database.svelte'
import { DBState } from 'src/ts/stores.svelte'
import { pickHashRand } from 'src/ts/util'
import { MCPToolHandler, type MCPTool, type RPCToolCallContent } from '../mcplib'
import type { BackupMarks } from '../editSession'

const DESCRIPTION_CHARS = 300
const MAX_LOREBOOKS_PER_BOT = 100

type Bot = Pick<character, 'chaId' | 'name' | 'desc' | 'globalLore'> & BackupMarks

function text(value: unknown): RPCToolCallContent[] {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function clip(value: string | undefined, max: number): string {
    const plain = (value ?? '').trim()
    return plain.length <= max ? plain : `${plain.slice(0, max)}…`
}

/** A folder by its id, or else by its name (the first with it). */
export function findFolderByRef(order: readonly OrderEntry[], ref: string): folder | undefined {
    const folders = order.filter(isFolderEntry)
    return folders.find((f) => f.id === ref) ?? folders.find((f) => f.name.trim() === ref.trim())
}

export function listFolders(order: readonly OrderEntry[]) {
    const parents = folderParents(order)
    return order.filter(isFolderEntry).map((f) => ({
        id: f.id,
        name: f.name,
        characters: f.data.length,
        ...(parents.get(f.id) ? { parent: parents.get(f.id) } : {}),
    }))
}

/** The bots in a folder: active ones in full, deactivated ones by name. */
export function folderCharacters(entry: folder, characters: readonly (Bot | null | undefined)[], stubs: readonly ({ chaId: string, name?: string } | null | undefined)[] = []) {
    const byId = new Map(characters.filter((c): c is Bot => !!c).map((c) => [c.chaId, c]))
    return entry.data.map((chaId) => {
        const bot = byId.get(chaId)
        if (!bot) {
            const stub = stubs.find((s) => s?.chaId === chaId)
            return { id: chaId, name: stub?.name ?? '', deactivated: true }
        }
        const backups = [...byId.values()]
            .filter((c) => c.nodeOnlyEditBackupOf === chaId)
            .sort((a, b) => (b.nodeOnlyEditBackupAt ?? 0) - (a.nodeOnlyEditBackupAt ?? 0))
            .map((c) => c.chaId)
        return {
            id: bot.chaId,
            name: bot.name,
            description: clip(bot.desc, DESCRIPTION_CHARS),
            lorebooks: bot.globalLore?.length ?? 0,
            ...(bot.nodeOnlyEditBackupOf ? {
                backupOf: bot.nodeOnlyEditBackupOf,
                backupAt: bot.nodeOnlyEditBackupAt ? new Date(bot.nodeOnlyEditBackupAt).toISOString() : undefined,
            } : {}),
            ...(backups.length > 0 ? { backups } : {}),
        }
    })
}

/** Each active bot of a folder with its lorebook entries' names and keys. */
export function folderLorebooks(entry: folder, characters: readonly (Bot | null | undefined)[], count = MAX_LOREBOOKS_PER_BOT) {
    const limit = Math.min(Math.max(1, Math.floor(count) || MAX_LOREBOOKS_PER_BOT), MAX_LOREBOOKS_PER_BOT)
    const byId = new Map(characters.filter((c): c is Bot => !!c).map((c) => [c.chaId, c]))
    return entry.data.flatMap((chaId) => {
        const bot = byId.get(chaId)
        if (!bot) return []
        const lore = bot.globalLore ?? []
        return [{
            id: bot.chaId,
            name: bot.name,
            ...(bot.nodeOnlyEditBackupOf ? { backupOf: bot.nodeOnlyEditBackupOf } : {}),
            total: lore.length,
            lorebooks: lore.slice(0, limit).map((e) => ({
                name: e.comment || 'Unnamed ' + pickHashRand(5515, e.content),
                keys: e.key,
                alwaysActive: e.alwaysActive,
            })),
        }]
    })
}

const folderArg = {
    description: 'The ID or name of the folder (from risu-list-character-folders).',
    type: 'string',
}

export class FolderHandler extends MCPToolHandler {
    getTools(): MCPTool[] {
        return [
            {
                description: 'List the folders of the Risuai character list, with how many characters each holds.',
                inputSchema: { properties: {}, type: 'object' },
                name: 'risu-list-character-folders',
            },
            {
                description: 'List the characters in a folder: id, name, a short description and the number of lorebooks. Backups made before an edit are marked with the character they copy (backupOf), and a character lists its backups.',
                inputSchema: { properties: { folder: folderArg }, required: ['folder'], type: 'object' },
                name: 'risu-list-folder-characters',
            },
            {
                description: 'List the lorebooks (names, keys, always active) of every character in a folder at once. Use risu-get-character-lorebook for the contents.',
                inputSchema: {
                    properties: {
                        folder: folderArg,
                        count: { default: 100, description: 'The maximum number of lorebooks per character.', type: 'integer' },
                    },
                    required: ['folder'],
                    type: 'object',
                },
                name: 'risu-list-folder-lorebooks',
            },
        ]
    }

    async handle(toolName: string, args: any): Promise<RPCToolCallContent[] | null> {
        const order = (DBState.db.characterOrder ?? []) as OrderEntry[]
        switch (toolName) {
            case 'risu-list-character-folders':
                return text(listFolders(order))
            case 'risu-list-folder-characters':
            case 'risu-list-folder-lorebooks': {
                const entry = findFolderByRef(order, String(args?.folder ?? ''))
                if (!entry) return text(`Error: Folder "${args?.folder}" not found.`)
                const characters = DBState.db.characters as Bot[]
                return text(toolName === 'risu-list-folder-characters'
                    ? folderCharacters(entry, characters, getArchivedStubs())
                    : folderLorebooks(entry, characters, args?.count))
            }
        }
        return null
    }
}
