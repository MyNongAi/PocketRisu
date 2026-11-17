import { importPlugin } from './plugins.svelte'

/** Install one dropped plugin script through the same importer as the button. */
export async function importPluginFile(file: File): Promise<boolean> {
    const code = (await file.text()).replace(/^\uFEFF/gm, '')
    return await importPlugin(code, { isTypescript: /\.ts$/i.test(file.name) }) === true
}
