import type { RegistryUiSchema } from './types'

/** Reasoning controls first, followed by request-tier controls from the profile UI. */
export function quickSettingKeys(uiSchema: RegistryUiSchema): string[] {
    const fields = (uiSchema.fields ?? []).filter(Boolean)
    const byOrder = (a: typeof fields[number], b: typeof fields[number]) => (a.order ?? 999) - (b.order ?? 999)
    const reasoning = fields.filter(field => field.group === 'reasoning' && field.visibility !== 'hidden').sort(byOrder)
    const tiers = fields.filter(field =>
        field.visibility !== 'hidden' && /^(sharedRequestType|service_?tier)$/i.test(field.key),
    ).sort(byOrder)
    return [...new Set([...reasoning, ...tiers].map(field => field.key))]
}
