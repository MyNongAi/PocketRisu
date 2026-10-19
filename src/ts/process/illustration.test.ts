import { describe, expect, it } from 'vitest'
import {
    buildScenePrompt,
    collectLightboardPresets,
    composeImagePrompt,
    countRange,
    illustrationSettings,
    insertSceneLines,
    parseLightboardPreset,
    parseScenes,
    ratioSize,
    replaceReplyLine,
    replaceReplyText,
} from './illustration'

describe('illustration settings', () => {
    it('fills in what is missing or unknown', () => {
        expect(illustrationSettings(undefined)).toEqual({ enabled: false, trigger: 'auto', count: '0-1', ratio: 'portrait', presetId: undefined })
        expect(illustrationSettings({ enabled: true, trigger: 'button', count: '1-3', ratio: 'square', presetId: 'p' }))
            .toEqual({ enabled: true, trigger: 'button', count: '1-3', ratio: 'square', presetId: 'p' })
        expect(illustrationSettings({ count: 'many' as any, ratio: 'wide' as any }).count).toBe('0-1')
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

    it('reads Lightboard presets, once each, without the ones already listed', () => {
        const content = 'https://arca.live/x\n\n[Positive]\n{prompt}, artist:a\n\n[Negative]\nlowres'
        expect(parseLightboardPreset('프리셋 도트', content)).toEqual({ name: '도트', positive: '{prompt}, artist:a', negative: 'lowres' })
        expect(parseLightboardPreset('lb-xnai.lb', content)).toBeNull()
        expect(parseLightboardPreset('프리셋 빈', 'no sections')).toBeNull()
        const books = [[{ comment: '프리셋 도트', content }, { comment: '프리셋 1', content: '[Positive]\nx' }], [{ comment: '프리셋 도트', content }]]
        expect(collectLightboardPresets(books, []).map((p) => p.name)).toEqual(['도트', '1'])
        expect(collectLightboardPresets(books, [{ name: '도트', positive: '{prompt}, artist:a' }]).map((p) => p.name)).toEqual(['1'])
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
