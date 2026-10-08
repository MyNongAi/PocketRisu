import { getDatabase, saveImage, setDatabase, type RisuPersona } from "./storage/database.svelte"
import { selectSingleFile, sleep } from "./util"
import { alertError, alertStore, notifySuccess, notifyError } from "./alert"
import { AppendableBuffer, downloadFile, readImage, requestImmediateSave } from "./globalApi.svelte"
import { language } from "src/lang"
import { reencodeImage } from "./process/files/inlays"
import { PngChunk } from "./pngChunk"
import { v4 } from "uuid"
import { PERSONA_IMAGE_EXTENSIONS, validatePersonaImage } from "./personaImage"
import { splitBlankPersona } from "./blankPersona"

/**
 * Shared persona-image write path for the picker and drag-and-drop UI.
 * Non-selected persona cards can be updated without changing the active
 * persona; the active card also mirrors its icon into the legacy root field.
 */
export async function setUserPersonaImage(img: Uint8Array, personaIndex?: number) {
    const db = getDatabase()
    const targetIndex = personaIndex ?? db.selectedPersona
    const target = db.personas[targetIndex]
    if (!target) {
        throw new Error('Persona not found')
    }

    // The image write can take long enough for the user to reorder personas.
    // Pin the target by a unique id before the first await; an array index is
    // not a stable identity across Sortable operations.
    const duplicateTargetId = target.id
        && db.personas.some((persona, index) => index !== targetIndex && persona.id === target.id)
    const targetId = !target.id || duplicateTargetId ? v4() : target.id
    if (target.id !== targetId) target.id = targetId

    const imageInfo = await validatePersonaImage(img)
    const imgp = await saveImage(img, '', `persona.${imageInfo.extension}`)
    const currentIndex = db.personas.findIndex((persona) => persona.id === targetId)
    if (currentIndex === -1) {
        // The persona was removed while its bytes were being stored. Leaving
        // the remaining array untouched is safer than reusing the stale slot.
        throw new Error('Persona was removed before the image finished saving')
    }

    const currentTarget = db.personas[currentIndex]
    const selectedTargetId = db.personas[db.selectedPersona]?.id
    if (selectedTargetId === targetId) {
        db.userIcon = imgp
        db.personas[currentIndex] = {
            ...currentTarget,
            name: db.username,
            icon: imgp,
            personaPrompt: db.personaPrompt,
            note: db.userNote,
            id: targetId,
        }
    } else {
        db.personas[currentIndex] = {
            ...currentTarget,
            icon: imgp,
            id: targetId,
        }
    }

    void requestImmediateSave()
    return imgp
}

export async function selectUserImg(personaIndex?: number) {
    const selected = await selectSingleFile([...PERSONA_IMAGE_EXTENSIONS])
    if (!selected) {
        return
    }

    try {
        await setUserPersonaImage(selected.data, personaIndex)
    } catch (error) {
        alertError(error)
    }
}

export function saveUserPersona() {
    let db = getDatabase()
    // Edits made while the blank persona is the global one go to a new
    // persona, which becomes the global one; the blank stays blank.
    splitBlankPersona(db, v4())
    db.personas[db.selectedPersona].name = db.username
    db.personas[db.selectedPersona].icon = db.userIcon
    db.personas[db.selectedPersona].personaPrompt = db.personaPrompt
    db.personas[db.selectedPersona].note = db.userNote
}

/**
 * Index of the blank persona (named User, no description), created on first
 * use and reused after; the persona picker offers it next to "default".
 */
export function ensureBlankPersonaIndex(): number {
    const db = getDatabase()
    let index = db.personas.findIndex((persona) => persona.nodeOnlyBlank)
    if (index < 0) {
        const now = Date.now()
        db.personas = [...db.personas, {
            id: v4(),
            name: 'User',
            icon: '',
            personaPrompt: '',
            note: language.personaBlank,
            createdAt: now,
            lastAppliedAt: now,
            nodeOnlyBlank: true,
        }]
        index = db.personas.length - 1
    }
    return index
}

export type PersonaTextFields = Partial<Pick<RisuPersona, 'name' | 'personaPrompt' | 'note'>>

/**
 * Edit one persona's text in place (the chat sidebar's binding popup). The
 * active persona's text also lives in the root fields that saveUserPersona
 * copies back into its card, so those change with it.
 */
export function updatePersonaText(index: number, patch: PersonaTextFields) {
    const db = getDatabase()
    const persona = db.personas[index]
    if (!persona) return
    Object.assign(persona, patch)
    if (index !== db.selectedPersona) return
    if (patch.name !== undefined) db.username = patch.name
    if (patch.personaPrompt !== undefined) db.personaPrompt = patch.personaPrompt
    if (patch.note !== undefined) db.userNote = patch.note
}

/**
 * A new persona from the blank one with `patch` applied, appended to the
 * list; the blank one stays blank for the next time. Returns its index.
 */
export function personaFromBlank(blankIndex: number, patch: PersonaTextFields = {}): number {
    const db = getDatabase()
    const blank = db.personas[blankIndex]
    if (!blank) return -1
    const now = Date.now()
    const { nodeOnlyBlank: _blank, favorite: _favorite, ...rest } = blank
    db.personas = [...db.personas, {
        ...rest,
        id: v4(),
        note: '',
        createdAt: now,
        lastAppliedAt: now,
        ...patch,
    }]
    return db.personas.length - 1
}

/**
 * When a persona was last applied; one never applied since lastAppliedAt
 * arrived counts as the oldest. Most personas predate the field, and
 * Number(undefined) is NaN: a NaN difference made the "recently applied"
 * sort inconsistent, so the persona just picked did not come first.
 */
export function personaAppliedAt(persona: { lastAppliedAt?: number } | null | undefined): number {
    return Number(persona?.lastAppliedAt) || 0
}

/** Persona indexes, the last applied first; ties keep the list order. */
export function compareRecentlyApplied(personas: readonly ({ lastAppliedAt?: number } | null | undefined)[]) {
    return (left: number, right: number) => (personaAppliedAt(personas[right]) - personaAppliedAt(personas[left])) || left - right
}

export function markPersonaApplied(id: number, at = Date.now()) {
    const persona = getDatabase().personas[id]
    if (!persona) return
    persona.lastAppliedAt = at
}

export function changeUserPersona(
    id: number,
    save: 'save' | 'noSave' = 'save',
    markApplied = true,
) {
    if (save === 'save') {
        saveUserPersona()
    }
    let db = getDatabase()
    const pr = db.personas[id]
    db.personaPrompt = pr.personaPrompt
    db.username = pr.name
    db.userIcon = pr.icon
    db.userNote = pr.note
    db.selectedPersona = id
    if (markApplied) markPersonaApplied(id)
}

export interface PersonaCard {
    name: string
    personaPrompt: string
    note?: string
}

/** Read the optional persona payload without treating an ordinary PNG as an error. */
export async function readEmbeddedPersonaCard(img: Uint8Array): Promise<PersonaCard | null> {
    const readGenerator = PngChunk.readGenerator(img)
    let decoded: string | undefined
    for await (const chunk of readGenerator) {
        if (chunk && !(chunk instanceof AppendableBuffer) && chunk.key === 'persona') {
            decoded = chunk.value
            break
        }
    }
    if (!decoded) return null
    const data: PersonaCard = JSON.parse(Buffer.from(decoded, 'base64').toString('utf-8'))
    return data?.name && data?.personaPrompt ? data : null
}

/** Import a persona-bearing PNG. Returns null for a normal image. */
export async function importUserPersonaImage(img: Uint8Array): Promise<number | null> {
    const data = await readEmbeddedPersonaCard(img)
    if (!data) return null
    const db = getDatabase()
    const index = db.personas.length
    const now = Date.now()
    db.personas.push({
        name: data.name,
        icon: await saveImage(await reencodeImage(img)),
        personaPrompt: data.personaPrompt,
        note: data.note,
        id: v4(),
        createdAt: now,
        lastAppliedAt: now,
    })
    return index
}

export async function exportUserPersona(personaIndex?: number) {
    let db = getDatabase({ snapshot: true })
    const persona = personaIndex === undefined
        ? {
            name: db.username,
            personaPrompt: db.personaPrompt,
            note: db.userNote,
            icon: db.userIcon,
        }
        : db.personas[personaIndex]
    if (!persona || !persona.name || !persona.personaPrompt) {
        notifyError("username or persona prompt is empty")
        return
    }

    let img: Uint8Array
    if (!persona.icon) {
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 256
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = 'rgb(100, 116, 139)'
        ctx.fillRect(0, 0, 256, 256)
        const dataUrl = canvas.toDataURL('image/png')
        const base64 = dataUrl.split(',')[1]
        img = new Uint8Array(Buffer.from(base64, 'base64'))
    } else {
        img = await readImage(persona.icon)
    }

    let card: PersonaCard = safeStructuredClone({
        name: persona.name,
        personaPrompt: persona.personaPrompt,
        note: persona.note,
    })

    alertStore.set({
        type: 'wait',
        msg: 'Loading... (Writing Exif)'
    })

    await sleep(10)

    img = (await PngChunk.write(await reencodeImage(img), {
        "persona": Buffer.from(JSON.stringify(card)).toString('base64')
    })) as Uint8Array

    alertStore.set({
        type: 'wait',
        msg: 'Loading... (Writing)'
    })

    await sleep(10)
    await downloadFile(`${persona.name.replace(/[<>:"/\\|?*\.\,]/g, "")}_export.png`, img)

    notifySuccess(language.successExport)
}

export async function importUserPersona() {
    try {
        const v = await selectSingleFile(['png'])
        if (!v) {
            return
        }
        const index = await importUserPersonaImage(v.data)
        if (index === null) {
            alertError(language.errors.noData)
            return
        }
        notifySuccess(language.successImport)
    } catch (error) {
        alertError(error)
        return
    }
}
