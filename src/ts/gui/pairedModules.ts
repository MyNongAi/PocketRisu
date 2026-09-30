// Modules paired with a bot: listed in a character's own modules
// (character.modules), so they switch on in that bot's chats only. The
// module lists mark them with a red link (PairedModuleMark).

/** Module id -> names of the characters that list it in their own modules. */
export function charactersByPairedModule(
    characters: readonly ({ name?: string, modules?: readonly string[] } | null | undefined)[],
): Map<string, string[]> {
    const pairs = new Map<string, string[]>()
    for (const character of characters) {
        if (!character?.modules?.length) continue
        const name = character.name || 'Unnamed'
        for (const id of new Set(character.modules)) {
            const names = pairs.get(id)
            if (names) names.push(name)
            else pairs.set(id, [name])
        }
    }
    return pairs
}
