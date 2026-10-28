// After a reply: the auxiliary model places tags by the lorebook entries
// marked for it (🌙, auxLorebook.ts). The bot's ⚙ in the sidebar picks what
// goes along and which model answers (auxAssetSettings), and can give each
// reply's menu a 🌙 that tags it again (the user's choice, 2026-10-28).
import { get, writable } from 'svelte/store'
import type { Chat, Message, character } from '../storage/database.svelte'
import { DBState } from '../stores.svelte'
import { risuChatParser } from '../parser/parser.svelte'
import { notifyError, notifyInfo } from '../alert'
import { language } from '../../lang'
import { getModuleLorebooks, type ModuleRuntimeContext } from './modules'
import { requestChatData } from './request/request'
import { collectStreamingText } from './request/shared'
import { inlayLine, replaceReplyText } from './illustration'
import { rekeyRequestMark } from '../inputVersions'
import {
    auxAssetSettings,
    auxEntryText,
    auxLorebookEntries,
    buildAuxTagPrompt,
    insertAuxTags,
    parseAuxTagEdits,
    rememberAuxLines,
    splitReplyForTags,
    withoutAuxLines,
} from './auxLorebook'

/** The newest reply of a chat and the messages before it. */
export function newestReply(messages: readonly Message[]): { reply: Message, before: Message[] } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (!message || message.isComment) continue
        if (message.role !== 'char') return null
        return { reply: message, before: messages.slice(0, i) }
    }
    return null
}

/**
 * The lines a tagging pass takes out before tagging afresh: what the
 * auxiliary model added, never the pictures drawn into the reply (their
 * lines are remembered in the same list, illustrationRun.ts).
 */
export function earlierTagLines(message: Message): string[] {
    const pictures = new Set(Object.keys(message.nodeOnlyIllustrations ?? {}).map(inlayLine))
    return (message.nodeOnlyAuxLines ?? []).filter((line) => !pictures.has(line))
}

/**
 * Tag one reply. `again` finds the reply once the answer is in (the chat may
 * have been replaced meanwhile); a reply changed since is left.
 */
async function tagReply(arg: {
    character: character
    chat: Chat
    reply: Message
    before: readonly Message[]
    again: () => Message | null
    moduleContext: ModuleRuntimeContext
    userName: string
    signal: AbortSignal
    manual?: boolean
}): Promise<boolean> {
    const entries = auxLorebookEntries([arg.character.globalLore, arg.chat.localLore, getModuleLorebooks(arg.moduleContext)])
    const parse = (text: string) => risuChatParser(text ?? '', { chara: arg.character }).trim()
    const rules = entries.map((entry) => parse(auxEntryText(entry.content))).filter(Boolean)
    if (rules.length === 0) {
        if (arg.manual) notifyInfo(language.auxAssetNoRules)
        return false
    }
    const settings = auxAssetSettings(arg.character.nodeOnlyAuxAsset)

    const original = arg.reply.data ?? ''
    const { head, lines } = splitReplyForTags(withoutAuxLines(original, earlierTagLines(arg.reply)))
    if (!lines.some((line) => line.trim())) return false
    const context = arg.before
        .filter((message) => !message.isComment && !message.disabled && !(settings.skipUser && message.role === 'user'))
        .slice(-settings.contextCount)
        .map((message) => ({
            name: message.role === 'user' ? arg.userName : arg.character.name,
            text: withoutAuxLines(message.data ?? '', message.nodeOnlyAuxLines),
        }))

    const response = await requestChatData({
        formated: buildAuxTagPrompt({
            rules,
            lines,
            context,
            charName: arg.character.name,
            description: settings.description ? parse(arg.character.desc ?? '') : undefined,
            persona: settings.persona ? { name: arg.userName, text: parse(arg.moduleContext?.personaPrompt ?? '') } : undefined,
        }),
        bias: {},
        useStreaming: false,
        noMultiGen: true,
        currentChar: arg.character,
        currentChat: arg.chat,
        moduleContext: arg.moduleContext,
    }, settings.mainModel ? 'model' : 'otherAx', arg.signal)
    if (arg.signal.aborted) return false
    let answer = ''
    if (response.type === 'fail') {
        notifyError(`${language.auxLorebookFailed}: ${response.result}`)
        return false
    }
    if (response.type === 'streaming') answer = await collectStreamingText(response.result)
    else if (response.type === 'multiline') answer = response.result.map(([, text]) => text).join('\n')
    else answer = response.result

    const edits = parseAuxTagEdits(answer, lines.length)
    if (edits.length === 0) {
        if (arg.manual) notifyInfo(language.auxAssetNothing)
        return false
    }
    const target = arg.again()
    if (!target || target.chatId !== arg.reply.chatId || target.data !== original) return false
    const tagged = insertAuxTags(lines, edits)
    const next = head + tagged.lines.join('\n')
    // The shown text and its swipe; the request mark follows the text.
    if (!replaceReplyText(target, original, next)) return false
    rekeyRequestMark(target, original, next)
    rememberAuxLines(target, tagged.added)
    return true
}

/**
 * Tag the newest reply of `chat`, when any lorebook in use marks entries for
 * the auxiliary model. `currentChat` is asked again after the request.
 */
export async function tagReplyByAuxLorebook(arg: {
    character: character
    chat: Chat
    currentChat: () => Chat | null
    moduleContext: ModuleRuntimeContext
    userName: string
    signal: AbortSignal
}): Promise<boolean> {
    // The bot's ⚙ can leave it to the reply menu's 🌙.
    if (!auxAssetSettings(arg.character.nodeOnlyAuxAsset).auto) return false
    const found = newestReply(arg.chat.message ?? [])
    if (!found) return false
    return tagReply({
        ...arg,
        reply: found.reply,
        before: found.before,
        again: () => {
            const chat = arg.currentChat()
            return chat ? newestReply(chat.message ?? [])?.reply ?? null : null
        },
    })
}

/** Replies being tagged again from their menu, by message id. */
export const auxRetagging = writable<ReadonlySet<string>>(new Set())

function setRetagging(messageId: string, on: boolean) {
    auxRetagging.update((current) => {
        const next = new Set(current)
        if (on) next.add(messageId)
        else next.delete(messageId)
        return next
    })
}

/** The reply and its chat, found again by id (the chat can change meanwhile). */
function findReply(chaId: string, chatId: string, messageId: string): { character: character, chat: Chat, index: number } | null {
    const char = DBState.db.characters.find((c) => c?.chaId === chaId)
    const chat = char?.chats?.find((c) => c?.id === chatId)
    const index = chat?.message?.findIndex((m) => m?.chatId === messageId) ?? -1
    if (!char || !chat || index < 0) return null
    return { character: char as character, chat, index }
}

/**
 * 🌙 in a reply's menu: its earlier tags out, then tagged afresh by the
 * marked entries (any reply, not only the newest).
 */
export async function retagReplyByAuxLorebook(arg: {
    chaId: string
    chatId: string
    messageId: string
    moduleContext: ModuleRuntimeContext
}): Promise<boolean> {
    if (get(auxRetagging).has(arg.messageId)) return false
    const found = findReply(arg.chaId, arg.chatId, arg.messageId)
    const reply = found?.chat.message[found.index]
    if (!found || !reply || reply.role !== 'char') return false
    setRetagging(arg.messageId, true)
    try {
        return await tagReply({
            character: found.character,
            chat: found.chat,
            reply,
            before: found.chat.message.slice(0, found.index),
            again: () => {
                const now = findReply(arg.chaId, arg.chatId, arg.messageId)
                return now ? now.chat.message[now.index] ?? null : null
            },
            moduleContext: arg.moduleContext,
            userName: arg.moduleContext?.userName ?? DBState.db.username ?? 'User',
            signal: new AbortController().signal,
            manual: true,
        })
    } catch (error) {
        console.error(error)
        notifyError(`${language.auxLorebookFailed}: ${error}`)
        return false
    } finally {
        setRetagging(arg.messageId, false)
    }
}
