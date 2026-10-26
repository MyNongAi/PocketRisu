// A NEW mark (lib/UI/NewMark.svelte) on bots and modules received from outside
// (a file, Realm, Proton) until they are first looked at (the user's request,
// 2026-10-21): a bot until it is opened, a module until it is opened in the
// editor or switched on. Kept on the entity (nodeOnlyUnseen), so the mark goes
// on every device at once.

import { DBState } from './stores.svelte'

class NewMarks {
    /** The bots still unseen, by chaId (the bot list draws the mark on their thumbnails). */
    characters = $derived(new Set(
        (DBState.db?.characters ?? []).filter((character) => character?.nodeOnlyUnseen).map((character) => character.chaId),
    ))
}

export const newMarks = new NewMarks()

/** The mark goes once the bot or module is looked at. */
export function markSeen(entity: { nodeOnlyUnseen?: boolean } | null | undefined): void {
    if (entity?.nodeOnlyUnseen) delete entity.nodeOnlyUnseen
}

/** Whether the NEW mark goes before its name. */
export function hasNewMark(entity: { nodeOnlyUnseen?: boolean } | null | undefined): boolean {
    return !!entity?.nodeOnlyUnseen
}
