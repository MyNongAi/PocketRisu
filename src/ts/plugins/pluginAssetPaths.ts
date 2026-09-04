import { parseExternalAssetLocation } from '../storage/externalAssets'

export function normalizePluginAssetReadPath(path: unknown): string {
    if (typeof path !== 'string') throw new Error('readImage expects an asset reference')
    const external = parseExternalAssetLocation(path)
    if (external) return external.uri
    const name = path.startsWith('assets/') ? path.slice(7) : path
    if (!name || name === '.' || name === '..' || /[\/\\\x00-\x1f]/.test(name)) {
        throw new Error('readImage accepts assets/<filename> or a valid external://provider/sha256 reference only')
    }
    return 'assets/' + name
}
