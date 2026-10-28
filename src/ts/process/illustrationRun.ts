// Drawing the illustrations of a reply (illustration.ts). Runs after the reply
// is done, in the background: the chat can go on meanwhile. Each picture is
// first a "drawing…" line, then the picture; a reply edited, deleted or
// rerolled in between simply loses the lines it no longer has.
import { get, writable } from 'svelte/store'
import type { Chat, Message, character, loreBook } from '../storage/database.svelte'
import { DBState } from '../stores.svelte'
import { risuChatParser } from '../parser/parser.svelte'
import { notifyError, notifyInfo } from '../alert'
import { language } from '../../lang'
import { captureModuleRuntimeContext, getModuleLorebooks, getModules, type ModuleRuntimeContext, type RisuModule } from './modules'
import { loadLoreBookV3Prompt } from './lorebook.svelte'
import { requestChatData } from './request/request'
import { collectStreamingText } from './request/shared'
import { generateAIImage } from './stableDiff'
import { writeInlayImage } from './files/inlays'
import { auxEntryText, loreRole, markedLorebookEntries, rememberAuxLines, splitReplyForTags, withoutAuxLines } from './auxLorebook'
import { rekeyRequestMark } from '../inputVersions'
import { v4 } from 'uuid'
import {
    ensureIllustrationModule, folderIllustrationPresetsOnce, illustrationModuleOf, presetFolderKey,
    presetLorebookFolder, restoreIllustrationPresetsOnce,
} from './illustrationModule'
import {
    buildScenePrompt,
    composeImagePrompt,
    countRange,
    drawingLine,
    illustrationSettings,
    inlayLine,
    insertSceneLines,
    lorebookPresets,
    parsePresetEntry,
    parseScenes,
    placeScenes,
    PRESET_NAI_HINT,
    presetNaiText,
    ratioSize,
    replaceReplyLine,
    replaceReplyText,
    sceneLoreEntries,
    setNaiLine,
    withPresetNai,
    type IllustrationPreset,
    type NaiParams,
    type PresetPlace,
    type PresetSections,
} from './illustration'

/**
 * The lorebook entries the last messages name, as the scene's information
 * (⚙ "로어북: 최근 메시지에서 걸린 것만", the default; 2026-10-28): a side
 * character's looks reach the auxiliary model without a 🎨 mark, and the
 * rest of the active lorebook stays home. 🎨 and 🌙 entries go their own way.
 */
function sceneLore(character: character, chat: Chat, moduleContext: ModuleRuntimeContext | undefined, reply: string, parse: (text: string) => string): string[] {
    const entries = [character.globalLore, chat.localLore, getModuleLorebooks(moduleContext)]
        .flatMap((source) => source ?? [])
        .filter((entry) => !!entry && loreRole(entry) === 'main')
    return sceneLoreEntries(entries, reply, character.loreSettings?.fullWordMatching ?? false)
        .map((entry) => parse(auxEntryText(entry.content)))
        .filter(Boolean)
}

/**
 * Every lorebook entry on for this chat now, as the main model gets it
 * (⚙ "로어북: 메인 모델처럼 전부", Lightboard's loadLoreBooks). 🎨 and 🌙
 * entries are never among them. Nothing when the lorebook cannot be read.
 */
async function activeLore(
    character: character, chat: Chat, moduleContext: ModuleRuntimeContext | undefined, parse: (text: string) => string,
): Promise<string[]> {
    const context = moduleContext?.character === character && moduleContext?.chat === chat
        ? moduleContext
        : captureModuleRuntimeContext(character, chat)
    try {
        return (await loadLoreBookV3Prompt(context)).actives.map((book) => parse(book.prompt)).filter(Boolean)
    } catch (error) {
        console.warn('[illustration] lorebook not read', error)
        return []
    }
}

/** Replies being illustrated, by message id (one pass at a time per reply). */
export const illustratingReplies = writable<ReadonlySet<string>>(new Set())

function setIllustrating(messageId: string, on: boolean) {
    illustratingReplies.update((current) => {
        const next = new Set(current)
        if (on) next.add(messageId)
        else next.delete(messageId)
        return next
    })
}

/** The reply and its chat, found again by id (the chat can change meanwhile). */
function findReply(chaId: string, chatId: string, messageId: string): { character: character, chat: Chat, message: Message, index: number } | null {
    const char = DBState.db.characters.find((c) => c?.chaId === chaId)
    const chat = char?.chats?.find((c) => c?.id === chatId)
    const index = chat?.message?.findIndex((m) => m?.chatId === messageId) ?? -1
    if (!char || !chat || index < 0) return null
    return { character: char as character, chat, message: chat.message[index], index }
}

function illustrationModuleMake() {
    return { id: v4, name: language.illustrationModuleName, description: language.illustrationModuleDescription, now: Date.now() }
}

/**
 * The old app-wide presets into the 🎨 module, and its one-entry presets
 * into folders, the first time anything needs them.
 */
export function restoreIllustrationPresets(): void {
    restoreIllustrationPresetsOnce(DBState.db, illustrationModuleMake())
    folderIllustrationPresetsOnce(DBState.db, illustrationModuleMake())
}

/** The 🎨 module to write a preset into, made when there is none. */
export function writableIllustrationModule(): RisuModule {
    return ensureIllustrationModule(DBState.db, illustrationModuleMake())
}

/** A new "프리셋 X" folder's entries, its key made here. */
export function newPresetFolder(name: string, sections: PresetSections): loreBook[] {
    return presetLorebookFolder(name, sections, presetFolderKey(v4()))
}

/** The lorebook a preset was read from, and how to put a changed one back. */
function presetLorebook(place: PresetPlace, character: character, chat: Chat | null | undefined): { entries: loreBook[], write: (next: loreBook[]) => void } | null {
    if (place.target.kind === 'bot') return { entries: character.globalLore ?? [], write: (next) => { character.globalLore = next } }
    if (place.target.kind === 'chat') return chat ? { entries: chat.localLore ?? [], write: (next) => { chat.localLore = next } } : null
    const id = place.target.id
    const module = DBState.db.modules.find((m) => m?.id === id)
    return module ? { entries: module.lorebook ?? [], write: (next) => { module.lorebook = next } } : null
}

/**
 * One NovelAI value into a preset's [NAI]: the sidebar's NovelAI fields while
 * a preset is picked (the user's request, 2026-10-28). A folder gets an NAI
 * entry when it has none; undefined takes the value out. False when the
 * preset could not be found where it was read.
 */
export function setPresetNai<K extends keyof NaiParams>(
    preset: IllustrationPreset, character: character, chat: Chat | null | undefined, key: K, value: NaiParams[K] | undefined,
): boolean {
    const place = preset.place
    const book = place ? presetLorebook(place, character, chat) : null
    if (!place || !book) return false
    const entries = book.entries
    if (place.folder !== undefined) {
        const nai = entries.find((e) => e?.folder === place.folder && e.mode !== 'folder' && /^(nai|settings)$/i.test((e.comment ?? '').trim()))
        if (nai) {
            book.write(entries.map((e) => (e === nai ? { ...e, content: setNaiLine(e.content ?? '', key, value) } : e)))
            return true
        }
        if (!entries.some((e) => e?.mode === 'folder' && e.key === place.folder)) return false
        const last = entries.reduce((at, e, i) => (e?.key === place.folder || e?.folder === place.folder ? i : at), -1)
        const added: loreBook = {
            key: '', secondkey: '', insertorder: 100, comment: 'NAI', content: setNaiLine(PRESET_NAI_HINT, key, value),
            mode: 'normal', alwaysActive: false, selective: false, folder: place.folder,
        }
        book.write([...entries.slice(0, last + 1), added, ...entries.slice(last + 1)])
        return true
    }
    const entry = place.index !== undefined ? entries[place.index] : undefined
    if (!entry || parsePresetEntry(entry.comment ?? '', entry.content ?? '')?.name !== preset.name) return false
    const content = withPresetNai(entry.content ?? '', setNaiLine(presetNaiText(entry.content ?? ''), key, value))
    book.write(entries.map((e) => (e === entry ? { ...entry, content } : e)))
    return true
}

/** The 🎨 module when it is not on for this bot (so not among `modules` already). */
function illustrationModuleBesides(modules: readonly RisuModule[]): RisuModule | undefined {
    const own = illustrationModuleOf(DBState.db)
    return own && !modules.some((module) => module.id === own.id) ? own : undefined
}

/** The style presets a bot can use: its own lorebook, the chat's, each module's on, then the 🎨 module's, on or off. */
export function presetsFor(character: character, chat: Chat | null | undefined, moduleContext?: ModuleRuntimeContext) {
    const modules = getModules(moduleContext).filter(Boolean)
    const own = illustrationModuleBesides(modules)
    return lorebookPresets([
        { label: '봇', entries: character.globalLore, target: { kind: 'bot' } },
        { label: '채팅', entries: chat?.localLore, target: { kind: 'chat' } },
        ...modules.map((module) => ({ label: module.name, entries: module.lorebook, target: { kind: 'module', id: module.id } as const })),
        ...(own ? [{ label: own.name, entries: own.lorebook, target: { kind: 'module', id: own.id } as const }] : []),
    ])
}

/** Change a reply's text wherever it shows (its swipe too); its request mark follows. */
function changeReply(message: Message, before: string, after: string): boolean {
    if (!replaceReplyText(message, before, after)) return false
    rekeyRequestMark(message, before, after)
    return true
}

function changeLine(message: Message, line: string, next: string | null): boolean {
    const before = message.data
    if (!replaceReplyLine(message, line, next)) return false
    if (message.data !== before) rekeyRequestMark(message, before, message.data)
    return true
}

/** Take out the pictures drawn into a reply before (to draw it again). */
export function removeIllustrations(message: Message): void {
    for (const id of Object.keys(message.nodeOnlyIllustrations ?? {})) {
        while (changeLine(message, inlayLine(id), null)) { /* every copy of the line */ }
    }
    delete message.nodeOnlyIllustrations
}

/**
 * Draw the illustrations of one reply. `manual`: asked from the message menu
 * (says so when there is nothing to draw).
 */
export async function illustrateReply(arg: {
    chaId: string
    chatId: string
    messageId: string
    moduleContext?: ModuleRuntimeContext
    manual?: boolean
}): Promise<number> {
    if (get(illustratingReplies).has(arg.messageId)) return 0
    const found = findReply(arg.chaId, arg.chatId, arg.messageId)
    if (!found || found.message.role !== 'char') return 0
    const settings = illustrationSettings(found.character.nodeOnlyIllustration)
    if (DBState.db.sdProvider === '') {
        if (arg.manual) notifyError(language.illustrationNoImageProvider)
        return 0
    }
    setIllustrating(arg.messageId, true)
    const placed: string[] = []
    try {
        const { character, chat, message } = found
        const parse = (text: string) => risuChatParser(text ?? '', { chara: character }).trim()
        restoreIllustrationPresets()
        // The 🎨 module's own 🎨 entries (art rules for every bot) go too, on or off.
        const own = illustrationModuleBesides(getModules(arg.moduleContext).filter(Boolean))
        const books = [character.globalLore, chat.localLore, getModuleLorebooks(arg.moduleContext)]
        // 🎨 entries, Lightboard's "lb-xnai.lb.extra" ones among them (by title,
        // auxLorebook.ts): bots made for it keep their characters' looks there.
        const rules = [...new Set(markedLorebookEntries([...books, own?.lorebook], 'illustration')
            .map((entry) => parse(auxEntryText(entry.content))).filter(Boolean))]
        const original = message.data ?? ''
        const { head, lines } = splitReplyForTags(original)
        if (!lines.some((line) => line.trim())) return 0
        const earlier = chat.message.slice(0, found.index).filter((m) => !m.isComment && !m.disabled)
        const context = (settings.contextCount > 0 ? earlier.slice(-settings.contextCount) : [])
            .map((m) => ({
                name: m.role === 'user' ? (arg.moduleContext?.userName ?? DBState.db.username ?? 'User') : character.name,
                text: withoutAuxLines(m.data ?? '', m.nodeOnlyAuxLines),
            }))
        const lore = (settings.lore === 'all'
            ? await activeLore(character, chat, arg.moduleContext, parse)
            : sceneLore(character, chat, arg.moduleContext, [...context.map((m) => m.text), lines.join('\n')].join('\n'), parse))
            .filter((text) => !rules.includes(text))
        const response = await requestChatData({
            formated: buildScenePrompt({
                lines,
                rules,
                lore,
                context,
                character: { name: character.name, description: parse(character.desc ?? '') },
                user: { name: arg.moduleContext?.userName ?? DBState.db.username ?? 'User', description: parse(arg.moduleContext?.personaPrompt ?? '') },
                count: settings.count,
                position: settings.position,
                maxCharacters: settings.maxCharacters,
                nsfw: settings.nsfw,
                direction: settings.direction,
                commonNote: parse(DBState.db.nodeOnlyIllustrationNote ?? ''),
            }),
            bias: {},
            useStreaming: false,
            noMultiGen: true,
            currentChar: character,
            currentChat: chat,
            moduleContext: arg.moduleContext,
        }, 'otherAx')
        let answer = ''
        if (response.type === 'fail') {
            notifyError(`${language.illustrationFailed}: ${response.result}`)
            return 0
        }
        if (response.type === 'streaming') answer = await collectStreamingText(response.result)
        else if (response.type === 'multiline') answer = response.result.map(([, text]) => text).join('\n')
        else answer = response.result

        const scenes = placeScenes(parseScenes(answer, lines.length, countRange(settings.count).max, settings.maxCharacters), settings.position, lines.length)
        if (scenes.length === 0) {
            if (arg.manual) notifyInfo(language.illustrationNothing)
            return 0
        }

        // "Drawing…" lines first, where the pictures go.
        const now = findReply(arg.chaId, arg.chatId, arg.messageId)
        if (!now) return 0
        const tag = arg.messageId.slice(0, 4)
        const drawing = scenes.map((_, index) => drawingLine(`${tag}${index + 1}`))
        const withLines = head + insertSceneLines(lines, scenes, (index) => drawing[index]).join('\n')
        if (!changeReply(now.message, original, withLines)) return 0
        placed.push(...drawing)
        rememberAuxLines(now.message, drawing)

        const preset = settings.preset ? presetsFor(character, chat, arg.moduleContext).find((p) => p.name === settings.preset) : undefined
        const size = ratioSize(settings.ratio)
        let drawn = 0
        for (let index = 0; index < scenes.length; index++) {
            const prompt = composeImagePrompt(preset, scenes[index])
            const image = await generateAIImage(prompt.positive, character, prompt.negative, 'inlay', { ...size, characters: prompt.characters, ...(prompt.nai ? { nai: prompt.nai } : {}) })
            const target = findReply(arg.chaId, arg.chatId, arg.messageId)
            if (!target) break
            if (!image) {
                changeLine(target.message, drawing[index], null)
                continue
            }
            const img = new Image()
            img.src = image
            const inlayId = await writeInlayImage(img)
            const after = findReply(arg.chaId, arg.chatId, arg.messageId)
            if (!after || !changeLine(after.message, drawing[index], inlayLine(inlayId))) continue
            rememberAuxLines(after.message, [inlayLine(inlayId)])
            after.message.nodeOnlyIllustrations = { ...(after.message.nodeOnlyIllustrations ?? {}), [inlayId]: prompt }
            drawn++
        }
        return drawn
    } catch (error) {
        console.error(error)
        notifyError(`${language.illustrationFailed}: ${error}`)
        return 0
    } finally {
        // A "drawing…" line never stays behind.
        const left = findReply(arg.chaId, arg.chatId, arg.messageId)
        if (left) for (const line of placed) changeLine(left.message, line, null)
        setIllustrating(arg.messageId, false)
    }
}

/** After a reply: draw when the bot draws on its own and the reply has no pictures yet. */
export function startAutoIllustration(arg: { character: character, chat: Chat, moduleContext?: ModuleRuntimeContext }): void {
    const settings = illustrationSettings(arg.character.nodeOnlyIllustration)
    if (!settings.enabled || settings.trigger !== 'auto') return
    const messages = arg.chat.message ?? []
    let reply: Message | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.isComment) continue
        if (messages[i]?.role === 'char') reply = messages[i]
        break
    }
    if (!reply?.chatId || Object.keys(reply.nodeOnlyIllustrations ?? {}).length > 0) return
    void illustrateReply({ chaId: arg.character.chaId, chatId: arg.chat.id, messageId: reply.chatId, moduleContext: arg.moduleContext })
}
