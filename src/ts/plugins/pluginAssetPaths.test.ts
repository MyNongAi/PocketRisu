import { describe, expect, test } from 'vitest'
import { normalizePluginAssetReadPath } from './pluginAssetPaths'

describe('plugin asset reads', () => {
    test('accepts ordinary and strict external asset references', () => {
        expect(normalizePluginAssetReadPath('assets/abc.png')).toBe('assets/abc.png')
        expect(normalizePluginAssetReadPath('abc.png')).toBe('assets/abc.png')
        expect(normalizePluginAssetReadPath(`external://local/${'A'.repeat(64)}`)).toBe(`external://local/${'a'.repeat(64)}`)
    })
    test.each(['assets/../database/database.bin', 'C:\\secret', '/etc/passwd', 'external://local/not-a-hash', 'external://../' + 'a'.repeat(64), 'assets/\u0000x', '..', ''])('rejects unsupported or traversing path %s', path => {
        expect(() => normalizePluginAssetReadPath(path)).toThrow()
    })
})
