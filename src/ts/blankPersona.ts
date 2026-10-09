// The blank persona (`nodeOnlyBlank`: no name, no description) is what the
// persona pickers bind or select for "no persona". It must stay blank, but it
// can also be the global persona, whose text lives in the root fields
// (username, personaPrompt, userIcon, userNote) and is copied back into its
// card by saveUserPersona: editing the global persona on the settings page
// then wrote into the blank one. splitBlankPersona moves such content into a
// new persona of its own, which takes the blank's place as the global persona.

import type { RisuPersona } from './storage/database.svelte'

interface PersonaRoot {
    personas: RisuPersona[]
    selectedPersona: number
    username: string
    personaPrompt: string
    userIcon: string
    userNote: string
}

/** The blank persona's name: none (the user's request, 2026-10-09; it was "User"). */
export const BLANK_PERSONA_NAME = ''
/** The name it carried before, still taken for "no name". */
const LEGACY_BLANK_PERSONA_NAME = 'User'

/** Name, description or image that a blank persona does not have. */
export function personaHasContent(persona: Pick<RisuPersona, 'name' | 'personaPrompt' | 'icon'>): boolean {
    const name = (persona.name ?? '').trim()
    return (persona.personaPrompt ?? '').trim() !== ''
        || (persona.icon ?? '') !== ''
        || (name !== BLANK_PERSONA_NAME && name !== LEGACY_BLANK_PERSONA_NAME)
}

/**
 * Keeps the blank persona blank. Content found in it — in the root fields
 * while it is the global persona, else in its card — goes to a new persona
 * appended to the list (and selected in its place when the blank was the
 * global one; the root fields already hold that content). The blank card goes
 * back to empty, keeping its id, so chats bound to it stay bound to "no
 * persona". Returns the new persona's index, or -1 when nothing moved.
 */
export function splitBlankPersona(db: PersonaRoot, newId: string, now = Date.now()): number {
    if (!Array.isArray(db.personas)) return -1
    const index = db.personas.findIndex((persona) => persona?.nodeOnlyBlank)
    if (index < 0) return -1
    const blank = db.personas[index]
    const selected = db.selectedPersona === index
    const content = selected
        ? { name: db.username, personaPrompt: db.personaPrompt, icon: db.userIcon, note: db.userNote }
        : { name: blank.name, personaPrompt: blank.personaPrompt, icon: blank.icon, note: blank.note }
    if (!personaHasContent(content)) return -1
    // The blank card's note is its label ("빈 페르소나"), not something typed.
    const note = content.note === blank.note ? '' : (content.note ?? '')
    const { nodeOnlyBlank: _blank, favorite: _favorite, ...rest } = blank
    db.personas.push({
        ...rest,
        name: content.name ?? '',
        personaPrompt: content.personaPrompt ?? '',
        icon: content.icon ?? '',
        note,
        id: newId,
        createdAt: now,
        lastAppliedAt: now,
    })
    db.personas[index] = { ...blank, name: BLANK_PERSONA_NAME, personaPrompt: '', icon: '', largePortrait: false }
    if (selected) {
        db.selectedPersona = db.personas.length - 1
        db.userNote = note
    }
    return db.personas.length - 1
}

/**
 * A blank persona still named "User" (made before 2026-10-09) loses the name,
 * and so do the root fields while it is the global persona. Run after
 * splitBlankPersona, which takes any real content out first. Returns whether
 * anything changed.
 */
export function clearLegacyBlankName(db: PersonaRoot): boolean {
    if (!Array.isArray(db.personas)) return false
    const index = db.personas.findIndex((persona) => persona?.nodeOnlyBlank)
    if (index < 0 || db.personas[index].name !== LEGACY_BLANK_PERSONA_NAME) return false
    db.personas[index] = { ...db.personas[index], name: BLANK_PERSONA_NAME }
    if (db.selectedPersona === index && db.username === LEGACY_BLANK_PERSONA_NAME) db.username = BLANK_PERSONA_NAME
    return true
}
