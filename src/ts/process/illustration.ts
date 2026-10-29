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
// Since 2026-10-28 (the user's choice) a preset is a lorebook folder named
// "프리셋 X" holding one entry per section (Positive, Negative, NAI); the
// one-entry form still reads. [NAI] may name the model too.
import { naiModelFrom } from './naiOptions'

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
    /**
     * Which lorebook goes along (the user's toggle, 2026-10-28): 'scene' the
     * entries whose keys the last messages name, 'all' every active entry
     * as the main model gets it (Lightboard's way).
     */
    lore?: IllustrationLore
    /** Earlier messages sent along and scanned for keys, 0–5. */
    contextCount?: number
}

export type IllustrationLore = 'scene' | 'all'

const MAX_CONTEXT_COUNT = 5
const DEFAULT_CONTEXT_COUNT = 2

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
    /** A model of NAI_MODELS, drawn with instead of the settings' one (2026-10-28). */
    model?: string
}

/** The lorebook a preset came from. */
export type PresetTarget = { kind: 'bot' } | { kind: 'chat' } | { kind: 'module', id: string }

/** Where a preset lives, to write its [NAI] back: a folder (by key) or one entry (by index). */
export interface PresetPlace {
    target: PresetTarget
    folder?: string
    index?: number
}

export interface IllustrationPreset {
    name: string
    positive: string
    negative: string
    nai?: NaiParams
    /** Where it was found: 봇, 채팅, or the module's name. */
    source?: string
    place?: PresetPlace
    /** The style the Asset Maid plugin keeps for the bot: read here, never written. */
    assetMaid?: true
}

/** A preset's three entries, as written into a folder. */
export interface PresetSections {
    positive: string
    negative: string
    nai: string
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
/** All the lorebook text sent; the lorebook's own token budget usually stops well before. */
const MAX_LORE_CHARS = 30000

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
        lore: settings?.lore === 'all' ? 'all' : 'scene',
        contextCount: Number.isInteger(settings?.contextCount) && settings!.contextCount! >= 0 && settings!.contextCount! <= MAX_CONTEXT_COUNT
            ? settings!.contextCount!
            : DEFAULT_CONTEXT_COUNT,
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

/** A lorebook entry as the scene matcher reads it. */
export interface SceneLoreEntry {
    key?: string
    secondkey?: string
    selective?: boolean
    useRegex?: boolean
    mode?: string
}

/** Whether one of the comma separated keys is in the text, as the lorebook matches. */
function keyIn(keys: string | undefined, text: string, regex: boolean, fullWord: boolean): boolean {
    const list = (keys ?? '').split(',').map((key) => key.trim()).filter(Boolean)
    if (regex) {
        return list.some((key) => {
            const parsed = key.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/)
            if (!parsed) return false
            try {
                return new RegExp(parsed[1], parsed[2].replace('g', '')).test(text)
            } catch {
                return false
            }
        })
    }
    const lower = text.toLocaleLowerCase().replace(/\{\{\/\/(.+?)\}\}/g, '').replace(/\{\{comment:(.+?)\}\}/g, '')
    const words = fullWord ? lower.split(' ') : null
    return list.some((key) => (words ? words.includes(key.toLocaleLowerCase()) : lower.includes(key.toLocaleLowerCase())))
}

/**
 * The lorebook entries the reply itself names (the user's choice,
 * 2026-10-28, over Lightboard's every active entry as too costly): a key of
 * the entry is in the reply, and a selective entry's second key too. Folders
 * and keyless entries never match; always-on entries only by their keys.
 */
export function sceneLoreEntries<E extends SceneLoreEntry>(
    entries: readonly (E | null | undefined)[], reply: string, fullWordMatching = false,
): E[] {
    return entries.filter((entry): entry is E => {
        if (!entry || entry.mode === 'folder') return false
        const regex = !!entry.useRegex
        if (!keyIn(entry.key, reply, regex, fullWordMatching)) return false
        return !(entry.selective && entry.secondkey?.trim()) || keyIn(entry.secondkey, reply, regex, fullWordMatching)
    })
}

/** Lorebook texts in order, as many whole ones as fit in `max` characters. */
function fitLore(texts: readonly string[], max: number): string[] {
    const kept: string[] = []
    let used = 0
    for (const text of texts) {
        const trimmed = (text ?? '').trim()
        if (!trimmed) continue
        if (used + trimmed.length > max) break
        kept.push(trimmed)
        used += trimmed.length
    }
    return kept
}

/**
 * The request to the auxiliary model that picks the scenes: the bot and the
 * persona, the lorebook entries the reply names (2026-10-28: a side
 * character's looks without a 🎨 mark), the last messages, and the 🎨
 * entries as rules.
 */
export function buildScenePrompt(arg: {
    lines: readonly string[]
    rules: readonly string[]
    /** The lorebook entries the reply names (sceneLoreEntries). */
    lore?: readonly string[]
    context: readonly { name: string, text: string }[]
    character: { name: string, description: string }
    user: { name: string, description: string }
    count: IllustrationCount
    position?: IllustrationPosition
    maxCharacters?: number
    nsfw?: boolean
    direction?: string
    /** The illustration author's note for every bot, before the bot's own. */
    commonNote?: string
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
        `- characters: each visible character (at most ${people}): their name, positive tags (looks from the information given, the lorebook included: hair, eyes, body, clothes; then expression, pose, action) and negative tags if needed.`,
        arg.nsfw
            ? 'Explicit moments may be tagged explicitly.'
            : 'Keep the tags non-explicit: no nudity or sexual acts; frame such moments so they are implied.',
        'Keep each character\'s looks as the information says. Use common tags only; never invent names.',
        'Answer with a JSON array only: [{"line": N, "camera": "...", "scene": "...", "characters": [{"name": "...", "positive": "...", "negative": ""}]}], where N is the number of the reply line the picture goes after.',
    ].join('\n')
    const context = arg.context
        .map((message) => `${message.name}: ${clip(message.text, MAX_CONTEXT_CHARS)}`)
        .join('\n\n---\n\n')
    const lore = fitLore(arg.lore ?? [], MAX_LORE_CHARS)
    // The common illustration author's note, then the bot's own (the user's choice, 2026-10-28).
    const directions = [arg.commonNote, arg.direction].map((note) => note?.trim() ?? '').filter(Boolean).join('\n\n')
    const user = [
        '# Characters',
        `## ${arg.character.name}`,
        clip(arg.character.description, MAX_INFO_CHARS) || '(no description)',
        ...(arg.user.description.trim() ? [`## ${arg.user.name} (the user)`, clip(arg.user.description, MAX_INFO_CHARS)] : []),
        '',
        ...(lore.length ? ['# Lorebook (world and character information)', lore.join('\n\n---\n\n'), ''] : []),
        ...(arg.rules.length ? ['# Rules', arg.rules.join('\n\n---\n\n'), ''] : []),
        ...(directions ? ['# Directions', directions, ''] : []),
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
    model: 'model', 모델: 'model',
}

/** The name each value is written under. */
const NAI_LINE_NAMES: Record<keyof NaiParams, string> = {
    steps: 'steps', scale: 'scale', sampler: 'sampler', cfg_rescale: 'cfg_rescale',
    noise_schedule: 'noise_schedule', sm: 'smea', sm_dyn: 'dyn', variety: 'variety',
    seed: 'seed', model: 'model',
}

/** The value a [NAI] line sets, commented out ("# steps: 28") or not. */
function naiLineKey(line: string, commented: boolean): keyof NaiParams | undefined {
    const body = commented ? line.replace(/^\s*#\s*/, '') : line.replace(/#.*$/, '')
    const match = /^\s*([^:=#]+?)\s*[:=]/.exec(body)
    return match ? NAI_KEYS[match[1].trim().toLowerCase()] : undefined
}

/**
 * The [NAI] text with one value set (undefined: taken out). Other lines and
 * comments stay; a commented template line ("# steps: 28") becomes the value.
 */
export function setNaiLine<K extends keyof NaiParams>(text: string, key: K, value: NaiParams[K] | undefined): string {
    const next = value === undefined ? null : `${NAI_LINE_NAMES[key]}: ${value}`
    const out: string[] = []
    let placed = false
    for (const line of (text ?? '').split('\n')) {
        if (!/^\s*#/.test(line) && naiLineKey(line, false) === key) {
            if (next && !placed) out.push(next)
            placed = true
            continue
        }
        out.push(line)
    }
    if (next && !placed) {
        const template = out.findIndex((line) => /^\s*#/.test(line) && naiLineKey(line, true) === key)
        if (template >= 0) {
            out[template] = next
        } else {
            while (out.length > 0 && !out[out.length - 1].trim()) out.pop()
            out.push(next)
        }
    }
    return out.join('\n')
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
        } else if (key === 'model') {
            const model = naiModelFrom(value)
            if (model) params.model = model
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

/** The [NAI] (or [Settings]) text of a one-entry preset. */
export function presetNaiText(content: string): string {
    const sections = presetSections(content ?? '')
    return sections.nai ?? sections.settings ?? ''
}

/** A one-entry preset with its [NAI] section replaced, or added at the end. */
export function withPresetNai(content: string, nai: string): string {
    const text = content ?? ''
    const marks = [...text.matchAll(/\[(Positive|Negative|Author|Quality|NAI|Settings)\]/gi)]
    const at = marks.findIndex((mark) => /^(nai|settings)$/i.test(mark[1]))
    if (at < 0) return `${text.replace(/\s+$/, '')}\n\n[NAI]\n${nai}`
    const start = (marks[at].index ?? 0) + marks[at][0].length
    const end = at + 1 < marks.length ? (marks[at + 1].index ?? text.length) : text.length
    return `${text.slice(0, start)}\n${nai}${end < text.length ? '\n\n' : ''}${text.slice(end)}`
}

export interface PresetLorebookEntry {
    comment?: string
    content?: string
    mode?: string
    key?: string
    folder?: string
    nodeOnlyPresetSync?: PresetSync
}

/** A folder's 전체 entry and section entries as they last agreed (presetSyncHash of each). */
export interface PresetSync {
    whole: string
    parts: string
}

/**
 * The entry of a "프리셋 X" folder holding the whole preset in one text, the
 * way styles are shared (the user's request, 2026-10-30).
 */
export const PRESET_WHOLE_ENTRY = '전체'

/** An entry a "프리셋 X" folder reads: 전체 or a section (Positive, Negative, NAI…). */
export function isPresetFolderPart(comment: string | undefined): boolean {
    const name = (comment ?? '').trim()
    return name === PRESET_WHOLE_ENTRY || PRESET_SECTIONS.includes(name.toLowerCase())
}

/** A folder's entries named for sections, as one preset text. */
export function presetPartsText(folderKey: string, entries: readonly (PresetLorebookEntry | null | undefined)[]): string {
    return entries
        .filter((entry) => !!entry && entry.folder === folderKey && entry.mode !== 'folder'
            && PRESET_SECTIONS.includes((entry.comment ?? '').trim().toLowerCase()))
        .map((entry) => `[${entry!.comment!.trim()}]\n${entry!.content ?? ''}`)
        .join('\n\n')
}

export function presetWholeEntry<E extends PresetLorebookEntry>(folderKey: string, entries: readonly (E | null | undefined)[]): E | undefined {
    return entries.find((entry): entry is E => !!entry && entry.folder === folderKey && entry.mode !== 'folder'
        && (entry.comment ?? '').trim() === PRESET_WHOLE_ENTRY)
}

/** A short fingerprint of a preset text (FNV-1a), to tell which side was edited. */
export function presetSyncHash(text: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16)
}

/** Whether a text has preset sections ([Positive], [Author]…), not tags alone. */
export function hasPresetSections(text: string): boolean {
    return /\[(Positive|Negative|Author|Quality|NAI|Settings)\]/i.test(text ?? '')
}

/**
 * Whether a folder's 전체 entry leads its sections: unless only the sections
 * were edited since the two last agreed. A side left empty never leads.
 */
export function presetWholeLeads(sync: PresetSync | undefined, whole: string, parts: string): boolean {
    if (!parts.trim()) return true
    if (!whole.trim()) return false
    const wholeEdited = !sync || presetSyncHash(whole) !== sync.whole
    const partsEdited = !sync || presetSyncHash(parts) !== sync.parts
    return !(partsEdited && !wholeEdited)
}

/** A "프리셋 X" folder as one preset text: its 전체 entry or its sections, whichever leads. */
export function presetFolderContent(folderKey: string, entries: readonly (PresetLorebookEntry | null | undefined)[]): string {
    const parts = presetPartsText(folderKey, entries)
    const whole = presetWholeEntry(folderKey, entries)?.content
    if (whole === undefined) return parts
    const folder = entries.find((entry) => entry?.mode === 'folder' && entry.key === folderKey)
    // Tags alone in 전체 are its Positive, which the sync wrote into the sections.
    return presetWholeLeads(folder?.nodeOnlyPresetSync, whole, parts) && hasPresetSections(whole) ? whole : parts
}

/** The lorebook entry the Asset Maid plugin keeps a bot's data in. */
export const ASSET_MAID_DATA_ENTRY = '__ASSET_MAID_DATA__'

const ASSET_MAID_NAI_KEYS: Record<string, keyof NaiParams> = {
    steps: 'steps', scale: 'scale', cfgRescale: 'cfg_rescale', sampler: 'sampler', noiseSchedule: 'noise_schedule',
    sm: 'sm', smea: 'sm', smDyn: 'sm_dyn', dyn: 'sm_dyn', variety: 'variety', seed: 'seed',
}

// Who is in the picture is the scene's to say: Asset Maid writes its style
// for one girl's portrait ("2::1girl ::"), which would pull every scene to one.
const COUNT_TAG = /^(\d+\+?(girl|boy|other)s?|solo|multiple (girls|boys|others))$/i

/** A prompt without its subject-count tags, plain or a whole weighted group. */
function withoutCountTags(prompt: string): string {
    return prompt.split(',').filter((part) => {
        const match = /^\s*(?:(-?[\d.]+)::)?\s*(.*?)\s*(::)?\s*$/.exec(part)
        return !match || !!match[1] !== !!match[3] || !COUNT_TAG.test(match[2])
    }).join(',').replace(/^\s*,\s*/, '').trim()
}

let lastAssetMaid: { content: string, preset: IllustrationPreset | null } | undefined

/**
 * The art style the Asset Maid plugin keeps in a bot's lorebook (its
 * __ASSET_MAID_DATA__ entry, "artistSelection"), as a preset: bots made for
 * it carry their style there, not as "프리셋 X" (YariPoké, the user's
 * request 2026-10-30). Read-only, it follows the plugin's data.
 */
export function assetMaidPreset(entry: PresetLorebookEntry): IllustrationPreset | null {
    if ((entry.comment ?? '').trim() !== ASSET_MAID_DATA_ENTRY) return null
    const content = entry.content ?? ''
    // The entry is large and the list is rebuilt on every settings change.
    if (lastAssetMaid?.content === content) return lastAssetMaid.preset
    let preset: IllustrationPreset | null = null
    try {
        const style = JSON.parse(content.slice(content.indexOf('{')))?.features?.artistSelection?.novelai
        if (style && typeof style.prompt === 'string' && style.prompt.trim()) {
            const nai: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(style.novelAIOverrides ?? {})) {
                const to = ASSET_MAID_NAI_KEYS[key]
                if (!to) continue
                if (to === 'sampler' || to === 'noise_schedule' ? typeof value === 'string' && value
                    : to === 'sm' || to === 'sm_dyn' || to === 'variety' ? typeof value === 'boolean'
                    : typeof value === 'number' && Number.isFinite(value)) nai[to] = value
            }
            preset = {
                name: `에셋메이드 ${String(style.title ?? '').trim() || '화풍'}`,
                positive: withoutCountTags(style.prompt),
                negative: String(style.negativePrompt ?? '').trim(),
                ...(Object.keys(nai).length ? { nai: nai as NaiParams } : {}),
                assetMaid: true,
            }
        }
    } catch {
        preset = null
    }
    lastAssetMaid = { content, preset }
    return preset
}

/**
 * The presets in the given lorebooks, the first of each name winning (a bot's
 * own over a module's): "프리셋 X" folders and one-entry presets, and the
 * style of the Asset Maid plugin's data.
 */
export function lorebookPresets(sources: readonly { label: string, entries: readonly (PresetLorebookEntry | null | undefined)[] | null | undefined, target?: PresetTarget }[]): IllustrationPreset[] {
    const found = new Map<string, IllustrationPreset>()
    for (const source of sources) {
        const entries = source.entries ?? []
        entries.forEach((entry, index) => {
            if (!entry) return
            const folder = entry.mode === 'folder' ? entry.key : undefined
            const preset = folder
                ? parsePresetEntry(entry.comment ?? '', presetFolderContent(folder, entries))
                : parsePresetEntry(entry.comment ?? '', entry.content ?? '')
            // no place: its values are the plugin's, not written back
            const assetMaid = preset || folder ? null : assetMaidPreset(entry)
            if (assetMaid && !found.has(assetMaid.name)) found.set(assetMaid.name, { ...assetMaid, source: source.label })
            if (!preset || found.has(preset.name)) return
            const place = source.target ? { target: source.target, ...(folder ? { folder } : { index }) } : undefined
            found.set(preset.name, { ...preset, source: source.label, ...(place ? { place } : {}) })
        })
    }
    return [...found.values()]
}

/** The first lines of a new NAI entry. */
export const PRESET_NAI_HINT = '# 비워 두면 설정 › 기타 봇 › 이미지 생성 값을 씁니다. 사이드탭 🎨 ⚙의 NovelAI 칸에서 이 프리셋을 고르고 바꾸면 여기에 적힙니다.'

/** A new preset's entries. */
export function newPresetSections(): PresetSections {
    return {
        positive: '{prompt}, best quality, amazing quality, very aesthetic',
        negative: 'lowres, bad anatomy, bad hands, text, watermark',
        nai: [
            PRESET_NAI_HINT,
            '# model: nai-diffusion-4-5-full',
            '# steps: 28',
            '# scale: 5',
            '# sampler: k_euler_ancestral',
            '# cfg_rescale: 0',
            '# noise_schedule: karras',
        ].join('\n'),
    }
}

/**
 * A one-entry preset's content as folder entries (2026-10-28): [Author] and
 * [Quality] become one Positive with {prompt} between them; text before the
 * first section (notes) goes to NAI as comments.
 */
export function presetSectionsOf(content: string): PresetSections | null {
    const preset = parsePresetEntry('프리셋 _', content)
    if (!preset) return null
    const firstMark = (content ?? '').search(/\[(Positive|Negative|Author|Quality|NAI|Settings)\]/i)
    const notes = (firstMark > 0 ? content.slice(0, firstMark) : '').split('\n')
        .map((line) => line.trim()).filter(Boolean)
        .map((line) => (line.startsWith('#') ? line : `# ${line}`))
    return {
        positive: preset.positive,
        negative: preset.negative,
        nai: [...notes, presetNaiText(content)].filter(Boolean).join('\n'),
    }
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
