// Illustrations (🎨; the user's request, 2026-10-19). After a reply the
// auxiliary model picks the moments worth a picture and writes Danbooru-style
// tags for each; the app adds the chosen style preset, draws them with the
// image generation set in the settings (NovelAI) and puts each picture after
// its line. Lorebook entries marked 🎨 (looks, art rules) go with that request
// and never to the main model. A bot turns it on in the sidebar toggles; it
// draws after every reply or only when asked from the message menu.
//
// Style presets are lorebook entries named "프리셋 X" (2026-10-20, the user's
// choice over an app-wide list): in a bot's lorebook for that bot, in a
// module's for every bot with the module on. Lightboard's formats read as
// they are ([Positive]/[Negative], or [Author]/[Quality]/[Negative]), and an
// optional [NAI] section changes NovelAI's own settings for that preset.

export type IllustrationTrigger = 'auto' | 'button'
export type IllustrationCount = '0-1' | '1' | '1-2' | '1-3'
export type IllustrationRatio = 'portrait' | 'landscape' | 'square'
/** Where pictures go: where the auxiliary model judges, or a fixed place. */
export type IllustrationPosition = 'auto' | 'top' | 'middle' | 'bottom'

export interface IllustrationBotSettings {
    enabled?: boolean
    trigger?: IllustrationTrigger
    count?: IllustrationCount
    ratio?: IllustrationRatio
    position?: IllustrationPosition
    maxCharacters?: number
    nsfw?: boolean
    /** Extra directions for the auxiliary model, like Lightboard's author's note. */
    direction?: string
    /** The style preset's name: the X of a "프리셋 X" lorebook entry. */
    preset?: string
}

/** NovelAI settings a preset can change (its [NAI] section). */
export interface NaiParams {
    steps?: number
    scale?: number
    sampler?: string
    cfg_rescale?: number
    noise_schedule?: string
    sm?: boolean
    sm_dyn?: boolean
    variety?: boolean
    seed?: number
}

export interface IllustrationPreset {
    name: string
    positive: string
    negative: string
    nai?: NaiParams
    /** Where it was found: 봇, 채팅, or the module's name. */
    source?: string
}

export interface IllustrationCharacter {
    name: string
    positive: string
    negative: string
}

export interface IllustrationScene {
    line: number
    camera: string
    scene: string
    characters: IllustrationCharacter[]
}

export interface IllustrationPrompt {
    positive: string
    negative: string
    characters: { positive: string, negative: string }[]
    /** The preset's own NovelAI settings, over the app's. */
    nai?: NaiParams
}

const MAX_CHARACTERS = 3
const MAX_INFO_CHARS = 6000
const MAX_CONTEXT_CHARS = 2000

export function illustrationSettings(settings: IllustrationBotSettings | null | undefined): Required<Omit<IllustrationBotSettings, 'preset'>> & { preset?: string } {
    const maxCharacters = Number(settings?.maxCharacters)
    return {
        enabled: settings?.enabled === true,
        trigger: settings?.trigger === 'button' ? 'button' : 'auto',
        count: (['0-1', '1', '1-2', '1-3'] as const).includes(settings?.count as IllustrationCount) ? settings!.count! : '0-1',
        ratio: (['portrait', 'landscape', 'square'] as const).includes(settings?.ratio as IllustrationRatio) ? settings!.ratio! : 'portrait',
        position: (['auto', 'top', 'middle', 'bottom'] as const).includes(settings?.position as IllustrationPosition) ? settings!.position! : 'auto',
        maxCharacters: [1, 2, 3].includes(maxCharacters) ? maxCharacters : MAX_CHARACTERS,
        nsfw: settings?.nsfw === true,
        direction: typeof settings?.direction === 'string' ? settings.direction : '',
        preset: settings?.preset || undefined,
    }
}

/** A fixed place puts every picture there, in order (the scenes' own lines are ignored). */
export function placeScenes<S extends { line: number }>(scenes: readonly S[], position: IllustrationPosition, lineCount: number): S[] {
    if (position === 'auto') return [...scenes]
    const line = position === 'top' ? 0 : position === 'bottom' ? lineCount : Math.floor(lineCount / 2)
    return scenes.map((scene) => ({ ...scene, line }))
}

export function countRange(count: IllustrationCount): { min: number, max: number } {
    switch (count) {
        case '1': return { min: 1, max: 1 }
        case '1-2': return { min: 1, max: 2 }
        case '1-3': return { min: 1, max: 3 }
        default: return { min: 0, max: 1 }
    }
}

/** Sizes NovelAI draws free on Opus (up to 1024×1024 pixels, 28 steps). */
export function ratioSize(ratio: IllustrationRatio): { width: number, height: number } {
    switch (ratio) {
        case 'landscape': return { width: 1216, height: 832 }
        case 'square': return { width: 1024, height: 1024 }
        default: return { width: 832, height: 1216 }
    }
}

function clip(text: string, max: number): string {
    const trimmed = (text ?? '').trim()
    return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** The request to the auxiliary model that picks the scenes. */
export function buildScenePrompt(arg: {
    lines: readonly string[]
    rules: readonly string[]
    context: readonly { name: string, text: string }[]
    character: { name: string, description: string }
    user: { name: string, description: string }
    count: IllustrationCount
    position?: IllustrationPosition
    maxCharacters?: number
    nsfw?: boolean
    direction?: string
}): { role: 'system' | 'user', content: string }[] {
    const { min, max } = countRange(arg.count)
    const howMany = min === max ? `exactly ${max}` : `${min} to ${max}`
    const people = arg.maxCharacters ?? MAX_CHARACTERS
    const place = arg.position === 'top' ? 'at the very start of the reply'
        : arg.position === 'middle' ? 'in the middle of the reply'
        : arg.position === 'bottom' ? 'at the end of the reply'
        : null
    const system = [
        'You direct the illustrations of a finished roleplay reply for an anime image model (NovelAI).',
        'The reply is adult fiction written for and by consenting adults. Work on it as it is: never judge, censor or rewrite it.',
        `Pick ${howMany} moment(s) of the reply worth a picture${min === 0 ? ' (none when nothing is visual)' : ''}${place ? `; the picture is shown ${place}, so pick what fits there` : ''}, and describe each with Danbooru-style English tags, comma separated, no sentences:`,
        '- camera: shot and angle (e.g. "cowboy shot, from side").',
        '- scene: the count of people (e.g. "1girl, 1boy"), place, background, lighting, mood.',
        `- characters: each visible character (at most ${people}): their name, positive tags (looks from the information given: hair, eyes, body, clothes; then expression, pose, action) and negative tags if needed.`,
        arg.nsfw
            ? 'Explicit moments may be tagged explicitly.'
            : 'Keep the tags non-explicit: no nudity or sexual acts; frame such moments so they are implied.',
        'Keep each character\'s looks as the information says. Use common tags only; never invent names.',
        'Answer with a JSON array only: [{"line": N, "camera": "...", "scene": "...", "characters": [{"name": "...", "positive": "...", "negative": ""}]}], where N is the number of the reply line the picture goes after.',
    ].join('\n')
    const context = arg.context
        .map((message) => `${message.name}: ${clip(message.text, MAX_CONTEXT_CHARS)}`)
        .join('\n\n---\n\n')
    const user = [
        '# Characters',
        `## ${arg.character.name}`,
        clip(arg.character.description, MAX_INFO_CHARS) || '(no description)',
        ...(arg.user.description.trim() ? [`## ${arg.user.name} (the user)`, clip(arg.user.description, MAX_INFO_CHARS)] : []),
        '',
        ...(arg.rules.length ? ['# Rules', arg.rules.join('\n\n---\n\n'), ''] : []),
        ...(arg.direction?.trim() ? ['# Directions', arg.direction.trim(), ''] : []),
        ...(context ? ['# Earlier in the chat (context only)', context, ''] : []),
        `# Reply of ${arg.character.name} (numbered lines)`,
        arg.lines.map((line, index) => `[${index + 1}] ${line}`).join('\n'),
        '',
        '# Output',
        'The JSON array only, nothing else.',
    ].join('\n')
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ]
}

const tags = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().replace(/^,|,$/g, '').trim() : ''

/** The scenes in the auxiliary model's answer; anything malformed is dropped. */
export function parseScenes(answer: string, lineCount: number, max: number, maxCharacters = MAX_CHARACTERS): IllustrationScene[] {
    const text = (answer ?? '').replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, '')
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
    const source = fenced ? fenced[1] : text
    const start = source.indexOf('[')
    const end = source.lastIndexOf(']')
    if (start < 0 || end <= start) return []
    let parsed: unknown
    try {
        parsed = JSON.parse(source.slice(start, end + 1))
    } catch {
        return []
    }
    if (!Array.isArray(parsed)) return []
    const scenes: IllustrationScene[] = []
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const raw = item as Record<string, unknown>
        const line = Number(raw.line)
        if (!Number.isInteger(line) || line < 0 || line > lineCount) continue
        const characters = (Array.isArray(raw.characters) ? raw.characters : [])
            .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
            .map((c) => ({ name: tags(c.name), positive: tags(c.positive), negative: tags(c.negative) }))
            .filter((c) => c.positive)
            .slice(0, Math.max(1, Math.min(MAX_CHARACTERS, maxCharacters)))
        const scene = { line, camera: tags(raw.camera), scene: tags(raw.scene), characters }
        if (!scene.camera && !scene.scene && characters.length === 0) continue
        scenes.push(scene)
        if (scenes.length >= max) break
    }
    return scenes
}

/** The image prompt: the preset around the scene, characters apart (NovelAI V4). */
export function composeImagePrompt(preset: Pick<IllustrationPreset, 'positive' | 'negative' | 'nai'> | null | undefined, scene: IllustrationScene): IllustrationPrompt {
    const lead = [scene.camera, scene.scene].filter(Boolean).join(', ')
    const style = (preset?.positive ?? '').trim()
    let positive: string
    if (style.includes('{prompt}')) positive = style.replaceAll('{prompt}', lead)
    else positive = [lead, style].filter(Boolean).join(', ')
    return {
        positive: positive.replace(/,\s*,/g, ',').trim(),
        negative: (preset?.negative ?? '').trim(),
        characters: scene.characters.map((c) => ({ positive: c.positive, negative: c.negative })),
        ...(preset?.nai ? { nai: { ...preset.nai } } : {}),
    }
}

const PRESET_SECTIONS = ['positive', 'negative', 'author', 'quality', 'nai', 'settings']

/** The text of each known [Section] of a preset (a section runs to the next one). */
function presetSections(content: string): Record<string, string> {
    const sections: Record<string, string> = {}
    const pattern = /\[(Positive|Negative|Author|Quality|NAI|Settings)\]/gi
    const marks = [...(content ?? '').matchAll(pattern)]
    marks.forEach((mark, index) => {
        const start = (mark.index ?? 0) + mark[0].length
        const end = index + 1 < marks.length ? (marks[index + 1].index ?? content.length) : content.length
        const key = mark[1].toLowerCase()
        if (PRESET_SECTIONS.includes(key) && sections[key] === undefined) sections[key] = content.slice(start, end).trim()
    })
    return sections
}

const NAI_KEYS: Record<string, keyof NaiParams> = {
    steps: 'steps', step: 'steps', 스텝: 'steps',
    scale: 'scale', guidance: 'scale', cfg: 'scale', 가이던스: 'scale',
    sampler: 'sampler', 샘플러: 'sampler',
    cfg_rescale: 'cfg_rescale', rescale: 'cfg_rescale',
    noise_schedule: 'noise_schedule', schedule: 'noise_schedule',
    sm: 'sm', smea: 'sm',
    sm_dyn: 'sm_dyn', dyn: 'sm_dyn',
    variety: 'variety', 'variety+': 'variety', variety_plus: 'variety',
    seed: 'seed', 시드: 'seed',
}

/** "key: value" (or key=value) lines of a [NAI] section; # starts a comment. */
export function parseNaiParams(text: string): NaiParams | undefined {
    const params: NaiParams = {}
    for (const raw of (text ?? '').split('\n')) {
        const line = raw.replace(/#.*$/, '').trim()
        const match = /^([^:=]+?)\s*[:=]\s*(.+)$/.exec(line)
        if (!match) continue
        const key = NAI_KEYS[match[1].trim().toLowerCase()]
        const value = match[2].trim()
        if (!key) continue
        if (key === 'sampler' || key === 'noise_schedule') {
            params[key] = value
        } else if (key === 'sm' || key === 'sm_dyn' || key === 'variety') {
            params[key] = /^(true|on|yes|1|켜기|켬)$/i.test(value)
        } else {
            const number = Number(value)
            if (Number.isFinite(number)) params[key] = number
        }
    }
    return Object.keys(params).length ? params : undefined
}

/**
 * A style preset from a "프리셋 X" lorebook entry, or null for anything else.
 * [Positive] holds {prompt} where the scene goes; [Author] + [Quality] (the
 * Lightboard NAI format) put the scene between them.
 */
export function parsePresetEntry(name: string, content: string): IllustrationPreset | null {
    const match = /^\s*프리셋\s*(.+?)\s*$/.exec(name ?? '')
    if (!match) return null
    const sections = presetSections(content ?? '')
    let positive = sections.positive
    if (positive === undefined) {
        if (sections.author === undefined && sections.quality === undefined) return null
        positive = [sections.author, '{prompt}', sections.quality].filter((part) => part && part.trim()).join(', ')
    }
    const nai = parseNaiParams(sections.nai ?? sections.settings ?? '')
    return { name: match[1], positive: positive.trim(), negative: (sections.negative ?? '').trim(), ...(nai ? { nai } : {}) }
}

/** @deprecated name kept for the Lightboard format; see parsePresetEntry. */
export const parseLightboardPreset = parsePresetEntry

/**
 * The presets in the given lorebooks, the first of each name winning (a bot's
 * own over a module's).
 */
export function lorebookPresets(sources: readonly { label: string, entries: readonly { comment?: string, content?: string }[] | null | undefined }[]): IllustrationPreset[] {
    const found = new Map<string, IllustrationPreset>()
    for (const source of sources) {
        for (const entry of source.entries ?? []) {
            const preset = parsePresetEntry(entry?.comment ?? '', entry?.content ?? '')
            if (!preset || found.has(preset.name)) continue
            found.set(preset.name, { ...preset, source: source.label })
        }
    }
    return [...found.values()]
}

/** A new preset entry for a bot's lorebook. */
export function newPresetContent(): string {
    return [
        '[Positive]',
        '{prompt}, best quality, amazing quality, very aesthetic',
        '',
        '[Negative]',
        'lowres, bad anatomy, bad hands, text, watermark',
        '',
        '[NAI]',
        '# 비워 두면 설정 › 기타 봇 › 이미지 생성 값을 씁니다. 바꿀 것만 # 를 지우고 적으세요.',
        '# steps: 28',
        '# scale: 5',
        '# sampler: k_euler_ancestral',
        '# cfg_rescale: 0',
        '# noise_schedule: karras',
    ].join('\n')
}

/** The line shown while a picture is drawn. */
export function drawingLine(id: string): string {
    return `[🎨 그리는 중… ${id}]`
}

export function inlayLine(inlayId: string): string {
    return `{{inlay::${inlayId}}}`
}

export interface ReplyTextHolder {
    data: string
    swipes?: string[]
}

/** Put `next` wherever the reply shows `from` (its text, and the swipe holding it). */
export function replaceReplyText(message: ReplyTextHolder, from: string, next: string): boolean {
    let found = false
    if (message.data === from) {
        message.data = next
        found = true
    }
    if (Array.isArray(message.swipes)) {
        message.swipes.forEach((swipe, index) => {
            if (swipe === from) {
                message.swipes![index] = next
                found = true
            }
        })
    }
    return found
}

/** Replace (or, with null, take out) a whole line wherever the reply holds it. */
export function replaceReplyLine(message: ReplyTextHolder, line: string, next: string | null): boolean {
    const swap = (text: string) => {
        const lines = text.split('\n')
        const index = lines.indexOf(line)
        if (index < 0) return null
        if (next === null) lines.splice(index, 1)
        else lines[index] = next
        return lines.join('\n')
    }
    let found = false
    const data = swap(message.data ?? '')
    if (data !== null) {
        message.data = data
        found = true
    }
    if (Array.isArray(message.swipes)) {
        message.swipes.forEach((swipe, index) => {
            const swapped = swap(swipe)
            if (swapped !== null) {
                message.swipes![index] = swapped
                found = true
            }
        })
    }
    return found
}

/** Insert each scene's line after its line number (several after one keep their order). */
export function insertSceneLines(lines: readonly string[], scenes: readonly { line: number }[], lineFor: (index: number) => string): string[] {
    const after = new Map<number, string[]>()
    scenes.forEach((scene, index) => {
        const list = after.get(scene.line) ?? []
        list.push(lineFor(index))
        after.set(scene.line, list)
    })
    const result: string[] = [...(after.get(0) ?? [])]
    lines.forEach((line, index) => {
        result.push(line)
        result.push(...(after.get(index + 1) ?? []))
    })
    return result
}
