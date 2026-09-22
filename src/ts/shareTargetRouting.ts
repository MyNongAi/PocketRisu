export type SharedImportKind = 'character' | 'module' | 'preset' | 'plugin'

export function classifySharedImport(name: string, type = ''): SharedImportKind | null {
    const lowerName = name.toLowerCase()
    const lowerType = type.toLowerCase()
    if (lowerName.endsWith('.risum') || lowerName.endsWith('.lorebook')) return 'module'
    if (lowerName.endsWith('.risup') || lowerName.endsWith('.risupreset')) return 'preset'
    // Plugins are plain source files. Checked before the generic extensions
    // below so a `.js` never falls through to the character importer.
    if (lowerName.endsWith('.js') || lowerName.endsWith('.ts')) return 'plugin'
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
