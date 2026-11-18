import { parseLegacySlot } from '../preset/types'

export type BindingPickerTab = 'preset' | 'base' | 'plugin'

/** Select the slot picker's initial section from its stored value and live plugin models. */
export function bindingPickerTab(value: string, pluginModelIds: readonly string[]): BindingPickerTab {
    const legacy = parseLegacySlot(value)
    if (!legacy) return 'preset'
    return legacy.model && pluginModelIds.includes(legacy.model) ? 'plugin' : 'base'
}
