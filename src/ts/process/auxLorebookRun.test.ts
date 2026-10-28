import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const moduleLore = vi.hoisted(() => ({ value: [] as any[] }))
const requestChatData = vi.hoisted(() => vi.fn())
const notifyError = vi.hoisted(() => vi.fn())
const notifyInfo = vi.hoisted(() => vi.fn())
const db = vi.hoisted(() => ({ value: { characters: [] as any[], username: 'User' } }))

vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text.replace('{{char}}', 'Maah') }))
vi.mock('./modules', () => ({ getModuleLorebooks: () => moduleLore.value }))
vi.mock('./request/request', () => ({ requestChatData }))
vi.mock('./request/shared', () => ({ collectStreamingText: vi.fn() }))
vi.mock('../alert', () => ({ notifyError, notifyInfo }))
vi.mock('../stores.svelte', () => ({ DBState: { get db() { return db.value } } }))
vi.mock('../../lang', () => ({ language: { auxLorebookFailed: 'aux failed', auxAssetNoRules: 'no rules', auxAssetNothing: 'nothing' } }))

const { auxRetagging, newestReply, retagReplyByAuxLorebook, tagReplyByAuxLorebook } = await import('./auxLorebookRun')

function setup(reply = 'She laughs.\n"Really?"') {
    const character = { name: 'Maah', globalLore: [{ comment: 'story', content: 'The world', alwaysActive: true }] } as any
    const chat = {
        localLore: [],
        message: [
            { role: 'user', data: 'Tell me a joke', chatId: 'u1' },
            { role: 'char', data: reply, chatId: 'c1' },
        ],
    } as any
    return { character, chat }
}

function run(character: any, chat: any, signal = new AbortController().signal, moduleContext: any = {}) {
    return tagReplyByAuxLorebook({ character, chat, currentChat: () => chat, moduleContext, userName: 'User', signal })
}

function answer(edits: { line: number, content: string }[]) {
    return { type: 'success', result: JSON.stringify(edits) }
}

beforeEach(() => {
    moduleLore.value = [{ comment: 'asset rules', content: '@@depth 0\nTag {{char}} with <img="name">', nodeOnlyAuxModel: true }]
    requestChatData.mockReset()
    notifyError.mockReset()
    notifyInfo.mockReset()
    db.value = { characters: [], username: 'User' }
})

describe('tagging the newest reply by the marked entries', () => {
    it('asks the auxiliary model with the marked entries and inserts its tags', async () => {
        const { character, chat } = setup()
        requestChatData.mockResolvedValue({ type: 'success', result: '[{"line": 1, "content": "<img=\\"maah_happy\\">"}]' })
        expect(await run(character, chat)).toBe(true)

        const [request, mode] = requestChatData.mock.calls[0]
        expect(mode).toBe('otherAx')
        const prompt = request.formated[1].content
        expect(prompt).toContain('Tag Maah with <img="name">')
        expect(prompt).not.toContain('@@depth')
        expect(prompt).not.toContain('The world')
        expect(prompt).toContain('User: Tell me a joke')
        expect(chat.message[1].data).toBe('She laughs.\n<img="maah_happy">\n"Really?"')
        expect(chat.message[1].nodeOnlyAuxLines).toEqual(['<img="maah_happy">'])
    })

    it('tags afresh after a continue: the earlier tags are taken out first', async () => {
        const { character, chat } = setup('She laughs.\n<img="maah_happy">\n"Really?" More text.')
        chat.message[1].nodeOnlyAuxLines = ['<img="maah_happy">']
        requestChatData.mockResolvedValue({ type: 'success', result: '[{"line": 2, "content": "<img=\\"maah_sad\\">"}]' })
        await run(character, chat)
        expect(requestChatData.mock.calls[0][0].formated[1].content).toContain('[1] She laughs.\n[2] "Really?" More text.')
        expect(chat.message[1].data).toBe('She laughs.\n"Really?" More text.\n<img="maah_sad">')
        expect(chat.message[1].nodeOnlyAuxLines).toEqual(['<img="maah_happy">', '<img="maah_sad">'])
    })

    it('keeps the illustrations drawn into the reply when it tags afresh', async () => {
        const { character, chat } = setup('She laughs.\n{{inlay::pic-1}}\n<img="maah_happy">\n"Really?" More text.')
        chat.message[1].nodeOnlyAuxLines = ['{{inlay::pic-1}}', '<img="maah_happy">']
        chat.message[1].nodeOnlyIllustrations = { 'pic-1': {} }
        requestChatData.mockResolvedValue(answer([{ line: 3, content: '<img="maah_sad">' }]))
        await run(character, chat)
        expect(chat.message[1].data).toBe('She laughs.\n{{inlay::pic-1}}\n"Really?" More text.\n<img="maah_sad">')
    })

    it('changes the shown swipe with the reply', async () => {
        const { character, chat } = setup()
        chat.message[1].swipes = ['Older swipe', 'She laughs.\n"Really?"']
        requestChatData.mockResolvedValue(answer([{ line: 1, content: '<img="a">' }]))
        await run(character, chat)
        expect(chat.message[1].swipes).toEqual(['Older swipe', 'She laughs.\n<img="a">\n"Really?"'])
    })

    it("leaves the reply to the menu's 🌙 when the bot's automatic tagging is off", async () => {
        const { character, chat } = setup()
        character.nodeOnlyAuxAsset = { auto: false }
        expect(await run(character, chat)).toBe(false)
        expect(requestChatData).not.toHaveBeenCalled()
    })

    it('does nothing without a marked entry', async () => {
        moduleLore.value = [{ comment: 'asset rules', content: 'Tag', alwaysActive: true }]
        const { character, chat } = setup()
        expect(await run(character, chat)).toBe(false)
        expect(requestChatData).not.toHaveBeenCalled()
        expect(notifyInfo).not.toHaveBeenCalled()
    })

    it('leaves a reply that changed while the auxiliary model answered', async () => {
        const { character, chat } = setup()
        requestChatData.mockImplementation(async () => {
            chat.message[1].data = 'Edited by hand'
            return { type: 'success', result: '[{"line": 1, "content": "<img=\\"a\\">"}]' }
        })
        expect(await run(character, chat)).toBe(false)
        expect(chat.message[1].data).toBe('Edited by hand')
    })

    it('says so when the auxiliary model fails, and keeps the reply', async () => {
        const { character, chat } = setup()
        requestChatData.mockResolvedValue({ type: 'fail', result: 'quota exceeded' })
        expect(await run(character, chat)).toBe(false)
        expect(notifyError).toHaveBeenCalledWith('aux failed: quota exceeded')
        expect(chat.message[1].data).toBe('She laughs.\n"Really?"')
    })

    it('finds the newest reply past comments, and none when the user spoke last', () => {
        const messages = [{ role: 'user', data: 'a' }, { role: 'char', data: 'b' }, { role: 'user', data: 'note', isComment: true }] as any
        expect(newestReply(messages)?.reply.data).toBe('b')
        expect(newestReply([...messages, { role: 'user', data: 'c' }] as any)).toBeNull()
    })
})

describe("the bot's ⚙", () => {
    function longChat() {
        const { character, chat } = setup()
        chat.message = [
            { role: 'user', data: 'u-one', chatId: 'u1' },
            { role: 'char', data: 'c-one', chatId: 'c1' },
            { role: 'user', data: 'u-two', chatId: 'u2' },
            { role: 'char', data: 'c-two', chatId: 'c2' },
            { role: 'user', data: 'u-three', chatId: 'u3' },
            { role: 'char', data: 'The reply.', chatId: 'c3' },
        ]
        return { character, chat }
    }

    it('sends the chosen number of earlier messages, the user\'s left out when asked', async () => {
        const { character, chat } = longChat()
        character.nodeOnlyAuxAsset = { contextCount: 3 }
        requestChatData.mockResolvedValue(answer([]))
        await run(character, chat)
        let prompt = requestChatData.mock.calls[0][0].formated[1].content
        expect(prompt).toContain('User: u-two')
        expect(prompt).toContain('Maah: c-two')
        expect(prompt).toContain('User: u-three')
        expect(prompt).not.toContain('c-one')

        character.nodeOnlyAuxAsset = { contextCount: 3, skipUser: true }
        await run(character, chat)
        prompt = requestChatData.mock.calls[1][0].formated[1].content
        expect(prompt).toContain('Maah: c-one')
        expect(prompt).toContain('Maah: c-two')
        expect(prompt).not.toContain('u-')
    })

    it('sends the description and the persona when on, and asks the main model when on', async () => {
        const { character, chat } = longChat()
        character.desc = 'A fox girl, {{char}}.'
        character.nodeOnlyAuxAsset = { description: true, persona: true, mainModel: true }
        requestChatData.mockResolvedValue(answer([]))
        await run(character, chat, undefined, { personaPrompt: 'A traveller.' })
        const [request, mode] = requestChatData.mock.calls[0]
        expect(mode).toBe('model')
        expect(request.formated[1].content).toContain('# Maah (context only)\nA fox girl, Maah.')
        expect(request.formated[1].content).toContain('# User, the user (context only)\nA traveller.')
    })
})

describe('🌙 in a reply\'s menu', () => {
    function stored() {
        const { character, chat } = setup()
        chat.id = 'chat-1'
        chat.message.push({ role: 'user', data: 'Next', chatId: 'u2' }, { role: 'char', data: 'Newer reply', chatId: 'c2' })
        chat.message[1].data = 'She laughs.\n<img="old">\n"Really?"'
        chat.message[1].nodeOnlyAuxLines = ['<img="old">']
        character.chaId = 'bot-1'
        character.chats = [chat]
        db.value = { characters: [character], username: 'Jin' }
        return { character, chat }
    }
    const retag = (messageId = 'c1') => retagReplyByAuxLorebook({ chaId: 'bot-1', chatId: 'chat-1', messageId, moduleContext: {} as any })

    it('tags an older reply again, its earlier tags out', async () => {
        const { chat } = stored()
        requestChatData.mockResolvedValue(answer([{ line: 2, content: '<img="new">' }]))
        expect(await retag()).toBe(true)
        const prompt = requestChatData.mock.calls[0][0].formated[1].content
        expect(prompt).toContain('[1] She laughs.\n[2] "Really?"')
        expect(prompt).toContain('Jin: Tell me a joke')
        expect(prompt).not.toContain('Newer reply')
        expect(chat.message[1].data).toBe('She laughs.\n"Really?"\n<img="new">')
        expect(chat.message[3].data).toBe('Newer reply')
        expect(get(auxRetagging).size).toBe(0)
    })

    it('says so when there is nothing to tag by, or nothing to place', async () => {
        const { chat } = stored()
        requestChatData.mockResolvedValue(answer([]))
        expect(await retag()).toBe(false)
        expect(notifyInfo).toHaveBeenCalledWith('nothing')
        expect(chat.message[1].data).toBe('She laughs.\n<img="old">\n"Really?"')

        moduleLore.value = []
        expect(await retag()).toBe(false)
        expect(notifyInfo).toHaveBeenLastCalledWith('no rules')
    })

    it('leaves a user message and an unknown id alone', async () => {
        stored()
        expect(await retag('u1')).toBe(false)
        expect(await retag('gone')).toBe(false)
        expect(requestChatData).not.toHaveBeenCalled()
    })
})
