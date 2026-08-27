import { language } from 'src/lang'
import { notifySuccess } from './alert'
import { importCharacterProcess } from './characterCards'
import { classifyDroppedImport, type DropImportDestination } from './dropImportRouting'
import { checkCharOrder } from './globalApi.svelte'
import { runImportBatch } from './importProgress'
import { importModuleFile } from './process/modules'
import { importPreset } from './storage/database.svelte'

export async function importDroppedFiles(
    files: readonly File[],
    destination: DropImportDestination = 'default',
) {
    let importedCharacter = false
    const result = await runImportBatch(files, async (file, report) => {
        const kind = classifyDroppedImport(file.name, destination)

        if(kind === 'preset'){
            report({ label: language.importProgress.readingPreset, progress: 20 })
            const data = new Uint8Array(await file.arrayBuffer())
            await importPreset({ name: file.name, data })
            report({ label: language.importProgress.savingPreset, progress: 90 })
            return
        }

        if(kind === 'module'){
            const data = new Uint8Array(await file.arrayBuffer())
            await importModuleFile(
                { name: file.name, data },
                { suppressSuccess: true, onProgress: report },
            )
            return
        }

        await importCharacterProcess({
            name: file.name,
            data: file,
            onProgress: report,
            suppressSuccess: true,
        })
        importedCharacter = true
    })

    if(importedCharacter) checkCharOrder()
    if(result.completed > 0){
        notifySuccess(`${result.completed}/${result.total} ${language.successImport}`)
    }
    return result
}
