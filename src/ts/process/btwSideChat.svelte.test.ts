import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { character, Chat } from '../storage/database.svelte'
import type { requestDataResponse } from './request/request'

const mocks = vi.hoisted(() => ({
    route: { kind: 'classic', aiModel: 'main-model', providerKey: 'classic:main-model', fallbackModels: [] },
    requestChatData: vi.fn(),
    captureChatModelRoute: vi.fn(),
}))

vi.mock('./request/request', () => ({ requestChatData: mocks.requestChatData }))
vi.mock('./request/modelPresetBinding', () => ({ captureChatModelRoute: mocks.captureChatModelRoute }))
vi.mock('./modules', () => ({
    captureModuleRuntimeContext: (char: character, chat: Chat) => ({
        character: char,
        chat,
        userName: 'Me',
        personaPrompt: 'A bard who sings to {{char}}.',
    }),
}))
vi.mock('../util', () => ({
    findCharacterbyId: (id: string) => ({ name: id === 'bram' ? 'Bram' : 'Unknown Character' }),
}))

import {
    askBtw,
    btwChatKey,
    btwSideChat,
    clearBtw,
    ensureBtwChat,
    getBtwChatState,
    nextBtwStore,
    stopBtw,
    type BtwStoredChat,
} from './btwSideChat.svelte'
import { BTW_SYSTEM_INSTRUCTION, type BtwExchange } from './btwSideChat'

const STORAGE_KEY = 'risu-btw-side-chat'

function makeCharacter(): character {
    return {
        chaId: 'aria',
        name: 'Aria',
        desc: '{{char}} guards the northern keep.',
        personality: 'Stern',
        scenario: 'Winter siege',
        firstMessage: 'Halt, {{user}}.',
        alternateGreetings: [],
    } as unknown as character
}

function makeChat(id: string): Chat {
    return {
        id,
        name: 'Siege',
        note: 'author note',
        localLore: [],
        fmIndex: -1,
        scriptstate: { $trust: '3' },
        message: [
            { role: 'user', data: 'I bring news, {{char}}.', chatId: 'm1', time: 1 },
            { role: 'char', data: '<Thoughts>wary</Thoughts>Speak quickly.', chatId: 'm2', time: 2, saying: 'aria' },
            { role: 'char', data: 'Bram grunts.', chatId: 'm3', time: 3, saying: 'bram' },
        ],
    } as Chat
}

/** Deep proxy that records every write; reads pass through. */
function trackWrites<T extends object>(target: T, writes: string[], path = 'chat'): T {
    return new Proxy(target, {
        get(obj, prop, receiver) {
            const value = Reflect.get(obj, prop, receiver)
            return value && typeof value === 'object' ? trackWrites(value, writes, `${path}.${String(prop)}`) : value
        },
        set(obj, prop, value) {
            writes.push(`set ${path}.${String(prop)}`)
            return Reflect.set(obj, prop, value)
        },
        deleteProperty(obj, prop) {
            writes.push(`delete ${path}.${String(prop)}`)
            return Reflect.deleteProperty(obj, prop)
        },
        defineProperty(obj, prop, descriptor) {
            writes.push(`define ${path}.${String(prop)}`)
            return Reflect.defineProperty(obj, prop, descriptor)
        },
    })
}

function success(result: string): requestDataResponse {
    return { type: 'success', result }
}

/** A streaming response the test feeds chunk by chunk. */
function manualStream() {
    let controller!: ReadableStreamDefaultController<{ [key: string]: string }>
    const stream = new ReadableStream<{ [key: string]: string }>({ start(c) { controller = c } })
    return {
        response: { type: 'streaming', result: stream } as requestDataResponse,
        push: (text: string) => controller.enqueue({ '0': text }),
        end: () => controller.close(),
    }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let chatSeq = 0
function freshChat(): Chat {
    chatSeq++
    return makeChat(`chat-${chatSeq}`)
}

beforeEach(() => {
    mocks.requestChatData.mockReset()
    mocks.captureChatModelRoute.mockReset()
    mocks.captureChatModelRoute.mockReturnValue(mocks.route)
    sessionStorage.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('askBtw request', () => {
    test('uses the chat main route as an auxiliary request that skips triggers and tools', async () => {
        const char = makeCharacter()
        const chat = freshChat()
        mocks.requestChatData.mockResolvedValue(success('She trusts you a little.'))

        expect(await askBtw(char, chat, '  What does Aria think of me?  ')).toBe('done')

        expect(mocks.captureChatModelRoute).toHaveBeenCalledWith(chat, 'model')
        expect(mocks.requestChatData).toHaveBeenCalledTimes(1)
        const [arg, mode, signal] = mocks.requestChatData.mock.calls[0]
        expect(mode).toBe('otherAx')
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(arg.routeSnapshot).toBe(mocks.route)
        expect(arg.skipRequestTrigger).toBe(true)
        expect(arg.tools).toEqual([])
        expect(arg.useStreaming).toBe(true)
        // Never tied to the chat's generation: no realChatId (a server-side
        // job stays 'aux') and no generation id.
        expect(arg.realChatId).toBeUndefined()
        expect(arg.chatId).toBeUndefined()
        expect(arg.currentChar).toBe(char)
        expect(arg.currentChat).toBe(chat)

        const system = arg.formated[0]
        expect(system.role).toBe('system')
        expect(system.content.startsWith(BTW_SYSTEM_INSTRUCTION)).toBe(true)
        expect(system.content).toContain('Aria guards the northern keep.')
        expect(system.content).toContain('Personality: Stern')
        expect(system.content).toContain('Scenario: Winter siege')
        expect(system.content).toContain('<user_persona name="Me">\nA bard who sings to Aria.\n</user_persona>')
        expect(system.content).toContain([
            'Aria: Halt, Me.',
            'Me: I bring news, Aria.',
            'Aria: Speak quickly.',
            'Bram: Bram grunts.',
        ].join('\n'))
        expect(system.content).not.toContain('wary')
        expect(system.content).not.toContain('author note')
        expect(arg.formated.at(-1)).toEqual({ role: 'user', content: 'What does Aria think of me?' })
    })

    test('a follow-up carries the earlier side exchange', async () => {
        const char = makeCharacter()
        const chat = freshChat()
        mocks.requestChatData.mockResolvedValueOnce(success('First answer.'))
        mocks.requestChatData.mockResolvedValueOnce(success('Second answer.'))

        await askBtw(char, chat, 'First question')
        await askBtw(char, chat, 'And why?')

        const formated = mocks.requestChatData.mock.calls[1][0].formated
        expect(formated.slice(1)).toEqual([
            { role: 'user', content: 'First question' },
            { role: 'assistant', content: 'First answer.' },
            { role: 'user', content: 'And why?' },
        ])
        expect(getBtwChatState(btwChatKey(char, chat)).history.map((e: BtwExchange) => e.answer)).toEqual(['First answer.', 'Second answer.'])
    })

    test('side chats are kept per chat', async () => {
        const char = makeCharacter()
        const chatA = freshChat()
        const chatB = freshChat()
        mocks.requestChatData.mockResolvedValue(success('ok'))

        await askBtw(char, chatA, 'about A')
        await askBtw(char, chatB, 'about B')

        expect(mocks.requestChatData.mock.calls[1][0].formated).toHaveLength(2)
        expect(getBtwChatState(btwChatKey(char, chatA)).history).toHaveLength(1)
        expect(getBtwChatState(btwChatKey(char, chatB)).history).toHaveLength(1)
    })
})

describe('the main chat is left alone', () => {
    test('no write reaches the chat or the character, and they serialize the same', async () => {
        const writes: string[] = []
        const rawChat = freshChat()
        const rawChar = makeCharacter()
        const before = JSON.stringify({ chat: rawChat, char: rawChar })
        const chat = trackWrites(rawChat, writes)
        const char = trackWrites(rawChar, writes, 'character')
        const stream = manualStream()
        mocks.requestChatData.mockResolvedValueOnce(stream.response)
        mocks.requestChatData.mockResolvedValueOnce(success('Then she wavers.'))

        const asking = askBtw(char, chat, 'Will she open the gate?')
        await flush()
        stream.push('Probably')
        stream.push('Probably not.')
        stream.end()
        expect(await asking).toBe('done')
        await askBtw(char, chat, 'And if I insist?')

        expect(writes).toEqual([])
        expect(JSON.stringify({ chat: rawChat, char: rawChar })).toBe(before)
        expect(rawChat.message).toHaveLength(3)
        expect(rawChat.scriptstate).toEqual({ $trust: '3' })
        expect(Object.keys(rawChat).sort()).toEqual(['fmIndex', 'id', 'localLore', 'message', 'name', 'note', 'scriptstate'])
    })
})

describe('response handling', () => {
    test('streams into the pending answer and stores the final text without reasoning', async () => {
        const char = makeCharacter()
        const chat = freshChat()
        const key = btwChatKey(char, chat)
        const stream = manualStream()
        mocks.requestChatData.mockResolvedValue(stream.response)

        const asking = askBtw(char, chat, 'Recap?')
        await flush()
        expect(getBtwChatState(key).pending).toEqual({ question: 'Recap?', answer: '' })

        stream.push('<Thoughts>let me see')
        await flush()
        expect(getBtwChatState(key).pending?.answer).toBe('')

        stream.push('<Thoughts>let me see</Thoughts>You arrived at')
        await flush()
        expect(getBtwChatState(key).pending?.answer).toBe('You arrived at')

        stream.push('<Thoughts>let me see</Thoughts>You arrived at the keep.')
        stream.end()
        expect(await asking).toBe('done')

        const state = getBtwChatState(key)
        expect(state.pending).toBeNull()
        expect(state.history).toEqual([expect.objectContaining({ question: 'Recap?', answer: 'You arrived at the keep.' })])
    })

    test('a failed request shows the error and records nothing', async () => {
        const char = makeCharacter()
        const chat = freshChat()
        const key = btwChatKey(char, chat)
        mocks.requestChatData.mockResolvedValue({ type: 'fail', result: 'quota exceeded' })

        expect(await askBtw(char, chat, 'Anything?')).toBe('failed')
        expect(getBtwChatState(key).error).toBe('quota exceeded')
        expect(getBtwChatState(key).history).toEqual([])
        expect(getBtwChatState(key).pending).toBeNull()
    })

    test('an empty answer counts as a failure', async () => {
        const char = makeCharacter()
        const chat = freshChat()
        mocks.requestChatData.mockResolvedValue(success('<Thoughts>hmm</Thoughts>  '))

        expect(await askBtw(char, chat, 'Anything?')).toBe('failed')
        expect(getBtwChatState(btwChatKey(char, chat)).history).toEqual([])
    })

    test('stop aborts the request and records nothing', async () => {
        const char = makeCharacter()
        const chat = freshChat()
        const key = btwChatKey(char, chat)
        const stream = manualStream()
        mocks.requestChatData.mockResolvedValue(stream.response)

        const asking = askBtw(char, chat, 'Long story?')
        await flush()
        stream.push('Once upon')
        await flush()
        expect(await askBtw(char, chat, 'second while busy')).toBe('busy')
        stopBtw(key)

        expect(await asking).toBe('aborted')
        expect(mocks.requestChatData.mock.calls[0][2].aborted).toBe(true)
        expect(getBtwChatState(key).history).toEqual([])
        expect(getBtwChatState(key).pending).toBeNull()
        expect(getBtwChatState(key).error).toBe('')
    })

    test('a blank question sends nothing', async () => {
        expect(await askBtw(makeCharacter(), freshChat(), '   ')).toBe('empty')
        expect(mocks.requestChatData).not.toHaveBeenCalled()
    })
})

describe('side history storage', () => {
    test('survives a page reload in the same tab and clears', async () => {
        const char = makeCharacter()
        const chat = freshChat()
        const key = btwChatKey(char, chat)
        mocks.requestChatData.mockResolvedValue(success('Kept answer.'))
        await askBtw(char, chat, 'Keep this?')

        const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as BtwStoredChat[]
        expect(stored.find((entry) => entry.key === key)?.history[0]).toMatchObject({ question: 'Keep this?', answer: 'Kept answer.' })

        // A reload starts with an empty memory store.
        btwSideChat.chats = {}
        expect(getBtwChatState(key).history).toEqual([])
        expect(ensureBtwChat(key).history).toEqual([expect.objectContaining({ answer: 'Kept answer.' })])

        clearBtw(key)
        expect(getBtwChatState(key).history).toEqual([])
        expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    test('a broken stored value is ignored', () => {
        sessionStorage.setItem(STORAGE_KEY, '{not json')
        expect(ensureBtwChat('aria/broken').history).toEqual([])
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify([{ key: 'aria/odd', history: [{ question: 1 }, { question: 'q', answer: 'a', time: 1 }] }]))
        expect(ensureBtwChat('aria/odd').history).toEqual([{ question: 'q', answer: 'a', time: 1 }])
    })

    test('the stored list is bounded by chat count and size', () => {
        const exchange = (size: number): BtwExchange => ({ question: 'q', answer: 'a'.repeat(size), time: 1 })
        let store: BtwStoredChat[] = []
        for (let i = 0; i < 12; i++) store = nextBtwStore(store, `chat-${i}`, [exchange(10)])
        expect(store.map((entry) => entry.key)).toEqual(['chat-4', 'chat-5', 'chat-6', 'chat-7', 'chat-8', 'chat-9', 'chat-10', 'chat-11'])

        // Re-saving moves a chat to the newest end; an empty history removes it.
        store = nextBtwStore(store, 'chat-4', [exchange(10)])
        expect(store.at(-1)?.key).toBe('chat-4')
        store = nextBtwStore(store, 'chat-4', [])
        expect(store.some((entry) => entry.key === 'chat-4')).toBe(false)

        const big = Array.from({ length: 20 }, () => exchange(30_000))
        store = nextBtwStore(store, 'huge', big)
        expect(JSON.stringify(store).length).toBeLessThanOrEqual(200_000)
        expect(store).toHaveLength(1)
        expect(store[0].key).toBe('huge')
        expect(store[0].history.length).toBeGreaterThan(0)
        expect(store[0].history.length).toBeLessThan(20)
    })
})
