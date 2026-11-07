import { describe, expect, it } from 'vitest'
import { chatFileExtension } from './chatFileName'

describe('chatFileExtension (2026-11-08)', () => {
    it('reads an extension in any case', () => {
        expect(chatFileExtension('IMG_0001.JPG')).toBe('jpg')
        expect(chatFileExtension('screen.PNG')).toBe('png')
        expect(chatFileExtension('clip.Mp4')).toBe('mp4')
        expect(chatFileExtension('notes.TXT')).toBe('txt')
    })

    it('reads a JPEG\'s other names as jpeg, and leaves the rest', () => {
        expect(chatFileExtension('download.jfif')).toBe('jpeg')
        expect(chatFileExtension('a.JPE')).toBe('jpeg')
        expect(chatFileExtension('photo.heic')).toBe('heic')
        expect(chatFileExtension('no-extension')).toBe('')
        expect(chatFileExtension('archive.tar.gz')).toBe('gz')
    })
})
