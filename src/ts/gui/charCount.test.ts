import { describe, expect, it } from 'vitest'
import { countChars } from './charCount'

describe('countChars', () => {
    it('counts spaces only in the count with spaces', () => {
        expect(countChars('안녕 하세요')).toEqual({ noSpace: 5, withSpace: 6 })
    })

    it('leaves line breaks out of both counts', () => {
        expect(countChars('가나\n다\r\n라')).toEqual({ noSpace: 4, withSpace: 4 })
    })

    it('treats tabs and wide spaces as spaces', () => {
        expect(countChars('a\tb　c d')).toEqual({ noSpace: 4, withSpace: 7 })
    })

    it('counts an emoji once', () => {
        expect(countChars('😀 a')).toEqual({ noSpace: 2, withSpace: 3 })
    })

    it('counts nothing in an empty entry', () => {
        expect(countChars('')).toEqual({ noSpace: 0, withSpace: 0 })
        expect(countChars(undefined as unknown as string)).toEqual({ noSpace: 0, withSpace: 0 })
    })
})
