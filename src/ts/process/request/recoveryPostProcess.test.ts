import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
const mocks = vi.hoisted(() => ({
    db: { removeIncompleteResponse: false } as any,
    triggerChat: null as any,
    inlayPromise: null as Promise<string> | null,
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
    normalizeChat: (chat: any) => ({ ...chat, normalized: true }),
}))
vi.mock('src/ts/util', () => ({ trimUntilPunctuation: (text: string) => text.replace(/[^.!?]*$/, '') }))
vi.mock('src/ts/parser/parser.svelte', () => ({
    risuChatParser: (text: string, arg: any) => {
        calls.push(`parse:${arg.runVar ? 'runVar' : ''}`)
        return text.replace('{{setvar::hp::1}}', '')
    },
}))
vi.mock('../modules', () => ({
    captureModuleRuntimeContext: () => ({ userName: 'me', personaPrompt: '', modules: [] }),
}))
vi.mock('../scripts', () => ({
    processScriptFull: vi.fn(async (_char: any, data: string, mode: string, index: number) => {
        calls.push(`${mode}@${index}`)
        return { data: data.replace('raw', 'regexed'), emoChanged: false }
    }),
}))
vi.mock('../triggers', () => ({
    runTrigger: vi.fn(async (_char: any, mode: string, arg: any) => {
        calls.push(`trigger:${mode}`)
        expect(arg.targetChat).toBe(arg.chat)
        return mocks.triggerChat ? { chat: mocks.triggerChat(arg.chat) } : {}
    }),
}))
vi.mock('../inlayScreen', () => ({
    runInlayScreen: vi.fn((_char: any, data: string) => {
        calls.push('inlay')
        return mocks.inlayPromise
            ? { text: data.replace('<ImgGen="cat">', '[Generating...]'), promise: mocks.inlayPromise }
            : { text: data }
    }),
}))

const { postProcessRecoveredMessage, isPostProcessed } = await import('./recoveryPostProcess')

function target(data: string) {
    const chat: any = {
        id: 'chat-1',
        message: [
            { role: 'user', data: 'hi {{setvar::hp::1}}' },
            { role: 'char', data, chatId: 'gen-1', generationInfo: { generationId: 'gen-1' } },
        ],
    }
    const char: any = { chaId: 'c', reloadKeys: 0, chats: [chat] }
    return { char, chat }
}

beforeEach(() => {
    calls.length = 0
    mocks.db = { removeIncompleteResponse: false }
    mocks.triggerChat = null
    mocks.inlayPromise = null
})

describe('postProcessRecoveredMessage', () => {
    it('runs regex, variables, the output trigger and image inlay in the live order', async () => {
        mocks.inlayPromise = Promise.resolve('regexed reply {{inlay::abc}}')
        const t = target('  raw reply <ImgGen="cat">  ')

        const chat = await postProcessRecoveredMessage(t, 'gen-1')

        expect(calls).toEqual(['editoutput@1', 'parse:runVar', 'parse:runVar', 'trigger:output', 'inlay'])
        expect(chat.message[1].data).toBe('regexed reply {{inlay::abc}}')
        expect(chat.message[0].data).toBe('hi ')
        expect(isPostProcessed(chat.message[1])).toBe(true)
        expect(t.char.reloadKeys).toBe(1)
    })

    it('adopts the chat an output trigger hands back', async () => {
        mocks.triggerChat = (chat: any) => ({
            ...chat,
            message: chat.message.map((m: any) => m.chatId === 'gen-1' ? { ...m, data: m.data + ' [hp 10]' } : m),
        })
        const t = target('raw reply')

        const chat = await postProcessRecoveredMessage(t, 'gen-1')

        expect(chat).toBe(t.char.chats[0])
        expect((chat as any).normalized).toBe(true)
        expect(chat.message[1].data).toBe('regexed reply [hp 10]')
        expect(isPostProcessed(chat.message[1])).toBe(true)
    })

    it('trims an unfinished sentence when the user asked for it', async () => {
        mocks.db = { removeIncompleteResponse: true }
        const t = target('raw reply. and then')
        const chat = await postProcessRecoveredMessage(t, 'gen-1')
        expect(chat.message[1].data).toBe('regexed reply.')
    })

    it('does nothing for a reply that was already processed', async () => {
        const t = target('raw reply')
        t.chat.message[1].generationInfo.postProcessed = true
        await postProcessRecoveredMessage(t, 'gen-1')
        expect(calls).toEqual([])
        expect(t.chat.message[1].data).toBe('raw reply')
    })
})
