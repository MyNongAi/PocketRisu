export type DropImportDestination = 'default' | 'module'
export type DroppedImportKind = 'character' | 'module' | 'preset'

/**
 * Resolves ambiguous CHARX files by the surface they were dropped onto.
 * RISUM is always a module; CHARX is a character everywhere except the
 * explicit module catalog surface.
 */
export function classifyDroppedImport(
    fileName: string,
    destination: DropImportDestination = 'default',
): DroppedImportKind {
    const normalizedName = fileName.toLocaleLowerCase()
    if(normalizedName.endsWith('.risum')) return 'module'
    if(normalizedName.endsWith('.charx')){
        return destination === 'module' ? 'module' : 'character'
    }
    if(normalizedName.endsWith('.risup') || normalizedName.endsWith('.risupreset')){
        return 'preset'
    }
    return 'character'
}
