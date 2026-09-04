import { DBState } from '../stores.svelte'
import { chooseTitleColor } from './titleColors'

export async function editCharacterTitleColor(characterId: string): Promise<void> {
    const character = DBState.db.characters.find(item => item?.chaId === characterId)
    if (!character) return
    const color = await chooseTitleColor(character.titleColor)
    if (color === null) return
    // Selection/sync can change the catalog while the picker is open.
    const current = DBState.db.characters.find(item => item?.chaId === characterId)
    if (!current) return
    if (color) current.titleColor = color
    else delete current.titleColor
}
