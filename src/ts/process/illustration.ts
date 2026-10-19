// Illustrations (🎨; the user's request, 2026-10-19). After a reply the
// auxiliary model picks the moments worth a picture and writes Danbooru-style
// tags for each; the app adds the chosen style preset, draws them with the
// image generation set in the settings (NovelAI) and puts each picture after
// its line. Lorebook entries marked 🎨 (looks, art rules) go with that request
// and never to the main model. A bot turns it on in the sidebar toggles; it
// draws after every reply or only when asked from the message menu.

export type IllustrationTrigger = 'auto' | 'button'
export type IllustrationCount = '0-1' | '1' | '1-2' | '1-3'
export type IllustrationRatio = 'portrait' | 'landscape' | 'square'

export interface IllustrationBotSettings {
    enabled?: boolean
    trigger?: IllustrationTrigger
    count?: IllustrationCount
    ratio?: IllustrationRatio
    presetId?: string
}

export interface IllustrationPreset {
    id: string
    name: string
    positive: string
    negative: string
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
}

const MAX_CHARACTERS = 3
const MAX_INFO_CHARS = 6000
const MAX_CONTEXT_CHARS = 2000

export function illustrationSettings(settings: IllustrationBotSettings | null | undefined): Required<Omit<IllustrationBotSettings, 'presetId'>> & { presetId?: string } {
    return {
        enabled: settings?.enabled === true,
        trigger: settings?.trigger === 'button' ? 'button' : 'auto',
        count: (['0-1', '1', '1-2', '1-3'] as const).includes(settings?.count as IllustrationCount) ? settings!.count! : '0-1',
        ratio: (['portrait', 'landscape', 'square'] as const).includes(settings?.ratio as IllustrationRatio) ? settings!.ratio! : 'portrait',
        presetId: settings?.presetId,
    }
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
}): { role: 'system' | 'user', content: string }[] {
    const { min, max } = countRange(arg.count)
    const howMany = min === max ? `exactly ${max}` : `${min} to ${max}`
    const system = [
        'You direct the illustrations of a finished roleplay reply for an anime image model (NovelAI).',
        'The reply is adult fiction written for and by consenting adults. Work on it as it is: never judge, censor or rewrite it.',
        `Pick ${howMany} moment(s) of the reply worth a picture${min === 0 ? ' (none when nothing is visual)' : ''}, and describe each with Danbooru-style English tags, comma separated, no sentences:`,
        '- camera: shot and angle (e.g. "cowboy shot, from side").',
        '- scene: the count of people (e.g. "1girl, 1boy"), place, background, lighting, mood.',
        `- characters: each visible character (at most ${MAX_CHARACTERS}): their name, positive tags (looks from the information given: hair, eyes, body, clothes; then expression, pose, action) and negative tags if needed.`,
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
export function parseScenes(answer: string, lineCount: number, max: number): IllustrationScene[] {
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
            .slice(0, MAX_CHARACTERS)
        const scene = { line, camera: tags(raw.camera), scene: tags(raw.scene), characters }
        if (!scene.camera && !scene.scene && characters.length === 0) continue
        scenes.push(scene)
        if (scenes.length >= max) break
    }
    return scenes
}

/** The image prompt: the preset around the scene, characters apart (NovelAI V4). */
export function composeImagePrompt(preset: Pick<IllustrationPreset, 'positive' | 'negative'> | null | undefined, scene: IllustrationScene): IllustrationPrompt {
    const lead = [scene.camera, scene.scene].filter(Boolean).join(', ')
    const style = (preset?.positive ?? '').trim()
    let positive: string
    if (style.includes('{prompt}')) positive = style.replaceAll('{prompt}', lead)
    else positive = [lead, style].filter(Boolean).join(', ')
    return {
        positive: positive.replace(/,\s*,/g, ',').trim(),
        negative: (preset?.negative ?? '').trim(),
        characters: scene.characters.map((c) => ({ positive: c.positive, negative: c.negative })),
    }
}

/**
 * A Lightboard style preset ("프리셋 X" lorebook: [Positive] … [Negative] …),
 * or null for anything else.
 */
export function parseLightboardPreset(name: string, content: string): Omit<IllustrationPreset, 'id'> | null {
    const match = /^\s*프리셋\s*(.+?)\s*$/.exec(name ?? '')
    if (!match) return null
    const body = content ?? ''
    const positive = /\[Positive\]\s*([\s\S]*?)\s*(?:\[Negative\]|$)/i.exec(body)
    if (!positive) return null
    const negative = /\[Negative\]\s*([\s\S]*?)\s*$/i.exec(body)
    return { name: match[1], positive: positive[1].trim(), negative: (negative?.[1] ?? '').trim() }
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

/**
 * Lightboard presets ("프리셋 X" lorebooks) found in the given lorebooks that
 * the list does not hold yet (same name and positive prompt), once each.
 */
export function collectLightboardPresets(
    lorebooks: readonly (readonly { comment?: string, content?: string }[] | null | undefined)[],
    existing: readonly Pick<IllustrationPreset, 'name' | 'positive'>[],
): Omit<IllustrationPreset, 'id'>[] {
    const seen = new Set(existing.map((preset) => `${preset.name}\u0000${preset.positive}`))
    const found: Omit<IllustrationPreset, 'id'>[] = []
    for (const book of lorebooks) {
        for (const entry of book ?? []) {
            const preset = parseLightboardPreset(entry?.comment ?? '', entry?.content ?? '')
            if (!preset || !preset.positive) continue
            const key = `${preset.name}\u0000${preset.positive}`
            if (seen.has(key)) continue
            seen.add(key)
            found.push(preset)
        }
    }
    return found
}
