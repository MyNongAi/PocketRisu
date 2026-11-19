import { isModuleCharxName } from './shareTargetRouting'

export type DropImportDestination = 'default' | 'module'
export type DroppedImportKind = 'character' | 'module' | 'preset' | 'plugin'

/**
 * Resolves ambiguous CHARX files by the surface they were dropped onto.
 * RISUM and *.module.charx are always modules; other CHARX files follow
 * the surface they were dropped onto.
 */
export function classifyDroppedImport(
    fileName: string,
    destination: DropImportDestination = 'default',
): DroppedImportKind {
    const normalizedName = fileName.toLocaleLowerCase()
    if(normalizedName.endsWith('.risum')) return 'module'
    if(isModuleCharxName(fileName)) return 'module'
    if(normalizedName.endsWith('.js') || normalizedName.endsWith('.ts')) return 'plugin'
    if(normalizedName.endsWith('.charx')){
        return destination === 'module' ? 'module' : 'character'
    }
    if(normalizedName.endsWith('.risup') || normalizedName.endsWith('.risupreset')){
        return 'preset'
    }
    return 'character'
}
