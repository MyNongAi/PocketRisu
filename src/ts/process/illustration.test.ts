import { describe, expect, it } from 'vitest'
import {
    buildScenePrompt,
    composeImagePrompt,
    countRange,
    illustrationSettings,
    insertSceneLines,
    lorebookPresets,
    parseNaiParams,
    parsePresetEntry,
    parseScenes,
    placeScenes,
    ratioSize,
    replaceReplyLine,
    replaceReplyText,
} from './illustration'

describe('illustration settings', () => {
    it('fills in what is missing or unknown', () => {
        expect(illustrationSettings(undefined)).toEqual({ enabled: false, trigger: 'auto', count: '0-1', ratio: 'portrait', position: 'auto', maxCharacters: 3, nsfw: false, direction: '', preset: undefined })
        expect(illustrationSettings({ enabled: true, trigger: 'button', count: '1-3', ratio: 'square', position: 'bottom', maxCharacters: 1, nsfw: true, direction: 'faces', preset: '도트' }))
            .toEqual({ enabled: true, trigger: 'button', count: '1-3', ratio: 'square', position: 'bottom', maxCharacters: 1, nsfw: true, direction: 'faces', preset: '도트' })
        expect(illustrationSettings({ count: 'many' as any, ratio: 'wide' as any, position: 'left' as any, maxCharacters: 9 }))
            .toMatchObject({ count: '0-1', ratio: 'portrait', position: 'auto', maxCharacters: 3 })
    })

    it('maps counts and ratios (sizes NovelAI draws free on Opus)', () => {
        expect(countRange('0-1')).toEqual({ min: 0, max: 1 })
        expect(countRange('1-2')).toEqual({ min: 1, max: 2 })
        for (const ratio of ['portrait', 'landscape', 'square'] as const) {
            const { width, height } = ratioSize(ratio)
            expect(width * height).toBeLessThanOrEqual(1024 * 1024)
        }
    })
})

describe('the scene request and answer', () => {
    it('asks with the characters, the rules, the context and the numbered reply', () => {
        const [system, user] = buildScenePrompt({
            lines: ['She draws her sword.', '"Run."'],
            rules: ['Maah: silver hair, red eyes'],
            context: [{ name: 'User', text: 'Who is there?' }],
            character: { name: 'Maah', description: 'A demon princess.' },
            user: { name: 'User', description: '' },
            count: '1-2',
        })
        expect(system.content).toContain('1 to 2 moment(s)')
        expect(user.content).toContain('## Maah\nA demon princess.')
        expect(user.content).not.toContain('(the user)')
        expect(user.content).toContain('# Rules\nMaah: silver hair, red eyes')
        expect(user.content).toContain('[1] She draws her sword.\n[2] "Run."')
    })

    it('says where the picture goes, how many characters, NSFW and the extra directions', () => {
        const base = { lines: ['a'], rules: [], context: [], character: { name: 'M', description: '' }, user: { name: 'U', description: '' }, count: '1' as const }
        const [system, user] = buildScenePrompt({ ...base, position: 'bottom', maxCharacters: 1, nsfw: false, direction: 'show the sea' })
        expect(system.content).toContain('at the end of the reply')
        expect(system.content).toContain('at most 1')
        expect(system.content).toContain('non-explicit')
        expect(user.content).toContain('# Directions\nshow the sea')
        expect(buildScenePrompt({ ...base, nsfw: true })[0].content).toContain('tagged explicitly')
    })

    it('puts every picture at a fixed place when asked', () => {
        const scenes = [{ line: 2 }, { line: 5 }]
        expect(placeScenes(scenes, 'auto', 6)).toEqual(scenes)
        expect(placeScenes(scenes, 'top', 6).map((s) => s.line)).toEqual([0, 0])
        expect(placeScenes(scenes, 'middle', 6).map((s) => s.line)).toEqual([3, 3])
        expect(placeScenes(scenes, 'bottom', 6).map((s) => s.line)).toEqual([6, 6])
    })

    it('reads the scenes and drops what does not fit', () => {
        const answer = '```json\n[' +
            '{"line": 1, "camera": "cowboy shot", "scene": "1girl, castle", "characters": [{"name": "Maah", "positive": "silver hair, holding sword", "negative": ""}]},' +
            '{"line": 9, "camera": "x"},' +
            '{"line": 2, "camera": "", "scene": "", "characters": []},' +
            '{"line": 2, "scene": "night", "characters": [{"name": "A", "positive": "a"},{"name": "B", "positive": "b"},{"name": "C", "positive": "c"},{"name": "D", "positive": "d"}]}' +
            ']\n```'
        const scenes = parseScenes(answer, 2, 5)
        expect(scenes).toHaveLength(2)
        expect(scenes[0]).toEqual({ line: 1, camera: 'cowboy shot', scene: '1girl, castle', characters: [{ name: 'Maah', positive: 'silver hair, holding sword', negative: '' }] })
        expect(scenes[1].characters.map((c) => c.name)).toEqual(['A', 'B', 'C'])
        expect(parseScenes(answer, 2, 1)).toHaveLength(1)
        expect(parseScenes('no scenes', 2, 1)).toEqual([])
    })
})

describe('the image prompt', () => {
    const scene = { line: 1, camera: 'cowboy shot', scene: '1girl, castle', characters: [{ name: 'Maah', positive: 'silver hair', negative: 'hat' }] }

    it('puts the scene where the preset says, or in front of it', () => {
        expect(composeImagePrompt({ positive: 'artist:a, {prompt}, best quality', negative: 'lowres' }, scene)).toEqual({
            positive: 'artist:a, cowboy shot, 1girl, castle, best quality',
            negative: 'lowres',
            characters: [{ positive: 'silver hair', negative: 'hat' }],
        })
        expect(composeImagePrompt({ positive: 'best quality', negative: '' }, scene).positive).toBe('cowboy shot, 1girl, castle, best quality')
        expect(composeImagePrompt(undefined, scene).positive).toBe('cowboy shot, 1girl, castle')
    })

    it('reads presets from "프리셋 X" lorebook entries, in both Lightboard formats', () => {
        const content = 'https://arca.live/x\n\n[Positive]\n{prompt}, artist:a\n\n[Negative]\nlowres'
        expect(parsePresetEntry('프리셋 도트', content)).toEqual({ name: '도트', positive: '{prompt}, artist:a', negative: 'lowres' })
        expect(parsePresetEntry('lb-xnai.lb', content)).toBeNull()
        expect(parsePresetEntry('프리셋 빈', 'no sections')).toBeNull()
        // Lightboard NAI: [Author] [Quality] [Negative], each section inline
        expect(parsePresetEntry('프리셋1', '[Author] artist:x, year 2025\n[Quality] best quality\n[Negative] lowres, censored')).toEqual({
            name: '1', positive: 'artist:x, year 2025, {prompt}, best quality', negative: 'lowres, censored',
        })
    })

    it('reads a preset own NovelAI values from its [NAI] section', () => {
        expect(parseNaiParams('# comment\nsteps: 23\nscale=5.5\nsampler: k_dpmpp_2m\nSMEA: on\nvariety+: false\nseed: 42\nunknown: 1')).toEqual({
            steps: 23, scale: 5.5, sampler: 'k_dpmpp_2m', sm: true, variety: false, seed: 42,
        })
        expect(parseNaiParams('# steps: 28')).toBeUndefined()
        const preset = parsePresetEntry('프리셋 빠른', '[Positive]\n{prompt}\n[NAI]\nsteps: 20')!
        expect(preset.nai).toEqual({ steps: 20 })
        const scene = { line: 1, camera: 'c', scene: 's', characters: [] }
        expect(composeImagePrompt(preset, scene).nai).toEqual({ steps: 20 })
    })

    it('lists the presets of the bot, the chat and the modules, the bot first', () => {
        const presets = lorebookPresets([
            { label: '봇', entries: [{ comment: '프리셋 도트', content: '[Positive]\nbot' }] },
            { label: '채팅', entries: undefined },
            { label: 'Lightboard', entries: [{ comment: '프리셋 도트', content: '[Positive]\nmodule' }, { comment: '프리셋 블아', content: '[Positive]\nba' }, { comment: 'lb-xnai.lb', content: 'x' }] },
        ])
        expect(presets.map((p) => [p.name, p.source, p.positive])).toEqual([['도트', '봇', 'bot'], ['블아', 'Lightboard', 'ba']])
    })
})

describe('placing the pictures', () => {
    it('inserts lines after the scenes\' lines, before the first for 0', () => {
        expect(insertSceneLines(['a', 'b'], [{ line: 2 }, { line: 0 }, { line: 1 }], (i) => `<${i}>`)).toEqual(['<1>', 'a', '<2>', 'b', '<0>'])
    })

    it('changes the reply where it shows, its swipe too', () => {
        const message = { data: 'old', swipes: ['first', 'old'] }
        expect(replaceReplyText(message, 'old', 'new')).toBe(true)
        expect(message).toEqual({ data: 'new', swipes: ['first', 'new'] })
        // shown elsewhere (another page): only the swipe holding it
        const held = { data: 'first', swipes: ['first', 'new'] }
        expect(replaceReplyText(held, 'new', 'newer')).toBe(true)
        expect(held).toEqual({ data: 'first', swipes: ['first', 'newer'] })
        expect(replaceReplyText(held, 'gone', 'x')).toBe(false)
    })

    it('replaces or takes out a whole line', () => {
        const message = { data: 'a\n[🎨 1]\nb', swipes: ['a\n[🎨 1]\nb'] }
        expect(replaceReplyLine(message, '[🎨 1]', '{{inlay::x}}')).toBe(true)
        expect(message.data).toBe('a\n{{inlay::x}}\nb')
        expect(message.swipes[0]).toBe('a\n{{inlay::x}}\nb')
        expect(replaceReplyLine(message, '{{inlay::x}}', null)).toBe(true)
        expect(message.data).toBe('a\nb')
        expect(replaceReplyLine(message, 'missing', null)).toBe(false)
    })
})
