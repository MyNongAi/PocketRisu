import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ value: {} as any }))
const requestChatData = vi.hoisted(() => vi.fn())
const generateAIImage = vi.hoisted(() => vi.fn())
const writeInlayImage = vi.hoisted(() => vi.fn())
const notifyError = vi.hoisted(() => vi.fn())
const notifyInfo = vi.hoisted(() => vi.fn())

vi.mock('../stores.svelte', () => ({ DBState: { get db() { return db.value } } }))
vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('./modules', () => ({ getModuleLorebooks: () => [] }))
vi.mock('./request/request', () => ({ requestChatData }))
vi.mock('./request/shared', () => ({ collectStreamingText: vi.fn() }))
vi.mock('./stableDiff', () => ({ generateAIImage }))
vi.mock('./files/inlays', () => ({ writeInlayImage }))
vi.mock('../alert', () => ({ notifyError, notifyInfo }))
vi.mock('../../lang', () => ({ language: { illustrationFailed: 'failed', illustrationNothing: 'nothing', illustrationNoImageProvider: 'no provider' } }))
vi.stubGlobal('Image', class { src = '' })

const { illustrateReply, removeIllustrations, startAutoIllustration } = await import('./illustrationRun')

const scene = (line: number) => ({ line, camera: 'cowboy shot', scene: '1girl', characters: [{ name: 'Maah', positive: 'silver hair', negative: '' }] })

function setup(settings: any = { enabled: true }) {
    const reply = { role: 'char', data: 'She smiles.\n"Hello."', chatId: 'r1' } as any
    const chat = { id: 'c1', localLore: [], message: [{ role: 'user', data: 'Hi', chatId: 'u1' }, reply] } as any
    const character = { chaId: 'ch1', name: 'Maah', desc: 'A demon princess.', globalLore: [{ comment: 'looks', content: 'Maah: silver hair', nodeOnlyIllustration: true }, { comment: 'story', content: 'The world', alwaysActive: true }], chats: [chat], nodeOnlyIllustration: settings } as any
    db.value = { characters: [character], sdProvider: 'novelai', username: 'User', nodeOnlyIllustrationPresets: [{ id: 'p1', name: 'P', positive: 'artist:a, {prompt}', negative: 'lowres' }] }
    return { character, chat, reply }
}

const run = (manual = false) => illustrateReply({ chaId: 'ch1', chatId: 'c1', messageId: 'r1', manual })

beforeEach(() => {
    requestChatData.mockReset()
    generateAIImage.mockReset()
    writeInlayImage.mockReset()
    notifyError.mockReset()
    notifyInfo.mockReset()
})

describe('drawing the illustrations of a reply', () => {
    it('asks for scenes with the 🎨 entries, draws them with the preset and puts each after its line', async () => {
        const { character, reply } = setup({ enabled: true, presetId: 'p1', ratio: 'landscape', count: '1-2' })
        requestChatData.mockResolvedValue({ type: 'success', result: JSON.stringify([scene(1)]) })
        generateAIImage.mockResolvedValue('data:image/png;base64,AAA')
        writeInlayImage.mockResolvedValue('inlay-1')

        expect(await run()).toBe(1)
        const [request, mode] = requestChatData.mock.calls[0]
        expect(mode).toBe('otherAx')
        const prompt = request.formated[1].content
        expect(prompt).toContain('Maah: silver hair')
        expect(prompt).not.toContain('The world')
        expect(prompt).toContain('A demon princess.')
        expect(generateAIImage).toHaveBeenCalledWith('artist:a, cowboy shot, 1girl', character, 'lowres', 'inlay', {
            width: 1216, height: 832, characters: [{ positive: 'silver hair', negative: '' }],
        })
        expect(reply.data).toBe('She smiles.\n{{inlay::inlay-1}}\n"Hello."')
        expect(reply.nodeOnlyIllustrations['inlay-1'].positive).toBe('artist:a, cowboy shot, 1girl')
        // the main model will not see the picture lines
        expect(reply.nodeOnlyAuxLines).toContain('{{inlay::inlay-1}}')
    })

    it('takes out the "drawing…" line of a picture that failed', async () => {
        const { reply } = setup()
        requestChatData.mockResolvedValue({ type: 'success', result: JSON.stringify([scene(2)]) })
        generateAIImage.mockResolvedValue(false)
        expect(await run()).toBe(0)
        expect(reply.data).toBe('She smiles.\n"Hello."')
    })

    it('draws into the swipe that holds the reply when another page is shown', async () => {
        const { reply } = setup()
        requestChatData.mockImplementation(async () => {
            // a reroll kept the earlier page on screen meanwhile
            reply.swipes = ['Earlier page', reply.data]
            reply.data = 'Earlier page'
            return { type: 'success', result: JSON.stringify([scene(1)]) }
        })
        generateAIImage.mockResolvedValue('data:image/png;base64,AAA')
        writeInlayImage.mockResolvedValue('inlay-2')
        await run()
        expect(reply.data).toBe('Earlier page')
        expect(reply.swipes[1]).toBe('She smiles.\n{{inlay::inlay-2}}\n"Hello."')
    })

    it('says when there is nothing to draw, or no image generation, only when asked by hand', async () => {
        setup()
        requestChatData.mockResolvedValue({ type: 'success', result: '[]' })
        await run(true)
        expect(notifyInfo).toHaveBeenCalledWith('nothing')
        db.value.sdProvider = ''
        expect(await run(true)).toBe(0)
        expect(notifyError).toHaveBeenCalledWith('no provider')
    })

    it('removes the pictures drawn before, to draw again', () => {
        const { reply } = setup()
        reply.data = 'a\n{{inlay::x}}\nb'
        reply.nodeOnlyIllustrations = { x: { positive: 'p', negative: '', characters: [] } }
        removeIllustrations(reply)
        expect(reply.data).toBe('a\nb')
        expect(reply.nodeOnlyIllustrations).toBeUndefined()
    })

    it('starts on its own only when the bot draws after every reply and the reply has no pictures', () => {
        const { character, chat, reply } = setup({ enabled: true, trigger: 'button' })
        requestChatData.mockResolvedValue({ type: 'success', result: '[]' })
        startAutoIllustration({ character, chat })
        expect(requestChatData).not.toHaveBeenCalled()
        character.nodeOnlyIllustration = { enabled: true }
        reply.nodeOnlyIllustrations = { x: { positive: '', negative: '', characters: [] } }
        startAutoIllustration({ character, chat })
        expect(requestChatData).not.toHaveBeenCalled()
        delete reply.nodeOnlyIllustrations
        startAutoIllustration({ character, chat })
        expect(requestChatData).toHaveBeenCalledTimes(1)
    })
})
