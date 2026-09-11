import { importCharacterProcess } from "./characterCards"
import { importModuleFile } from "./process/modules"
import { notifySuccess } from "./alert"
import { language } from "src/lang"
import { selectMultipleFile } from "./util"

export function handleShareTarget() {
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

        for (const file of files) {
            const lowerName = file.name.toLowerCase()
            if (lowerName.endsWith('.risum') || lowerName.endsWith('.lorebook')) {
                await importModuleFile(file)
            } else {
                await importCharacterProcess(file)
            }
        }
        notifySuccess(language.protonImportSuccess)
    }, 500)
}
