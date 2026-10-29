import { get } from 'svelte/store'
import { changeChar } from '../characters'
import { getDatabase } from '../storage/database.svelte'
import { selectedCharID, settingsOpen } from '../stores.svelte'
import { botVisits, installMouseHistoryButtons } from './botVisitHistory'

/** The mouse's back and forward buttons step through the bots opened (botVisitHistory.ts). */
export function initBotVisitButtons() {
    installMouseHistoryButtons(window, (direction) => {
        const db = getDatabase()
        // Settings cover the bot: back from them opens that bot again.
        const currentId = get(settingsOpen) ? undefined : db.characters[get(selectedCharID)]?.chaId
        botVisits.step(direction, currentId, (characterId) => {
            const index = db.characters.findIndex((character) => character?.chaId === characterId && !character.trashTime)
            if (index < 0) return false
            settingsOpen.set(false)
            changeChar(index)
            return true
        })
    })
}
