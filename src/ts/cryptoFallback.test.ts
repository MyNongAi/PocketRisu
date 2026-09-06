import { createHash, createHmac, generateKeyPairSync, sign, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
    hmacSha256Portable,
    parseRsaPrivateKeyPkcs8Portable,
    secureRandomBytes,
    sha256HexPortable,
    signRsaPkcs1Sha256Portable,
} from './cryptoFallback'

describe('portable browser crypto fallbacks', () => {
    it('matches standard SHA-256 vectors without allocating a padded copy', () => {
        expect(sha256HexPortable(new TextEncoder().encode('abc'))).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        )
        expect(sha256HexPortable(new Uint8Array())).toBe(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        )
        for (const length of [55, 56, 63, 64, 65, 1024]) {
            const bytes = Uint8Array.from({ length }, (_, index) => (index * 31) & 0xff)
            expect(sha256HexPortable(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'))
        }
    })

    it('expands a server CSPRNG seed when an insecure browser has no Web Crypto', () => {
        const seed = 'ab'.repeat(32)
        const first = secureRandomBytes(32, {} as Crypto, seed)
        const second = secureRandomBytes(32, {} as Crypto, seed)

        expect(first).toHaveLength(32)
        expect(second).toHaveLength(32)
        expect(first).not.toEqual(second)
        expect(() => secureRandomBytes(16, {} as Crypto, undefined)).toThrow(/secure random source/i)
    })

    it('matches Node HMAC-SHA-256 without SubtleCrypto', () => {
        const key = new TextEncoder().encode('portable-lan-secret')
        const input = new TextEncoder().encode('PocketRisu provider request')
        const expected = createHmac('sha256', key).update(input).digest('hex')

        expect(Buffer.from(hmacSha256Portable(key, input)).toString('hex')).toBe(expected)
    })

    it('parses PKCS#8 and produces a valid RS256 signature without SubtleCrypto', () => {
        const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
        const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' })
        const input = new TextEncoder().encode('header.claim')
        const portableKey = parseRsaPrivateKeyPkcs8Portable(new Uint8Array(pkcs8))
        const signature = signRsaPkcs1Sha256Portable(portableKey, input)

        expect(signature).toHaveLength(256)
        expect(verify('RSA-SHA256', input, publicKey, signature)).toBe(true)
        expect(sign('RSA-SHA256', input, privateKey)).toHaveLength(256)
    })
})
