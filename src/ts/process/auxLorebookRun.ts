// After a reply: the auxiliary model places tags by the lorebook entries
// marked for it (🌙, auxLorebook.ts).
import type { Chat, Message, character } from '../storage/database.svelte'
import { risuChatParser } from '../parser/parser.svelte'
import { notifyError } from '../alert'
import { language } from '../../lang'
import { getModuleLorebooks, type ModuleRuntimeContext } from './modules'
import { requestChatData } from './request/request'
import { collectStreamingText } from './request/shared'
import {
    auxEntryText,
    auxLorebookEntries,
    buildAuxTagPrompt,
    insertAuxTags,
    parseAuxTagEdits,
    rememberAuxLines,
    splitReplyForTags,
    withoutAuxLines,
} from './auxLorebook'

const CONTEXT_MESSAGES = 2

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
 * Tag the newest reply of `chat`, when any lorebook in use marks entries for
 * the auxiliary model. `currentChat` is asked again after the request: the
 * chat may have been replaced meanwhile, and a reply changed since is left.
 */
export async function tagReplyByAuxLorebook(arg: {
    character: character
    chat: Chat
    currentChat: () => Chat | null
    moduleContext: ModuleRuntimeContext
    userName: string
    signal: AbortSignal
}): Promise<boolean> {
    const entries = auxLorebookEntries([arg.character.globalLore, arg.chat.localLore, getModuleLorebooks(arg.moduleContext)])
    if (entries.length === 0) return false
    const rules = entries
        .map((entry) => risuChatParser(auxEntryText(entry.content), { chara: arg.character }).trim())
        .filter(Boolean)
    if (rules.length === 0) return false

    const found = newestReply(arg.chat.message ?? [])
    if (!found) return false
    const original = found.reply.data ?? ''
    const { head, lines } = splitReplyForTags(withoutAuxLines(original, found.reply.nodeOnlyAuxLines))
    if (!lines.some((line) => line.trim())) return false
    const context = found.before
        .filter((message) => !message.isComment && !message.disabled)
        .slice(-CONTEXT_MESSAGES)
        .map((message) => ({
            name: message.role === 'user' ? arg.userName : arg.character.name,
            text: withoutAuxLines(message.data ?? '', message.nodeOnlyAuxLines),
        }))

    const response = await requestChatData({
        formated: buildAuxTagPrompt({ rules, lines, context, charName: arg.character.name }),
        bias: {},
        useStreaming: false,
        noMultiGen: true,
        currentChar: arg.character,
        currentChat: arg.chat,
        moduleContext: arg.moduleContext,
    }, 'otherAx', arg.signal)
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
    if (edits.length === 0) return false
    const chat = arg.currentChat()
    const target = chat ? newestReply(chat.message ?? []) : null
    if (!target || target.reply.chatId !== found.reply.chatId || target.reply.data !== original) return false
    const tagged = insertAuxTags(lines, edits)
    target.reply.data = head + tagged.lines.join('\n')
    rememberAuxLines(target.reply, tagged.added)
    return true
}
