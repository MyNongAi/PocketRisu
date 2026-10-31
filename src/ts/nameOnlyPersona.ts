// A persona made in the chat sidebar's persona popup with nothing but a name
// is not a persona (the user's request, 2026-10-31): such entries filled the
// persona tab with names that hold nothing. The chat binds an id that names
// it in `nodeOnlyPersonaNames` instead, out of every persona list. A
// description, note or image makes it a persona under the same id, so every
// chat bound to it (its branches too) keeps it.
//
// The names are never swept: chats that are not open, and the chats of
// deactivated bots, are not loaded in the page, so nothing here can tell
// that no chat binds a name any more. Each entry is a few bytes.

import type { RisuPersona } from './storage/database.svelte'

type PersonaText = Partial<Pick<RisuPersona, 'name' | 'personaPrompt' | 'note'>>

interface NameRoot {
    personas: RisuPersona[]
    nodeOnlyPersonaNames?: Record<string, string>
}

interface PersonaRoot extends NameRoot {
    selectedPersona: number
}

/** The name a name-only binding `id` carries, or undefined when `id` is none. */
export function nameOnlyName(db: Pick<NameRoot, 'nodeOnlyPersonaNames'>, id: string | null | undefined): string | undefined {
    const names = db.nodeOnlyPersonaNames
    if (!id || !names || !Object.hasOwn(names, id)) return undefined
    return typeof names[id] === 'string' ? names[id] : undefined
}

/**
 * The persona a chat binds by `id`: the persona with that id, else its
 * name-only binding drawn as a persona with nothing but the name.
 */
export function boundPersona(db: NameRoot, id: string | null | undefined): RisuPersona | undefined {
    if (!id) return undefined
    const persona = db.personas?.find((entry) => entry?.id === id)
    if (persona) return persona
    const name = nameOnlyName(db, id)
    return name === undefined ? undefined : { id, name, icon: '', personaPrompt: '', note: '' }
}

/** The name-only bindings `chats` use, for a character package that carries their bindings. */
export function nameOnlyNamesFor(db: Pick<NameRoot, 'nodeOnlyPersonaNames'>, chats: readonly ({ bindedPersona?: string } | null | undefined)[]): Record<string, string> {
    const names: Record<string, string> = {}
    for (const chat of chats) {
        const name = nameOnlyName(db, chat?.bindedPersona)
        if (name !== undefined) names[chat!.bindedPersona!] = name
    }
    return names
}

/** Adds the names a character package brought; an id this database already names keeps its name. */
export function addNameOnlyNames(db: NameRoot, names: unknown) {
    if (!names || typeof names !== 'object' || Array.isArray(names)) return
    const added = Object.entries(names).filter(([id, name]) => typeof name === 'string' && id && nameOnlyName(db, id) === undefined)
    if (added.length > 0) db.nodeOnlyPersonaNames = { ...(db.nodeOnlyPersonaNames ?? {}), ...Object.fromEntries(added) }
}

/** An edit that leaves a persona with only a name: no description or note typed. */
export function keepsNameOnly(patch: PersonaText): boolean {
    return !(patch.personaPrompt ?? '').trim() && !(patch.note ?? '').trim()
}

/** Sets the name of the name-only binding `id`, adding it when new. */
export function setNameOnlyName(db: NameRoot, id: string, name: string) {
    db.nodeOnlyPersonaNames = { ...(db.nodeOnlyPersonaNames ?? {}), [id]: name }
}

/**
 * The name-only binding `id` becomes a persona with `patch` applied, under
 * the same id. Returns its index, or -1 when `id` is no name-only binding.
 */
export function personaFromNameOnly(db: NameRoot, id: string, patch: PersonaText = {}, now = Date.now()): number {
    const name = nameOnlyName(db, id)
    if (name === undefined) return -1
    const { [id]: _promoted, ...names } = db.nodeOnlyPersonaNames ?? {}
    db.personas = [...db.personas, { id, name, icon: '', personaPrompt: '', note: '', createdAt: now, lastAppliedAt: now, ...patch }]
    db.nodeOnlyPersonaNames = names
    return db.personas.length - 1
}

/**
 * A persona that holds nothing but a name: no description, note or image,
 * and nothing set on it by hand (favorite, folder, module, collection). The
 * blank persona and the selected (global) one are never counted.
 */
export function isNameOnlyPersona(db: PersonaRoot, index: number): boolean {
    const persona = db.personas[index]
    if (!persona || persona.nodeOnlyBlank || index === db.selectedPersona) return false
    return !(persona.personaPrompt ?? '').trim()
        && !(persona.note ?? '').trim()
        && !persona.icon
        && !persona.favorite
        && !persona.folderId
        && !persona.embeddedModule
        && !persona.sourceInfo
}

export function nameOnlyPersonaCount(db: PersonaRoot): number {
    return (db.personas ?? []).filter((_, index) => isNameOnlyPersona(db, index)).length
}

/**
 * Takes every persona that holds nothing but a name out of the persona list
 * (the persona tab's "빈 페르소나 정리"). Its name stays as a name-only
 * binding under its id, so a chat bound to it keeps the name, open or not.
 * The selected persona stays selected. Returns how many went.
 */
export function retireNameOnlyPersonas(db: PersonaRoot): number {
    const retired = db.personas.filter((_, index) => isNameOnlyPersona(db, index))
    if (retired.length === 0) return 0
    const selected = db.personas[db.selectedPersona]
    const names = { ...(db.nodeOnlyPersonaNames ?? {}) }
    for (const persona of retired) {
        // One without an id is bound by no chat.
        if (persona.id && !Object.hasOwn(names, persona.id)) names[persona.id] = persona.name ?? ''
    }
    const kept = db.personas.filter((persona) => !retired.includes(persona))
    db.personas = kept
    db.nodeOnlyPersonaNames = names
    db.selectedPersona = Math.max(0, kept.indexOf(selected))
    return retired.length
}
