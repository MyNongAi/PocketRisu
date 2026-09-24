export type SharedImportKind = 'character' | 'module' | 'preset' | 'plugin'

/** Which import button started the import: it settles files both importers read. */
export type ImportOrigin = 'character' | 'module'

export function classifySharedImport(name: string, type = '', origin: ImportOrigin = 'character'): SharedImportKind | null {
    const lowerName = name.toLowerCase()
    const lowerType = type.toLowerCase()
    if (lowerName.endsWith('.risum') || lowerName.endsWith('.lorebook')) return 'module'
    // Modules are exported as character cards named "<name>.module.charx", so
    // a .charx can be either. The export's own name settles it; otherwise a
    // .charx or .json opened from the module page is read as a module, the
    // way that page's own file picker reads them.
    if (lowerName.endsWith('.module.charx')) return 'module'
    if (origin === 'module' && (lowerName.endsWith('.charx') || lowerName.endsWith('.json'))) return 'module'
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
