import { language } from 'src/lang'
import { alertConfirmMulti } from './alert'
import { planCharxImport, type CharxDestination, type CharxImportPlan, type CharxStats } from './charxPreflight'

function formatCharxSize(bytes: number): string {
    // Decimal units, matching the 150 MB threshold.
    return bytes >= 1_000_000_000
        ? `${(bytes / 1_000_000_000).toFixed(2)} GB`
        : `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** The bot / module / cancel question for a large CHARX. Null is cancel. */
export async function askLargeCharxDestination(
    name: string,
    stats: CharxStats,
    preferred: CharxDestination,
): Promise<CharxDestination | null> {
    const text = language.largeCharxImport
    const choice = await alertConfirmMulti(
        text.title,
        [
            { label: text.asCharacter, variant: preferred === 'character' ? 'primary' : 'default' },
            { label: text.asModule, variant: preferred === 'module' ? 'primary' : 'default' },
        ],
        text.detail(name, formatCharxSize(stats.bytes), stats.assets),
    )
    return choice === 0 ? 'character' : choice === 1 ? 'module' : null
}

/**
 * planCharxImport with the real question. `preferred` is where the file was
 * headed (the bot importer or the module importer); it is highlighted, except
 * that a module export's own name ("*.module.charx") highlights the module.
 */
export function planLargeCharxImport(
    name: string,
    data: Uint8Array | Blob | ReadableStream<Uint8Array>,
    preferred: CharxDestination,
): Promise<CharxImportPlan> {
    const highlighted = name.toLowerCase().endsWith('.module.charx') ? 'module' : preferred
    return planCharxImport(name, data, (stats) => askLargeCharxDestination(name, stats, highlighted))
}
