import { describe, expect, test } from 'vitest'
import { formatImportedDate } from './importedDate'

describe('formatImportedDate', () => {
    test('formats yy.mm.dd in local time', () => {
        expect(formatImportedDate(new Date(2026, 8, 5, 13, 30).getTime())).toBe('26.09.05')
        expect(formatImportedDate(new Date(2031, 11, 31).getTime())).toBe('31.12.31')
    })

    test('cards without a date, or with an invalid one, show nothing', () => {
        expect(formatImportedDate(undefined)).toBe('')
        expect(formatImportedDate(null)).toBe('')
        expect(formatImportedDate(0)).toBe('')
        expect(formatImportedDate(Number.NaN)).toBe('')
    })
})
