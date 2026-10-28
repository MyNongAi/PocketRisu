import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ value: {} as any }))
const requestChatData = vi.hoisted(() => vi.fn())
const generateAIImage = vi.hoisted(() => vi.fn())
const writeInlayImage = vi.hoisted(() => vi.fn())
const notifyError = vi.hoisted(() => vi.fn())
const notifyInfo = vi.hoisted(() => vi.fn())
const loadLoreBookV3Prompt = vi.hoisted(() => vi.fn(async (_context?: any) => ({ actives: [] as any[] })))

vi.mock('../stores.svelte', () => ({ DBState: { get db() { return db.value } } }))
vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('./modules', () => ({ getModuleLorebooks: () => [], getModules: () => [], captureModuleRuntimeContext: (character: any, chat: any) => ({ character, chat, modules: [] }) }))
vi.mock('./lorebook.svelte', () => ({ loadLoreBookV3Prompt }))
vi.mock('./request/request', () => ({ requestChatData }))
vi.mock('./request/shared', () => ({ collectStreamingText: vi.fn() }))
vi.mock('./stableDiff', () => ({ generateAIImage }))
vi.mock('./files/inlays', () => ({ writeInlayImage }))
vi.mock('../alert', () => ({ notifyError, notifyInfo }))
vi.mock('../../lang', () => ({ language: { illustrationFailed: 'failed', illustrationNothing: 'nothing', illustrationNoImageProvider: 'no provider', illustrationModuleName: '🎨 삽화', illustrationModuleDescription: 'presets' } }))
vi.stubGlobal('Image', class { src = '' })

const { illustrateReply, presetsFor, removeIllustrations, startAutoIllustration } = await import('./illustrationRun')

const scene = (line: number) => ({ line, camera: 'cowboy shot', scene: '1girl', characters: [{ name: 'Maah', positive: 'silver hair', negative: '' }] })

function setup(settings: any = { enabled: true }) {
    const reply = { role: 'char', data: 'She smiles.\n"Hello."', chatId: 'r1' } as any
    const chat = { id: 'c1', localLore: [], message: [{ role: 'user', data: 'Hi', chatId: 'u1' }, reply] } as any
    const character = { chaId: 'ch1', name: 'Maah', desc: 'A demon princess.', globalLore: [{ comment: 'looks', content: 'Maah: silver hair', nodeOnlyIllustration: true }, { comment: 'story', key: 'castle', content: 'The world', alwaysActive: true }, { comment: 'rin', key: 'hello, 안녕', content: 'Rin: black hair, red eyes' }, { comment: '프리셋 P', content: '[Positive]\nartist:a, {prompt}\n[Negative]\nlowres\n[NAI]\nsteps: 20' }], chats: [chat], nodeOnlyIllustration: settings } as any
    db.value = { characters: [character], sdProvider: 'novelai', username: 'User' }
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

describe('the 🎨 module in a run', () => {
    const artModule = () => ({
        id: 'art', name: '🎨 삽화', description: '', nodeOnlyIllustrationModule: true,
        lorebook: [
            { comment: '프리셋 P', content: '[Positive]\nmodule P\n[Negative]\n' },
            { comment: '프리셋 Q', content: '[Positive]\nq-style, {prompt}\n[Negative]\nbad' },
            { comment: 'light', content: 'Always soft light', nodeOnlyIllustration: true },
        ],
    })

    it('lists its presets while it is off, after the bot\'s own, and sends its 🎨 entries', async () => {
        const { character, chat } = setup({ enabled: true, preset: 'Q' })
        db.value.modules = [artModule()]
        expect(presetsFor(character, chat).map((p) => [p.name, p.source, p.positive])).toEqual([
            ['P', '봇', 'artist:a, {prompt}'],
            ['Q', '🎨 삽화', 'q-style, {prompt}'],
        ])
        requestChatData.mockResolvedValue({ type: 'success', result: JSON.stringify([scene(1)]) })
        generateAIImage.mockResolvedValue('data:image/png;base64,AAA')
        writeInlayImage.mockResolvedValue('inlay-1')
        expect(await run()).toBe(1)
        expect(requestChatData.mock.calls[0][0].formated[1].content).toContain('Always soft light')
        expect(generateAIImage.mock.calls[0].slice(0, 3)).toEqual(['q-style, cowboy shot, 1girl', character, 'bad'])
    })

    it('restores the old app-wide presets into it before the first drawing', async () => {
        setup({ enabled: true, preset: 'Old' })
        Object.assign(db.value, {
            modules: [], enabledModules: [], moduleActivationHistory: [],
            nodeOnlyIllustrationPresets: [{ id: 'o1', name: 'Old', positive: 'old-style', negative: 'old-neg' }],
        })
        requestChatData.mockResolvedValue({ type: 'success', result: JSON.stringify([scene(1)]) })
        generateAIImage.mockResolvedValue('data:image/png;base64,AAA')
        writeInlayImage.mockResolvedValue('inlay-1')
        expect(await run()).toBe(1)
        expect(generateAIImage.mock.calls[0].slice(2, 3)).toEqual(['old-neg'])
        expect(generateAIImage.mock.calls[0][0]).toBe('cowboy shot, 1girl, old-style')
        expect(db.value.modules).toHaveLength(1)
        expect(db.value.modules[0]).toMatchObject({ name: '🎨 삽화', nodeOnlyIllustrationModule: true })
        expect(db.value.nodeOnlyIllustrationPresetsRestored).toBe(true)
    })
})

describe('drawing the illustrations of a reply', () => {
    it('asks for scenes with the 🎨 entries, draws them with the preset and puts each after its line', async () => {
        const { character, reply } = setup({ enabled: true, preset: 'P', ratio: 'landscape', count: '1-2' })
        requestChatData.mockResolvedValue({ type: 'success', result: JSON.stringify([scene(1)]) })
        generateAIImage.mockResolvedValue('data:image/png;base64,AAA')
        writeInlayImage.mockResolvedValue('inlay-1')

        expect(await run()).toBe(1)
        const [request, mode] = requestChatData.mock.calls[0]
        expect(mode).toBe('otherAx')
        const prompt = request.formated[1].content
        expect(prompt).toContain('Maah: silver hair')
        expect(prompt).not.toContain('artist:a')
        expect(prompt).toContain('A demon princess.')
        // Only the entries the reply names (2026-10-28): "Hello" wakes Rin; the
        // always-on world entry, keyed to a castle the reply never names, stays out.
        expect(prompt).toContain('# Lorebook (world and character information)\nRin: black hair, red eyes\n')
        expect(prompt).not.toContain('The world')
        expect(generateAIImage).toHaveBeenCalledWith('artist:a, cowboy shot, 1girl', character, 'lowres', 'inlay', {
            width: 1216, height: 832, characters: [{ positive: 'silver hair', negative: '' }], nai: { steps: 20 },
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

    it('starts on its own only when the bot draws after every reply and the reply has no pictures', async () => {
        // The lorebook is read first, so the request goes out a moment later.
        const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
        const { character, chat, reply } = setup({ enabled: true, trigger: 'button' })
        requestChatData.mockResolvedValue({ type: 'success', result: '[]' })
        startAutoIllustration({ character, chat })
        await settle()
        expect(requestChatData).not.toHaveBeenCalled()
        character.nodeOnlyIllustration = { enabled: true }
        reply.nodeOnlyIllustrations = { x: { positive: '', negative: '', characters: [] } }
        startAutoIllustration({ character, chat })
        await settle()
        expect(requestChatData).not.toHaveBeenCalled()
        delete reply.nodeOnlyIllustrations
        startAutoIllustration({ character, chat })
        await settle()
        expect(requestChatData).toHaveBeenCalledTimes(1)
    })
})

// ⚙ "로어북" and "참고할 앞 메시지 수" (the user's toggle, 2026-10-28).
describe('what lorebook and how many messages go along', () => {
    const prompt = () => requestChatData.mock.calls[0][0].formated[1].content as string

    it('scans the earlier messages it sends, and only those', async () => {
        const { character } = setup({ enabled: true })
        character.globalLore.push({ comment: 'kai', key: 'hi', content: 'Kai: green coat' })
        requestChatData.mockResolvedValue({ type: 'success', result: '[]' })
        await run()
        expect(prompt()).toContain('Kai: green coat')
        expect(prompt()).toContain('User: Hi')
        expect(loadLoreBookV3Prompt).not.toHaveBeenCalled()

        requestChatData.mockReset()
        character.nodeOnlyIllustration = { enabled: true, contextCount: 0 }
        requestChatData.mockResolvedValue({ type: 'success', result: '[]' })
        await run()
        expect(prompt()).not.toContain('Kai: green coat')
        expect(prompt()).not.toContain('# Earlier in the chat')
    })

    it('sends every active entry, as the main model gets them, when asked', async () => {
        const { character } = setup({ enabled: true, lore: 'all' })
        loadLoreBookV3Prompt.mockResolvedValueOnce({ actives: [{ prompt: 'The world', role: 'system' }, { prompt: ' ', role: 'system' }] })
        requestChatData.mockResolvedValue({ type: 'success', result: '[]' })
        await run()
        expect(loadLoreBookV3Prompt.mock.calls.at(-1)?.[0]).toMatchObject({ character, chat: character.chats[0] })
        expect(prompt()).toContain('# Lorebook (world and character information)\nThe world\n')
        expect(prompt()).not.toContain('Rin: black hair')
    })

    // The illustration author's notes (2026-10-28): every bot's, then this bot's;
    // the chat's own author's note never.
    it('carries the common illustration note before the bot\'s own', async () => {
        const { chat } = setup({ enabled: true, direction: 'faces first' })
        db.value.nodeOnlyIllustrationNote = 'soft colors'
        chat.note = 'the chat note'
        requestChatData.mockResolvedValue({ type: 'success', result: '[]' })
        await run()
        expect(prompt()).toContain('# Directions\nsoft colors\n\nfaces first\n')
        expect(prompt()).not.toContain('the chat note')
    })
})
