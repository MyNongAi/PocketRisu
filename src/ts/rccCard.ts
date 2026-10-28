// Risu's own encrypted character card, rccv1 (upstream 5e3337027, 2024-02).
// Upstream later dropped the export but kept the import, so official web and
// local Risu and every PocketRisu still read it, while SillyTavern and other
// apps cannot. A card from here therefore imports only into Risu, and with a
// password only for whoever has it (the user's request, 2026-10-28).
//
// The format is fixed by that importer (characterCards.ts, `rcc||`): the PNG's
// card chunk holds `rcc||rccv1||<encrypted>||<sha-256 hex>||<meta>`. The JSON
// is AES-GCM encrypted by encryptBuffer with the password, or with the
// built-in key 'RISU_NONE' when there is none; meta says whether to ask.
import { encryptBuffer } from './util'

const NO_PASSWORD_KEY = 'RISU_NONE'

export interface RccCardMetaData {
    usePassword?: boolean
}

/**
 * What official Risu does with a card's license (CharConfig.svelte), for the
 * export dialog: `private` hides the bot's settings, so its export button too;
 * the share-alike and no-derivatives licenses hide only the export button;
 * the rest are a label.
 */
export type LicenseEffect = 'none' | 'label' | 'noExport' | 'private'

const NO_EXPORT_LICENSES = new Set(['CC BY-NC-SA 4.0', 'CC BY-SA 4.0', 'CC BY-ND 4.0', 'CC BY-NC-ND 4.0'])

export function licenseEffect(license: string | undefined): LicenseEffect {
    if (!license) return 'none'
    if (license === 'private') return 'private'
    return NO_EXPORT_LICENSES.has(license) ? 'noExport' : 'label'
}

export async function encodeRccCard(card: unknown, password = ''): Promise<string> {
    const encrypted = Buffer.from(await encryptBuffer(Buffer.from(JSON.stringify(card), 'utf-8'), password || NO_PASSWORD_KEY))
    // The importer checks this against hasher(), a SHA-256 hex digest.
    const hashed = Buffer.from(await crypto.subtle.digest('SHA-256', encrypted)).toString('hex')
    const meta: RccCardMetaData = password ? { usePassword: true } : {}
    return ['rcc', 'rccv1', encrypted.toString('base64'), hashed, Buffer.from(JSON.stringify(meta)).toString('base64')].join('||')
}
