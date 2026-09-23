// Post-processing for a reply that finished on the server while no page was
// attached to it (see jobRecovery.ts).
//
// A live generation runs these steps itself once the reply is in. A reply that
// completed in the background used to land as the raw model text: no output
// regex, no Lua output trigger, no image generated from the character's
// image-generation prompt. This applies the same steps, in the same order as
// the live streaming path in index.svelte.ts, to the recovered message.
//
// Left out on purpose: TTS (nobody may be listening), emotion selection and
// auto-continue (both start new model requests), and a trigger's request to
// send another prompt.

import { getDatabase, normalizeChat, type Chat, type character } from 'src/ts/storage/database.svelte'
import { risuChatParser } from 'src/ts/parser/parser.svelte'
import { trimUntilPunctuation } from 'src/ts/util'
import { processScriptFull } from '../scripts'
import { runTrigger } from '../triggers'
import { runInlayScreen } from '../inlayScreen'
import { captureModuleRuntimeContext } from '../modules'

export interface RecoveryTarget {
    char: character
    chat: Chat
}

/** Whether a recovered message already went through post-processing. */
export function isPostProcessed(message: { generationInfo?: { postProcessed?: boolean } } | undefined): boolean {
    return message?.generationInfo?.postProcessed === true
}

/**
 * Run the live output pipeline on one recovered message, identified by its
 * message-level chatId. Returns the chat object that now holds it, which is a
 * new one when the output trigger replaced the chat.
 */
export async function postProcessRecoveredMessage(target: RecoveryTarget, messageId: string): Promise<Chat> {
    const { char } = target
    let chat = target.chat
    const indexOf = () => chat.message.findIndex((message) => message?.chatId === messageId)
    let index = indexOf()
    if (index < 0 || isPostProcessed(chat.message[index])) return chat

    const captured = captureModuleRuntimeContext(char, chat)
    const context = () => ({ ...captured, character: char, chat })

    // 1. Output regex and editOutput scripts.
    const edited = await processScriptFull(char, (chat.message[index].data ?? '').trim(), 'editoutput', index, {}, context())
    let text = edited.data
    if (getDatabase()?.removeIncompleteResponse) text = trimUntilPunctuation(text)
    chat.message[index].data = text

    // 2. Variables in the chat ({{setvar}} and friends), as the live path does
    //    before the output trigger.
    chat.message = chat.message.map((message) => {
        message.data = risuChatParser(message.data, {
            chara: char,
            chat,
            runVar: true,
            userName: captured.userName,
            personaPrompt: captured.personaPrompt,
            modules: captured.modules,
        })
        return message
    })

    // 3. Output trigger (Lua and trigger scripts). It may hand back a new chat.
    const triggerResult = await runTrigger(char, 'output', {
        chat,
        targetCharacter: char,
        targetChat: chat,
        moduleContext: context(),
    })
    if (triggerResult?.chat) {
        const slot = char.chats.findIndex((candidate) => candidate?.id === chat.id)
        if (slot >= 0) {
            char.chats[slot] = normalizeChat(triggerResult.chat)
            // Re-read through the reactive proxy rather than keep the raw object.
            chat = char.chats[slot]
        }
    }

    // 4. Images from the character's image-generation prompt (<ImgGen="...">).
    index = indexOf()
    if (index >= 0) {
        const inlay = runInlayScreen(char, chat.message[index].data)
        chat.message[index].data = inlay.text
        if (inlay.promise) {
            const withImages = await inlay.promise
            index = indexOf()
            if (index >= 0) chat.message[index].data = withImages
        }
    }

    index = indexOf()
    if (index >= 0) {
        chat.message[index].generationInfo = { ...(chat.message[index].generationInfo ?? {}), postProcessed: true }
    }
    char.reloadKeys = (char.reloadKeys ?? 0) + 1
    return chat
}
