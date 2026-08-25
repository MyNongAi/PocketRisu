import { describe, expect, it, vi } from 'vitest'
import { createPluginSecureRandomBytes, createSandboxNonce } from './factory'

describe('createSandboxNonce', () => {
    it('uses randomUUID when the browser exposes it', () => {
        const randomUUID = vi.fn(() => 'mobile-safe-uuid')
        const getRandomValues = vi.fn()

        const nonce = createSandboxNonce({ randomUUID, getRandomValues } as unknown as Crypto)

        expect(nonce).toBe('mobile-safe-uuid')
        expect(randomUUID).toHaveBeenCalledOnce()
        expect(getRandomValues).not.toHaveBeenCalled()
    })

    it('uses secure random bytes when randomUUID is unavailable on LAN HTTP', () => {
        const getRandomValues = vi.fn((bytes: Uint8Array) => {
            bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 255])
            return bytes
        })

        const nonce = createSandboxNonce({ getRandomValues } as unknown as Crypto)

        expect(nonce).toBe('000102030405060708090a0b0c0d0eff')
        expect(getRandomValues).toHaveBeenCalledOnce()
    })

    it('uses the server page seed when an insecure WebView hides Web Crypto entirely', () => {
        const seed = 'ab'.repeat(32)
        const first = createSandboxNonce({} as Crypto, seed)
        const second = createSandboxNonce({} as Crypto, seed)

        expect(first).toMatch(new RegExp(`^${seed}[0-9a-f]{8}$`))
        expect(second).toMatch(new RegExp(`^${seed}[0-9a-f]{8}$`))
        expect(second).not.toBe(first)
    })

    it('does not weaken the CSP nonce when no secure random source exists', () => {
        expect(() => createSandboxNonce({} as Crypto, undefined)).toThrow(
            'A cryptographically secure random source is required for the plugin sandbox.',
        )
    })

    it('bridges server-seeded CSPRNG bytes into a no-WebCrypto plugin iframe', () => {
        const seed = 'cd'.repeat(32)
        const first = createPluginSecureRandomBytes(16, {} as Crypto, seed)
        const second = createPluginSecureRandomBytes(16, {} as Crypto, seed)

        expect(first).toHaveLength(16)
        expect(second).toHaveLength(16)
        expect(first).not.toEqual(second)
        expect(first.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)).toBe(true)
    })
})
