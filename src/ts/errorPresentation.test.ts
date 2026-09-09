import { describe, expect, it } from 'vitest'
import { formatErrorCopyText, localizeErrorMessage } from './errorPresentation'

describe('error presentation', () => {
    it('localizes a per-chat busy lease while preserving the original', () => {
        const result = localizeErrorMessage(
            'This chat is still generating on another page or device. Try again in up to 113 seconds.',
            'ko-KR',
        )
        expect(result.message).toContain('최대 113초')
        expect(result.original).toContain('another page or device')
    })

    it('localizes a nested save conflict', () => {
        const result = localizeErrorMessage(
            'Failed to save 1 chat: Chat changed on another device',
            'ko',
        )
        expect(result.message).toContain('채팅 1개')
        expect(result.message).toContain('다른 페이지나 기기')
    })

    it('extracts Realm JSON errors for a useful Korean summary', () => {
        const original = '{"error":"Not Found","message":"Card not found, probably the card is still uploading"}'
        const result = localizeErrorMessage(original, 'ko')
        expect(result.message).toContain('RisuRealm')
        expect(result.original).toBe(original)
    })

    it('keeps English UI unchanged', () => {
        const original = 'Chat no longer exists on the server'
        expect(localizeErrorMessage(original, 'en')).toEqual({ message: original })
    })

    it('builds a copyable report with Korean, original and details', () => {
        const presentation = localizeErrorMessage('request entity too large', 'ko')
        const report = formatErrorCopyText(presentation, 'HTTP 413')
        expect(report).toContain('허용 크기')
        expect(report).toContain('[원문] request entity too large')
        expect(report).toContain('HTTP 413')
    })
})
