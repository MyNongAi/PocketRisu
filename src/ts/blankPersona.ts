// The blank persona (`nodeOnlyBlank`: named User, no description) is what the
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

/** Name, description or image that a blank persona does not have. */
export function personaHasContent(persona: Pick<RisuPersona, 'name' | 'personaPrompt' | 'icon'>): boolean {
    const name = (persona.name ?? '').trim()
    return (persona.personaPrompt ?? '').trim() !== ''
        || (persona.icon ?? '') !== ''
        || (name !== '' && name !== 'User')
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
    db.personas[index] = { ...blank, name: 'User', personaPrompt: '', icon: '', largePortrait: false }
    if (selected) {
        db.selectedPersona = db.personas.length - 1
        db.userNote = note
    }
    return db.personas.length - 1
}
