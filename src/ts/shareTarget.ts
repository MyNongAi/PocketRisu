import { importCharacterProcess } from "./characterCards"
import { importModuleFile } from "./process/modules"
import { notifyError, notifySuccess } from "./alert"
import { language } from "src/lang"
import { selectMultipleFile } from "./util"
import { importPreset } from "./storage/database.svelte"
import { openSettings, SettingsRoute } from "./routing"
import { classifySharedImport, type SharedImportKind } from "./shareTargetRouting"

interface SharedPayloadFile {
    url: string
    name: string
    type?: string
    size?: number
    kind?: SharedImportKind
}

interface SharedPayload {
    version: number
    title?: string
    text?: string
    url?: string
    files?: SharedPayloadFile[]
}

async function importSharedFile(file: SharedPayloadFile, data: Uint8Array): Promise<boolean> {
    const kind = classifySharedImport(file.name, file.type)
    if (kind === 'module') {
        await importModuleFile({ name: file.name, data }, { suppressSuccess: true })
        return true
    }
    if (kind === 'preset') {
        await importPreset({ name: file.name, data })
        openSettings(SettingsRoute.ChatBot)
        return true
    }
    if (kind === 'character') {
        await importCharacterProcess({
            name: file.name,
            data,
            suppressSuccess: true,
        })
        return true
    }
    return false
}

async function consumePostedShare(): Promise<boolean> {
    if (window.location.hash !== '#share_payload') return false
    window.history.replaceState({}, '', '/')

    let imported = 0
    let total = 0
    try {
        const response = await fetch('/sw/share/payload', { cache: 'no-store' })
        if (!response.ok) throw new Error(`share payload ${response.status}`)
        const payload = await response.json() as SharedPayload
        const sharedUrl = payload.url || payload.text || ''
        if (sharedUrl.includes('drive.proton.me/urls/')) {
            window.open(sharedUrl, '_blank')
        }

        const files = Array.isArray(payload.files) ? payload.files : []
        total = files.length
        for (const file of files) {
            if (!file?.url?.startsWith('/sw/share/file/')) continue
            const fileResponse = await fetch(file.url, { cache: 'no-store' })
            if (!fileResponse.ok) throw new Error(`shared file ${fileResponse.status}`)
            const data = new Uint8Array(await fileResponse.arrayBuffer())
            if (await importSharedFile(file, data)) imported++
        }

        if (imported > 0) {
            notifySuccess(`${imported}/${total} ${language.successImport}`)
        }
        else if (!sharedUrl) {
            notifyError(language.errors.noData)
        }
    }
    catch (error) {
        console.error('[ShareTarget] import failed', error)
        notifyError(language.errors.noData)
    }
    finally {
        await fetch('/sw/share/consume', { method: 'POST' }).catch(() => {})
    }
    return true
}

export async function handleShareTarget() {
    if (await consumePostedShare()) return

    const params = new URLSearchParams(window.location.search)
    const sharedUrl = params.get('url') || params.get('text') || ''

    if (!sharedUrl) return

    window.history.replaceState({}, '', '/')

    if (sharedUrl.includes('drive.proton.me/urls/')) {
        window.open(sharedUrl, '_blank')
    }

    setTimeout(async () => {
        const files = await selectMultipleFile(['charx', 'png', 'json', 'risum', 'risup', 'lorebook'])
        if (!files || files.length === 0) return

        let imported = 0
        for (const file of files) {
            if (await importSharedFile({ name: file.name, url: '', type: '' }, file.data)) imported++
        }
        if (imported > 0) notifySuccess(`${imported}/${files.length} ${language.successImport}`)
    }, 500)
}
