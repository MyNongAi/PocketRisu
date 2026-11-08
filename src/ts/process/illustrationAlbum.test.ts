import { describe, expect, it } from 'vitest'
import {
    DEFAULT_SAMPLE_SCENE, chatPictures, inlayIdsOf, inlayThumbSrc, repliesWithoutPictures, sampleAssetName,
    samplePresetName, sampleScene, samplesByPreset,
} from './illustrationAlbum'

const prompt = { positive: 'p', negative: '', characters: [] }

describe('the pictures of a chat', () => {
    it('reads every kind of picture reference once, in order', () => {
        expect(inlayIdsOf('a {{inlay::x}} b {{inlayed::y}}\n{{inlayeddata::z}} {{inlay::x}}')).toEqual(['x', 'y', 'z'])
        expect(inlayIdsOf(undefined)).toEqual([])
    })

    it('lists the replies\' pictures newest first, once each, with the scene 🎨 drew them from', () => {
        const messages = [
            { role: 'user', data: '{{inlay::mine}}' },
            { role: 'char', data: 'a\n{{inlay::a1}}\nb\n{{inlay::a2}}', chatId: 'm1', nodeOnlyIllustrations: { a1: prompt } },
            { role: 'char', data: 'note {{inlay::c}}', isComment: true },
            null,
            { role: 'char', data: 'again {{inlay::a1}} and {{inlay::b1}}', chatId: 'm2' },
        ]
        expect(chatPictures(messages)).toEqual([
            { inlayId: 'b1', index: 4, messageId: 'm2' },
            { inlayId: 'a1', index: 4, messageId: 'm2' },
            { inlayId: 'a2', index: 1, messageId: 'm1' },
        ])
        expect(chatPictures([{ role: 'char', data: '{{inlay::a1}}', nodeOnlyIllustrations: { a1: prompt } }])[0].prompt).toBe(prompt)
    })

    it('finds the replies without a picture among the last ones, oldest first', () => {
        const messages = [
            { role: 'char', data: 'one' },
            { role: 'user', data: 'hi' },
            { role: 'char', data: 'two {{inlay::x}}' },
            { role: 'char', data: '   ' },
            { role: 'char', data: 'hidden', disabled: true },
            { role: 'char', data: 'three' },
            { role: 'char', data: 'four' },
        ]
        expect(repliesWithoutPictures(messages, 0)).toEqual([0, 5, 6])
        expect(repliesWithoutPictures(messages, 3)).toEqual([5, 6])
        expect(repliesWithoutPictures(undefined, 10)).toEqual([])
    })
})

describe('style samples', () => {
    it('names a sample after its preset and reads the name back', () => {
        expect(sampleAssetName('수채화')).toBe('🎨 샘플 · 수채화')
        expect(samplePresetName('🎨 샘플 · 수채화')).toBe('수채화')
        expect(samplePresetName('🎨 샘플 · ')).toBeNull()
        expect(samplePresetName('smile')).toBeNull()
    })

    it('keeps one sample per preset among the module\'s assets', () => {
        const samples = samplesByPreset([
            ['smile', 'assets/a.png', 'png'],
            ['🎨 샘플 · A', 'assets/1.png', 'png'],
            null,
            ['🎨 샘플 · A', 'assets/2.png', 'png'],
            ['🎨 샘플 · B', 'assets/3.webp', 'webp'],
        ])
        expect([...samples.entries()]).toEqual([
            ['A', { path: 'assets/2.png', ext: 'png', index: 3 }],
            ['B', { path: 'assets/3.webp', ext: 'webp', index: 4 }],
        ])
    })

    it('draws every sample from the same scene, the default one when none is set', () => {
        expect(sampleScene('  ')).toEqual({ line: 0, camera: '', scene: DEFAULT_SAMPLE_SCENE, characters: [] })
        expect(sampleScene(' 1boy, running ').scene).toBe('1boy, running')
    })

    it('points at the thumbnail the server keeps', () => {
        expect(inlayThumbSrc('ab')).toBe(`/api/asset/${Buffer.from('inlay_thumb/ab', 'utf-8').toString('hex')}`)
    })
})
