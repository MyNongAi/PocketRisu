import { getDatabase, saveImage, setDatabase } from "./storage/database.svelte"
import { selectSingleFile, sleep } from "./util"
import { alertError, alertStore, notifySuccess, notifyError } from "./alert"
import { AppendableBuffer, downloadFile, readImage, requestImmediateSave } from "./globalApi.svelte"
import { language } from "src/lang"
import { reencodeImage } from "./process/files/inlays"
import { PngChunk } from "./pngChunk"
import { v4 } from "uuid"
import { PERSONA_IMAGE_EXTENSIONS, validatePersonaImage } from "./personaImage"

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

export async function selectUserImg() {
    const selected = await selectSingleFile([...PERSONA_IMAGE_EXTENSIONS])
    if (!selected) {
        return
    }

    try {
        await setUserPersonaImage(selected.data)
    } catch (error) {
        alertError(error)
    }
}

export function saveUserPersona() {
    let db = getDatabase()
    db.personas[db.selectedPersona].name = db.username
    db.personas[db.selectedPersona].icon = db.userIcon
    db.personas[db.selectedPersona].personaPrompt = db.personaPrompt
    db.personas[db.selectedPersona].note = db.userNote
}

export function changeUserPersona(id: number, save: 'save' | 'noSave' = 'save') {
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
}

interface PersonaCard {
    name: string
    personaPrompt: string
    note?: string
}

export async function exportUserPersona() {
    let db = getDatabase({ snapshot: true })
    if ((!db.username) || (!db.personaPrompt)) {
        notifyError("username or persona prompt is empty")
        return
    }

    let img: Uint8Array
    if (!db.userIcon) {
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
        img = await readImage(db.userIcon)
    }

    let card: PersonaCard = safeStructuredClone({
        name: db.username,
        personaPrompt: db.personaPrompt,
        note: db.userNote,
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
    await downloadFile(`${db.username.replace(/[<>:"/\\|?*\.\,]/g, "")}_export.png`, img)

    notifySuccess(language.successExport)
}

export async function importUserPersona() {
    try {
        const v = await selectSingleFile(['png'])
        if (!v) {
            return
        }
        const readGenerator = PngChunk.readGenerator(v.data)
        let decoded: string | undefined;

        for await (const chunk of readGenerator) {
            if (chunk && !(chunk instanceof AppendableBuffer) && chunk.key === 'persona') {
                decoded = chunk.value
                break
            }
        }

        if (!decoded) {
            alertError(language.errors.noData)
            return
        }
        const data: PersonaCard = JSON.parse(Buffer.from(decoded, 'base64').toString('utf-8'))
        if (data.name && data.personaPrompt) {
            let db = getDatabase()
            db.personas.push({
                name: data.name,
                icon: await saveImage(await reencodeImage(v.data)),
                personaPrompt: data.personaPrompt,
                note: data.note,
                id: v4()
            })
            notifySuccess(language.successImport)
        } else {
            alertError(language.errors.noData)
        }
    } catch (error) {
        alertError(error)
        return
    }
}
