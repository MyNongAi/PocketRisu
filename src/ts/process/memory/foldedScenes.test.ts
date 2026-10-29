import { describe, expect, test } from 'vitest'
import type { OpenAIChat } from '../index.svelte'
import type { Chat } from '../../storage/database.svelte'
import { foldScenes, foldScenesForMemory, scenesOf } from './foldedScenes'

// Messages as the 장면 접기 module leaves them: marks in the text, the summary
// in the chat variable setState wrote (JSON).
function chatOf(texts: string[], state: Record<string, string> = {}): Chat {
    return {
        message: texts.map((data, i) => ({ role: i % 2 ? 'char' : 'user', data, chatId: `m${i + 1}` })),
        scriptstate: state,
    } as unknown as Chat
}

function requestOf(chat: Chat): OpenAIChat[] {
    return chat.message.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.data, memo: m.chatId }))
}

const summary = { '$__sf_sum_ab12cd34': JSON.stringify('피카츄가 이브이를 이겼다.') }

describe('foldScenes', () => {
    test('a folded scene reaches memory as one summary message where it began', () => {
        const chat = chatOf(['hi', 'battle! <!--sf:s:battle:ab12cd34-->', 'hit <!--sf:m:ab12cd34-->', 'won <!--sf:e:ab12cd34-->', 'after'], summary)
        const folded = foldScenes(requestOf(chat), chat, new Set())

        expect(folded?.chats.map((c) => c.memo)).toEqual(['m1', 'sf:ab12cd34', 'm5'])
        expect(folded?.chats[1]).toMatchObject({ role: 'system' })
        expect(folded?.chats[1].content).toContain('[Folded scene · battle]')
        expect(folded?.chats[1].content).toContain('피카츄가 이브이를 이겼다.')
        expect(folded?.removed.map((c) => c.memo)).toEqual(['m2', 'm3', 'm4'])
    })

    test('a scene without a summary, or still open, stays as it is', () => {
        const unsummarized = chatOf(['a <!--sf:s:battle:ab12cd34-->', 'b <!--sf:e:ab12cd34-->'])
        expect(foldScenes(requestOf(unsummarized), unsummarized, new Set())).toBeNull()

        const open = chatOf(['a <!--sf:s:battle:ab12cd34-->', 'b'], summary)
        expect(foldScenes(requestOf(open), open, new Set())).toBeNull()
    })

    test('a message that also starts the next scene stays', () => {
        const chat = chatOf(['a <!--sf:s:battle:ab12cd34-->', 'b <!--sf:e:ab12cd34-->\n<!--sf:s:nsfw:99ff0011-->', 'c'], summary)
        const folded = foldScenes(requestOf(chat), chat, new Set())

        expect(folded?.chats.map((c) => c.memo)).toEqual(['sf:ab12cd34', 'm2', 'm3'])
        expect(scenesOf(chat).memberOf.get('m2')).toEqual(['ab12cd34', '99ff0011'])
    })

    test('a scene memory already summarized in part keeps its messages', () => {
        const chat = chatOf(['a <!--sf:s:battle:ab12cd34-->', 'b <!--sf:m:ab12cd34-->', 'c <!--sf:e:ab12cd34-->'], summary)
        expect(foldScenes(requestOf(chat), chat, new Set(['m2']))).toBeNull()
        // The summary message itself, summarized before, still folds.
        expect(foldScenes(requestOf(chat), chat, new Set(['sf:ab12cd34']))).not.toBeNull()
    })
})

describe('foldScenesForMemory', () => {
    test('counts the summary instead of the scene', async () => {
        const chat = chatOf(['x'.repeat(10), 'y'.repeat(500) + '<!--sf:s:battle:ab12cd34-->', 'z'.repeat(500) + '<!--sf:e:ab12cd34-->'], summary)
        const request = requestOf(chat)
        const length = async (message: OpenAIChat) => message.content.length
        const total = (await Promise.all(request.map(length))).reduce((a, b) => a + b, 0)

        const result = await foldScenesForMemory(request, total, chat, length)

        expect(result.chats).toHaveLength(2)
        expect(result.currentTokens).toBe(10 + result.chats[1].content.length)
    })

    test('a chat with nothing folded comes back as it was', async () => {
        const chat = chatOf(['a', 'b'])
        const request = requestOf(chat)
        const result = await foldScenesForMemory(request, 42, chat, async () => 1)
        expect(result).toEqual({ chats: request, currentTokens: 42 })
    })
})
