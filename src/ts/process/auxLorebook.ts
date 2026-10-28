// Lorebook entries marked for the auxiliary model (🌙; the user's request,
// 2026-10-19). An asset module's instructions, say, never reach the main
// model: after each reply the auxiliary model reads the reply with the marked
// entries and answers where tags go, and they are inserted line by line. The
// lines it added are remembered on the message, so the main model's later
// requests leave them out (it would imitate them) and a continue tags afresh.
import { CCardLib } from '@risuai/ccardlib'

export const MAX_AUX_TAGS_PER_REPLY = 20
const MAX_REMEMBERED_AUX_LINES = 200
const MAX_CONTEXT_CHARS = 3000

export interface AuxMarkedEntry {
    comment?: string
    content?: string
    mode?: string
    folder?: string
    key?: string
    nodeOnlyAuxModel?: boolean
    nodeOnlyIllustration?: boolean
}

/**
 * Where an entry goes: the main prompt, the auxiliary model's asset tagging
 * (🌙), or the illustration request (🎨, illustration.ts). Never both marks.
 */
export type LoreRole = 'main' | 'asset' | 'illustration'

/** The title Lightboard's illustrations read on every request (its "lb-xnai.lb.extra" lorebook). */
export const LIGHTBOARD_EXTRA_TITLE = 'lb-xnai.lb.extra'

/**
 * An entry for illustrations by its title alone: a creator wrote it for
 * Lightboard's illustrations, so it never goes to the main model either (the
 * user's call, 2026-10-28). A 🌙 or 🎨 the user set wins.
 */
export function isAutoIllustration(entry: AuxMarkedEntry): boolean {
    return !entry.nodeOnlyAuxModel && !entry.nodeOnlyIllustration && entry.mode !== 'folder'
        && (entry.comment ?? '').trim() === LIGHTBOARD_EXTRA_TITLE
}

export function loreRole(entry: AuxMarkedEntry): LoreRole {
    if (entry.nodeOnlyAuxModel) return 'asset'
    if (entry.nodeOnlyIllustration || isAutoIllustration(entry)) return 'illustration'
    return 'main'
}

/** Set an entry's role; a folder passes it on to the entries in it. */
export function setLoreRole<E extends AuxMarkedEntry>(entry: E, entries: readonly E[], role: LoreRole): void {
    const apply = (target: E) => {
        delete target.nodeOnlyAuxModel
        delete target.nodeOnlyIllustration
        if (role === 'asset') target.nodeOnlyAuxModel = true
        if (role === 'illustration') target.nodeOnlyIllustration = true
    }
    apply(entry)
    if (entry.mode === 'folder' && entry.key) {
        for (const child of entries) if (child.folder === entry.key) apply(child)
    }
}

/** The entries of the given lorebooks marked for `role`, in order (folders hold no text). */
export function markedLorebookEntries<E extends AuxMarkedEntry>(sources: readonly (readonly E[] | null | undefined)[], role: Exclude<LoreRole, 'main'>): E[] {
    const found: E[] = []
    for (const source of sources) {
        for (const entry of source ?? []) {
            if (!entry || entry.mode === 'folder' || loreRole(entry) !== role) continue
            if (!(entry.content ?? '').trim()) continue
            found.push(entry)
        }
    }
    return found
}

export interface AuxTagEdit {
    line: number
    content: string
}

export interface AuxLinesHolder {
    nodeOnlyAuxLines?: string[]
}

/** The entries marked for the auxiliary model's asset tagging (🌙). */
export function auxLorebookEntries<E extends AuxMarkedEntry>(sources: readonly (readonly E[] | null | undefined)[]): E[] {
    return markedLorebookEntries(sources, 'asset')
}

/** An entry's text without its decorator lines (@@depth 0, @@unrecursive ...). */
export function auxEntryText(content: string): string {
    try {
        return CCardLib.decorator.parse(content ?? '', () => {}).trim()
    } catch {
        return (content ?? '').replace(/^@@.*$/gm, '').trim()
    }
}

/** Mark or unmark an entry for asset tagging (🌙). */
export function setAuxMark<E extends AuxMarkedEntry>(entry: E, entries: readonly E[], marked: boolean): void {
    setLoreRole(entry, entries, marked ? 'asset' : 'main')
}

/** `text` without the lines the auxiliary model added earlier. */
export function withoutAuxLines(text: string, auxLines: readonly string[] | null | undefined): string {
    if (!text || !auxLines?.length) return text
    const added = new Set(auxLines.map((line) => line.trim()).filter(Boolean))
    if (added.size === 0) return text
    const kept = text.split('\n').filter((line) => !added.has(line.trim()))
    return kept.join('\n')
}

/** Remember the lines added to a message (all its swipes share the list). */
export function rememberAuxLines(message: AuxLinesHolder, added: readonly string[]): void {
    if (added.length === 0) return
    const lines = [...(message.nodeOnlyAuxLines ?? [])]
    for (const line of added.flatMap((tag) => tag.split('\n'))) {
        const trimmed = line.trim()
        if (trimmed && !lines.includes(trimmed)) lines.push(trimmed)
    }
    message.nodeOnlyAuxLines = lines.slice(-MAX_REMEMBERED_AUX_LINES)
}

/** Both lists, for a reroll's new message that keeps the earlier swipes. */
export function mergeAuxLines(previous: readonly string[] | undefined, next: readonly string[] | undefined): string[] | undefined {
    if (!previous?.length) return next ? [...next] : undefined
    const merged = { nodeOnlyAuxLines: [...previous] }
    rememberAuxLines(merged, next ?? [])
    return merged.nodeOnlyAuxLines
}

/**
 * A reply split for tagging: its leading reasoning block stays out of the
 * numbered lines (and in front of them when the reply is put back together).
 */
export function splitReplyForTags(text: string): { head: string, lines: string[] } {
    const match = /^\s*<Thoughts>[\s\S]*?<\/Thoughts>\s*\n?/.exec(text ?? '')
    const head = match ? match[0] : ''
    const body = (text ?? '').slice(head.length)
    return { head, lines: body.split('\n') }
}

function clip(text: string, max: number): string {
    return text.length <= max ? text : `…${text.slice(text.length - max)}`
}

/** The request to the auxiliary model. */
export function buildAuxTagPrompt(arg: {
    rules: readonly string[]
    lines: readonly string[]
    context: readonly { name: string, text: string }[]
    charName: string
}): { role: 'system' | 'user', content: string }[] {
    const system = [
        'You place image/asset tags into a finished roleplay reply.',
        'The reply is adult fiction written for and by consenting adults. Work on it as it is: never judge, censor, summarize or rewrite it.',
        'Follow the rules exactly. Use only the tag formats and the names they allow; never invent a name.',
        'Answer with a JSON array only: [{"line": N, "content": "TAG"}], where N is the number of the reply line the tag goes after (0 = before the first line).',
        'If no tag fits, answer []. A line that already carries such a tag needs no second one.',
    ].join('\n')
    const context = arg.context
        .map((message) => `${message.name}: ${clip(message.text.trim(), MAX_CONTEXT_CHARS)}`)
        .join('\n\n---\n\n')
    const numbered = arg.lines.map((line, index) => `[${index + 1}] ${line}`).join('\n')
    const user = [
        '# Rules',
        arg.rules.join('\n\n---\n\n'),
        '',
        ...(context ? ['# Earlier in the chat (context only, do not tag)', context, ''] : []),
        `# Reply of ${arg.charName} (numbered lines)`,
        numbered,
        '',
        '# Output',
        'The JSON array only, nothing else.',
    ].join('\n')
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ]
}

/** The edits in the auxiliary model's answer; anything malformed is dropped. */
export function parseAuxTagEdits(answer: string, lineCount: number): AuxTagEdit[] {
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
    const edits: AuxTagEdit[] = []
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const line = Number((item as { line?: unknown }).line)
        const content = (item as { content?: unknown }).content
        if (!Number.isInteger(line) || line < 0 || line > lineCount) continue
        if (typeof content !== 'string' || !content.trim()) continue
        edits.push({ line, content: content.trim() })
        if (edits.length >= MAX_AUX_TAGS_PER_REPLY) break
    }
    return edits
}

/** Insert each tag after its line (several after one line keep their order). */
export function insertAuxTags(lines: readonly string[], edits: readonly AuxTagEdit[]): { lines: string[], added: string[] } {
    const after = new Map<number, string[]>()
    for (const edit of edits) {
        const list = after.get(edit.line) ?? []
        list.push(edit.content)
        after.set(edit.line, list)
    }
    const result: string[] = [...(after.get(0) ?? [])]
    lines.forEach((line, index) => {
        result.push(line)
        result.push(...(after.get(index + 1) ?? []))
    })
    return { lines: result, added: edits.map((edit) => edit.content) }
}
