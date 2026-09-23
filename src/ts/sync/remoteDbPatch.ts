// Landing another device's database patch in this page's live state (the
// orchestration is in saveDb, which owns the patch baseline).
//
// Database patches describe chats as catalog stubs; the bodies live elsewhere.
// The server applies them to stubs, and this page must too: the patcher diffs
// chat arrays slot by slot, so inserting a chat at the front arrives as "slot
// 0's id becomes a3, slot 1's becomes a1, ...". Applied to a live array that
// holds loaded bodies, that would relabel one conversation as another. So the
// chat arrays a patch touches are turned into stubs first, the ops land on
// stubs exactly as on the server, and then every stub gets its body back by
// id (or becomes a placeholder the UI can load).

import type { Chat } from '../storage/database.svelte'
import { chatToStub, stubToPlaceholder } from '../storage/chatStorage'

const CATALOG_FIELDS = ['name', 'lastDate', 'folderId', 'modules'] as const

type CharacterLike = { chaId?: string, chats?: any[] }

const bodyKey = (chaId: string, chatId: string) => `${chaId}\u0000${chatId}`

/** Loaded chat bodies by character and chat id, taken before a patch lands. */
export function collectLiveChatBodies(characters: readonly CharacterLike[]): Map<string, Chat> {
    const bodies = new Map<string, Chat>()
    for (const character of characters) {
        if (!character?.chaId || !Array.isArray(character.chats)) continue
        for (const chat of character.chats) {
            if (!chat?.id || chat._placeholder || chat._stub) continue
            bodies.set(bodyKey(character.chaId, chat.id), chat)
        }
    }
    return bodies
}

/** Characters whose chat arrays the ops address below the character itself. */
export function characterIndexesWithChatOps(ops: readonly { path?: string, from?: string }[]): Set<number> {
    const indexes = new Set<number>()
    for (const op of ops) {
        for (const path of [op?.path, op?.from]) {
            const match = typeof path === 'string' ? /^\/characters\/(\d+)\/chats(?:\/|$)/.exec(path) : null
            if (match) indexes.add(Number(match[1]))
        }
    }
    return indexes
}

/** Replace the chats of these characters with their catalog stubs, in place. */
export function stubChatsForPatch(characters: readonly CharacterLike[], indexes: Iterable<number>): void {
    for (const index of indexes) {
        const chats = characters[index]?.chats
        if (!Array.isArray(chats)) continue
        for (let i = 0; i < chats.length; i++) {
            if (chats[i] && chats[i]._stub !== true) chats[i] = chatToStub(chats[i])
        }
    }
}

/**
 * Turn the stubs left in the live chat arrays into renderable chats, in
 * place. A chat whose body was loaded gets that body back with the catalog
 * fields from its stub; the rest become placeholders.
 */
export function settleChatsAfterRemotePatch(characters: readonly CharacterLike[], bodies: ReadonlyMap<string, Chat>): number {
    let settled = 0
    for (const character of characters) {
        if (!character?.chaId || !Array.isArray(character.chats)) continue
        const chats = character.chats
        for (let index = 0; index < chats.length; index++) {
            const stub = chats[index]
            if (!stub || stub._stub !== true || Array.isArray(stub.message)) continue
            const body = bodies.get(bodyKey(character.chaId, stub.id))
            if (body) {
                for (const field of CATALOG_FIELDS) {
                    if (field in stub) (body as any)[field] = stub[field]
                    else delete (body as any)[field]
                }
                chats[index] = body
            } else {
                chats[index] = stubToPlaceholder(stub)
            }
            settled++
        }
    }
    return settled
}

/** Which save-tracker blocks a patch touches, so the baseline rescans them. */
export function blocksTouchedByOps(ops: readonly { path?: string }[]): { botPreset: boolean, modules: boolean } {
    let botPreset = false
    let modules = false
    for (const op of ops) {
        const path = typeof op?.path === 'string' ? op.path : ''
        if (path === '/botPresets' || path.startsWith('/botPresets/')) botPreset = true
        if (path === '/modules' || path.startsWith('/modules/')) modules = true
    }
    return { botPreset, modules }
}

/** The slice of RisuSavePatcher this needs (kept structural to avoid an import cycle). */
export interface PatchBaseline<Self> {
    hash(): string
    fork(): Self
    set(data: any, toSave: any): Promise<{ patch: any[], expectedHash: string }>
}

export type LandResult<P> =
    | { status: 'applied', patcher: P }
    /** This page is not at the patch's starting point (behind, or already past it). */
    | { status: 'not-at-base' }
    /** This page has database edits it has not saved; its next save rebases. */
    | { status: 'local-changes' }
    /** Applied, but the baseline did not reach the server's hash. */
    | { status: 'diverged' }

/**
 * Land another device's database patch in `db` (the live state) and return
 * the baseline advanced to the server's new revision.
 *
 * The ops address array slots by index, so they are exact only when this
 * page matches the baseline they were computed against: that is checked by
 * hash first and by a dry-run diff second, and nothing is touched unless
 * both hold. `mutate` wraps the in-place write so the caller can pause its
 * change tracking around it.
 */
export async function landRemoteDbPatch<P extends PatchBaseline<P>>(args: {
    patcher: P
    db: any
    event: { ops: any[], prevHash: string, nextHash: string }
    probeToSave: any
    nextToSave: (touched: { botPreset: boolean, modules: boolean }) => any
    mutate: (write: () => void) => Promise<void>
}): Promise<LandResult<P>> {
    const { patcher, db, event } = args
    if (patcher.hash() !== event.prevHash) return { status: 'not-at-base' }

    const probe = patcher.fork()
    const local = await probe.set(db, args.probeToSave)
    if (local.patch.length > 0) return { status: 'local-changes' }

    const { applyPatch } = await import('fast-json-patch')
    const bodies = collectLiveChatBodies(db.characters ?? [])
    await args.mutate(() => {
        stubChatsForPatch(db.characters ?? [], characterIndexesWithChatOps(event.ops))
        applyPatch(db, event.ops, false, true)
        settleChatsAfterRemotePatch(db.characters ?? [], bodies)
    })

    const next = patcher.fork()
    await next.set(db, args.nextToSave(blocksTouchedByOps(event.ops)))
    if (next.hash() !== event.nextHash) return { status: 'diverged' }
    return { status: 'applied', patcher: next }
}
