export type SharedImportKind = 'character' | 'module' | 'preset'

export function classifySharedImport(name: string, type = ''): SharedImportKind | null {
    const lowerName = name.toLowerCase()
    const lowerType = type.toLowerCase()
    if (lowerName.endsWith('.risum') || lowerName.endsWith('.lorebook')) return 'module'
    if (lowerName.endsWith('.risup') || lowerName.endsWith('.risupreset')) return 'preset'
    if (
        lowerName.endsWith('.charx')
        || lowerName.endsWith('.png')
        || lowerName.endsWith('.jpg')
        || lowerName.endsWith('.jpeg')
        || lowerName.endsWith('.json')
        || lowerType.startsWith('image/')
    ) return 'character'
    return null
}
