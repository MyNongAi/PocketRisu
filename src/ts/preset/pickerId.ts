// A model preset picked in the ordinary model picker (the "모델 프리셋" tab next
// to the built-in and plugin models) is stored in db.aiModel / db.subModel /
// db.seperateModels like any other model id, as `modelpreset:::<preset id>`.
// resolveChatModelBinding turns that id into the preset route, so a preset and
// a classic model sit side by side without switching the model mode.

import { VISION_CAPABLE_ADAPTER_KINDS, type ModelPreset, type RegistryTokenizer } from './types'

export const MODEL_PRESET_PREFIX = 'modelpreset:::'

export function modelPresetPickerId(presetId: string): string {
    return MODEL_PRESET_PREFIX + presetId
}

/** The preset id inside a picker value, or null for any other model id. */
export function modelPresetIdOf(modelId: string | null | undefined): string | null {
    return typeof modelId === 'string' && modelId.startsWith(MODEL_PRESET_PREFIX)
        ? modelId.slice(MODEL_PRESET_PREFIX.length)
        : null
}

/** Whether a preset can take images (mirrors presetSupportsVision). */
export function presetTakesImages(preset: ModelPreset): boolean {
    const kind = preset.profileSnapshot?.adapterKind
    const caps = preset.profileSnapshot?.capabilities
    return VISION_CAPABLE_ADAPTER_KINDS.includes(kind)
        && ((caps?.includes('vision') ?? false) || preset.imageInput === true)
}

/** The tokenizer a preset asks for, by registry name. */
export function presetTokenizerName(preset: ModelPreset | undefined): RegistryTokenizer | undefined {
    return preset?.tokenizerOverride ?? preset?.profileSnapshot?.recommendedTokenizer
}
