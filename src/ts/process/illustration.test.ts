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
    presetNaiText,
    presetSectionsOf,
    ratioSize,
    replaceReplyLine,
    replaceReplyText,
    setNaiLine,
    withPresetNai,
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

    // Like Lightboard's illustrations (2026-10-28): the lorebook entries on now
    // and the author's note, before the 🎨 rules.
    it('carries the lorebook entries on now and the author\'s note', () => {
        const base = { lines: ['a'], rules: ['soft light'], context: [], character: { name: 'M', description: '' }, user: { name: 'U', description: '' }, count: '1' as const }
        const user = buildScenePrompt({ ...base, lore: ['Rin: black hair', ' ', 'The castle'], authorsNote: 'Rainy night.' })[1].content
        expect(user).toContain('# Lorebook (world and character information)\nRin: black hair\n\n---\n\nThe castle\n\n# Author\'s note\nRainy night.\n\n# Rules\nsoft light')
        // Whole entries only, up to the cap; the rest are left out.
        const big = 'x'.repeat(20000)
        const capped = buildScenePrompt({ ...base, lore: [big, big, 'small'] })[1].content
        expect(capped.split(big).length - 1).toBe(1)
        expect(capped).not.toContain('small')
        expect(buildScenePrompt(base)[1].content).not.toContain('# Lorebook')
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

// The user's choice (2026-10-28): a preset is a lorebook folder with one entry
// per section; the sidebar writes NovelAI values (the model too) into its NAI.
describe('preset folders and their NAI', () => {
    const folder = [
        { key: 'F', mode: 'folder', comment: '프리셋 수채화' },
        { folder: 'F', comment: 'Positive', content: '{prompt}, watercolor' },
        { folder: 'F', comment: 'Negative', content: 'lowres' },
        { folder: 'F', comment: 'NAI', content: '# from an image\nmodel: V4.5 curated\nsteps: 28' },
        { folder: 'F', comment: 'notes', content: '[Positive] not this' },
        { comment: 'story', content: 'x' },
    ]

    it('reads a "프리셋 X" folder by its section entries, and says where it lives', () => {
        expect(lorebookPresets([{ label: '봇', entries: folder, target: { kind: 'bot' } }])).toEqual([{
            name: '수채화', positive: '{prompt}, watercolor', negative: 'lowres',
            nai: { model: 'nai-diffusion-4-5-curated', steps: 28 }, source: '봇',
            place: { target: { kind: 'bot' }, folder: 'F' },
        }])
        const single = lorebookPresets([{ label: 'm', entries: [{ comment: 'story' }, { comment: '프리셋 One', content: '[Positive]\nx' }], target: { kind: 'module', id: 'm1' } }])
        expect(single[0].place).toEqual({ target: { kind: 'module', id: 'm1' }, index: 1 })
    })

    it('takes a model only from the NovelAI list, by id or short name', () => {
        expect(parseNaiParams('model: nai-diffusion-3')).toEqual({ model: 'nai-diffusion-3' })
        expect(parseNaiParams('모델: V5 full')).toEqual({ model: 'nai-diffusion-5-full' })
        expect(parseNaiParams('model: sdxl')).toBeUndefined()
    })

    it('sets one value, keeping comments and the other lines', () => {
        const text = '# hint\n# steps: 28\nscale: 5\nsampler: k_euler'
        expect(setNaiLine(text, 'steps', 40)).toBe('# hint\nsteps: 40\nscale: 5\nsampler: k_euler')
        expect(setNaiLine(text, 'scale', 6.5)).toBe('# hint\n# steps: 28\nscale: 6.5\nsampler: k_euler')
        expect(setNaiLine(text, 'model', 'nai-diffusion-4-5-full')).toBe(`${text}\nmodel: nai-diffusion-4-5-full`)
        expect(setNaiLine('smea: off\nsteps: 1\nSMEA = on', 'sm', true)).toBe('smea: true\nsteps: 1')
        expect(setNaiLine(text, 'sampler', undefined)).toBe('# hint\n# steps: 28\nscale: 5')
        expect(setNaiLine('', 'variety', false)).toBe('variety: false')
        expect(parseNaiParams(setNaiLine(text, 'sm_dyn', true))).toEqual({ scale: 5, sampler: 'k_euler', sm_dyn: true })
    })

    it('rewrites the [NAI] section of a one-entry preset, or adds one', () => {
        const content = '[Positive]\na\n[NAI]\nsteps: 1\n[Negative]\nb'
        expect(presetNaiText(content)).toBe('steps: 1')
        const next = withPresetNai(content, 'steps: 2')
        expect(parsePresetEntry('프리셋 x', next)).toEqual({ name: 'x', positive: 'a', negative: 'b', nai: { steps: 2 } })
        expect(withPresetNai('[Positive]\na\n', 'scale: 3')).toBe('[Positive]\na\n\n[NAI]\nscale: 3')
    })

    it('splits a one-entry preset into the folder entries', () => {
        expect(presetSectionsOf('# from x.png\n[Author] artist:b\n[Quality] best\n[Negative] bad\n[NAI]\nsteps: 3')).toEqual({
            positive: 'artist:b, {prompt}, best', negative: 'bad', nai: '# from x.png\nsteps: 3',
        })
        expect(presetSectionsOf('no sections')).toBeNull()
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
