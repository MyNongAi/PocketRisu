import type { RisuPersona } from './storage/database.svelte'
import { changeUserPersona, personaFromBlank, updatePersonaText, type PersonaTextFields } from './persona'
import { nameOnlyName, personaFromNameOnly } from './nameOnlyPersona'

interface PersonaEditContext {
    db: { personas: RisuPersona[], nodeOnlyPersonaNames?: Record<string, string> }
    index: number
    nameOnlyId?: string | null
    followsDefault: boolean
    onBind?: (index: number) => void
}

/** Keep the blank reusable and promote name-only bindings under their existing id. */
export function editPersonaTarget(context: PersonaEditContext, patch: PersonaTextFields = {}): { index: number, created: boolean } {
    const { db, index, nameOnlyId, followsDefault, onBind } = context
    if (index < 0 && nameOnlyId && nameOnlyName(db, nameOnlyId) !== undefined) {
        return { index: personaFromNameOnly(db, nameOnlyId, patch), created: true }
    }
    if (index < 0 || !db.personas[index]?.nodeOnlyBlank) return { index, created: false }

    const created = personaFromBlank(index, patch)
    if (created >= 0 && followsDefault) {
        // A chat following the blank default keeps following the new global persona.
        changeUserPersona(created)
    } else if (created >= 0) {
        onBind?.(created)
    }
    return { index: created, created: true }
}

/** Apply text to the resolved persona; creation already applies the first patch. */
export function editPersonaText(context: PersonaEditContext, patch: PersonaTextFields): { index: number, created: boolean } {
    const target = editPersonaTarget(context, patch)
    if (target.index >= 0 && !target.created) updatePersonaText(target.index, patch)
    return target
}
