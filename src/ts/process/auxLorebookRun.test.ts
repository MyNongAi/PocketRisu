import { beforeEach, describe, expect, it, vi } from 'vitest'

const moduleLore = vi.hoisted(() => ({ value: [] as any[] }))
const requestChatData = vi.hoisted(() => vi.fn())
const notifyError = vi.hoisted(() => vi.fn())

vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text.replace('{{char}}', 'Maah') }))
vi.mock('./modules', () => ({ getModuleLorebooks: () => moduleLore.value }))
vi.mock('./request/request', () => ({ requestChatData }))
vi.mock('./request/shared', () => ({ collectStreamingText: vi.fn() }))
vi.mock('../alert', () => ({ notifyError }))
vi.mock('../../lang', () => ({ language: { auxLorebookFailed: 'aux failed' } }))

const { newestReply, tagReplyByAuxLorebook } = await import('./auxLorebookRun')

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

function run(character: any, chat: any, signal = new AbortController().signal) {
    return tagReplyByAuxLorebook({ character, chat, currentChat: () => chat, moduleContext: {} as any, userName: 'User', signal })
}

beforeEach(() => {
    moduleLore.value = [{ comment: 'asset rules', content: '@@depth 0\nTag {{char}} with <img="name">', nodeOnlyAuxModel: true }]
    requestChatData.mockReset()
    notifyError.mockReset()
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

    it('does nothing without a marked entry', async () => {
        moduleLore.value = [{ comment: 'asset rules', content: 'Tag', alwaysActive: true }]
        const { character, chat } = setup()
        expect(await run(character, chat)).toBe(false)
        expect(requestChatData).not.toHaveBeenCalled()
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
