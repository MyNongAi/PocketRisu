// The NovelAI choices of Settings › Other bots › Image generation
// (OtherBotSettings.svelte), for the 🎨 panel that shows and edits the same
// values (the user's request, 2026-10-26: one set of values, changed from
// either place). naiOptions.test.ts checks these lists against the settings
// page, so an upstream change there shows up.

export const NAI_MODELS = [
    'nai-diffusion-5-full',
    'nai-diffusion-5-curated',
    'nai-diffusion-4-5-full',
    'nai-diffusion-4-5-curated',
    'nai-diffusion-4-full',
    'nai-diffusion-4-curated-preview',
    'nai-diffusion-3',
    'nai-diffusion-furry-3',
    'nai-diffusion-2',
] as const

export interface NaiChoice {
    value: string
    label: string
}

const V4_UP_MODELS = new Set([
    'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview',
    'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated',
    'nai-diffusion-5-full', 'nai-diffusion-5-curated',
])

const V4_UP_SAMPLERS: NaiChoice[] = [
    { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
    { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
    { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
    { value: 'k_euler', label: 'Euler' },
    { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
    { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
]

const OLDER_SAMPLERS: NaiChoice[] = [
    { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
    { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
    { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
    { value: 'k_euler', label: 'Euler' },
    { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
    { value: 'k_dpmpp_2s', label: 'DPM++ 2S' },
    { value: 'ddim_v3', label: 'DDIM' },
]

export const NAI_NOISE_SCHEDULES = ['native', 'karras', 'exponential', 'polyexponential'] as const

/** The samplers the settings page offers for `model`. */
export function naiSamplers(model: string | undefined): NaiChoice[] {
    return V4_UP_MODELS.has(model ?? '') ? V4_UP_SAMPLERS : OLDER_SAMPLERS
}

/** Which switches the settings page shows for `model` and `sampler`. */
export function naiSwitches(model: string | undefined, sampler: string | undefined) {
    const m = model ?? ''
    const v3Family = m === 'nai-diffusion-3' || m === 'nai-diffusion-furry-3' || m === 'nai-diffusion-2'
    return {
        smea: v3Family && sampler !== 'ddim_v3',
        dyn: m === 'nai-diffusion-3' && sampler !== 'ddim_v3',
        variety: m === 'nai-diffusion-4-5-full' || m === 'nai-diffusion-4-5-curated'
            || m === 'nai-diffusion-4-full' || m === 'nai-diffusion-4-curated-preview'
            || m === 'nai-diffusion-3' || m === 'nai-diffusion-furry-3',
        decrisp: v3Family,
        legacyUc: m === 'nai-diffusion-4-full' || m === 'nai-diffusion-4-curated-preview',
    }
}

/** A model name short enough for the folded 🎨 NovelAI title: 'nai-diffusion-4-5-full' → 'V4.5 full'. */
export function naiModelShort(model: string | undefined): string {
    return (model ?? '')
        .replace(/^nai-diffusion-/, '')
        .replace(/^(\d+)-(\d+)(?=-|$)/, 'V$1.$2')
        .replace(/^(\d+)(?=-|$)/, 'V$1')
        .replaceAll('-', ' ')
}

/** A model a preset's `model:` line names: an id from NAI_MODELS or its short name ("V4.5 full"); else undefined. */
export function naiModelFrom(value: string | undefined): string | undefined {
    const wanted = (value ?? '').trim().toLowerCase()
    if (!wanted) return undefined
    return NAI_MODELS.find((model) => model === wanted || naiModelShort(model).toLowerCase() === wanted)
}

/**
 * The model an image's Source text names ("NovelAI Diffusion V4.5 …"). Sure
 * only when Full or Curated is written there; a bare version is a guess at
 * Full (the user's question, 2026-10-28, whether NovelAI's own import sets
 * the model).
 */
export function naiModelFromSource(source: string | undefined): { model: string, sure: boolean } | undefined {
    const match = /NovelAI Diffusion V(\d+)(?:\.(\d+))?/i.exec(source ?? '')
    if (!match) return undefined
    const version = match[2] ? `${match[1]}-${match[2]}` : match[1]
    const curated = /curated/i.test(source ?? ''), full = /full/i.test(source ?? '')
    const model = curated
        ? NAI_MODELS.find((m) => m.startsWith(`nai-diffusion-${version}-curated`))
        : NAI_MODELS.find((m) => m === `nai-diffusion-${version}-full`)
    return model ? { model, sure: curated || full } : undefined
}
