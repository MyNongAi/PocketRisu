// Drawing the illustrations of a reply (illustration.ts). Runs after the reply
// is done, in the background: the chat can go on meanwhile. Each picture is
// first a "drawing…" line, then the picture; a reply edited, deleted or
// rerolled in between simply loses the lines it no longer has.
import { get, writable } from 'svelte/store'
import type { Chat, Message, character } from '../storage/database.svelte'
import { DBState } from '../stores.svelte'
import { risuChatParser } from '../parser/parser.svelte'
import { notifyError, notifyInfo } from '../alert'
import { language } from '../../lang'
import { getModuleLorebooks, getModules, type ModuleRuntimeContext } from './modules'
import { requestChatData } from './request/request'
import { collectStreamingText } from './request/shared'
import { generateAIImage } from './stableDiff'
import { writeInlayImage } from './files/inlays'
import { auxEntryText, markedLorebookEntries, rememberAuxLines, splitReplyForTags, withoutAuxLines } from './auxLorebook'
import { rekeyRequestMark } from '../inputVersions'
import {
    buildScenePrompt,
    composeImagePrompt,
    countRange,
    drawingLine,
    illustrationSettings,
    inlayLine,
    insertSceneLines,
    lorebookPresets,
    parseScenes,
    placeScenes,
    ratioSize,
    replaceReplyLine,
    replaceReplyText,
} from './illustration'

const CONTEXT_MESSAGES = 2

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

/** The style presets a bot can use: its own lorebook, the chat's, then each module's on. */
export function presetsFor(character: character, chat: Chat | null | undefined, moduleContext?: ModuleRuntimeContext) {
    return lorebookPresets([
        { label: '봇', entries: character.globalLore },
        { label: '채팅', entries: chat?.localLore },
        ...getModules(moduleContext).filter(Boolean).map((module) => ({ label: module.name, entries: module.lorebook })),
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
        const rules = markedLorebookEntries([character.globalLore, chat.localLore, getModuleLorebooks(arg.moduleContext)], 'illustration')
            .map((entry) => parse(auxEntryText(entry.content)))
            .filter(Boolean)
        const original = message.data ?? ''
        const { head, lines } = splitReplyForTags(original)
        if (!lines.some((line) => line.trim())) return 0
        const context = chat.message.slice(0, found.index)
            .filter((m) => !m.isComment && !m.disabled)
            .slice(-CONTEXT_MESSAGES)
            .map((m) => ({
                name: m.role === 'user' ? (arg.moduleContext?.userName ?? DBState.db.username ?? 'User') : character.name,
                text: withoutAuxLines(m.data ?? '', m.nodeOnlyAuxLines),
            }))
        const response = await requestChatData({
            formated: buildScenePrompt({
                lines,
                rules,
                context,
                character: { name: character.name, description: parse(character.desc ?? '') },
                user: { name: arg.moduleContext?.userName ?? DBState.db.username ?? 'User', description: parse(arg.moduleContext?.personaPrompt ?? '') },
                count: settings.count,
                position: settings.position,
                maxCharacters: settings.maxCharacters,
                nsfw: settings.nsfw,
                direction: settings.direction,
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
