// Where the screen goes after an import (the user's request, 2026-10-31,
// "멋대로 봇 이동하는거 불편해"): to the bot the import added, and only when
// "go to the character on import" is on. The add menu used to open the last
// bot in the list after any import, the toggle off or the import cancelled.

type CharacterRef = { chaId?: string } | null | undefined

/** The chaIds there before an import, for characterToOpenAfterImport. */
export function characterIdsBefore(characters: readonly CharacterRef[]): Set<string | undefined> {
    return new Set(characters.map((character) => character?.chaId))
}

/**
 * The bot to open after an import: the newest one not there before, or -1
 * when `opens` is false (the toggle is off) or the import added none.
 */
export function characterToOpenAfterImport(
    characters: readonly CharacterRef[],
    before: ReadonlySet<string | undefined>,
    opens: boolean,
): number {
    if (!opens) return -1
    return characters.findLastIndex((character) => !!character && !before.has(character.chaId))
}
