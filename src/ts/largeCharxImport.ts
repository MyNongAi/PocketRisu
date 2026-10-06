import { planCharxImport, type CharxDestination, type CharxImportPlan } from './charxPreflight'

/**
 * planCharxImport for the bot and module importers. A large CHARX is no
 * longer asked about (the user's request, 2026-10-06: the bot / module
 * question confused more than it helped): it goes where the file was headed,
 * `preferred` (the bot importer or the module importer), except that a module
 * export's own name ("*.module.charx") always makes a module. It still
 * imports guarded, so the progress card can cancel it and undo its assets.
 */
export function planLargeCharxImport(
    name: string,
    data: Uint8Array | Blob | ReadableStream<Uint8Array>,
    preferred: CharxDestination,
): Promise<CharxImportPlan> {
    const destination: CharxDestination = name.toLowerCase().endsWith('.module.charx') ? 'module' : preferred
    return planCharxImport(name, data, async () => destination)
}
