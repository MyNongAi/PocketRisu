const SHA256_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, amount: number): number {
    return (value >>> amount) | (value << (32 - amount))
}

/**
 * Constant-memory SHA-256 for insecure browser contexts where SubtleCrypto is
 * hidden. It deliberately hashes the input in-place instead of constructing a
 * second padded buffer, which keeps collection verification viable on phones.
 */
export function sha256BytesPortable(input: Uint8Array): Uint8Array {
    let h0 = 0x6a09e667
    let h1 = 0xbb67ae85
    let h2 = 0x3c6ef372
    let h3 = 0xa54ff53a
    let h4 = 0x510e527f
    let h5 = 0x9b05688c
    let h6 = 0x1f83d9ab
    let h7 = 0x5be0cd19
    const schedule = new Uint32Array(64)
    const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64
    const bitLength = input.byteLength * 8
    const bitLengthHigh = Math.floor(bitLength / 0x1_0000_0000) >>> 0
    const bitLengthLow = bitLength >>> 0

    const paddedByte = (index: number): number => {
        if (index < input.byteLength) return input[index]
        if (index === input.byteLength) return 0x80
        if (index < paddedLength - 8) return 0
        const fromEnd = paddedLength - 1 - index
        if (fromEnd < 4) return (bitLengthLow >>> (fromEnd * 8)) & 0xff
        return (bitLengthHigh >>> ((fromEnd - 4) * 8)) & 0xff
    }

    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let word = 0; word < 16; word++) {
            const index = offset + (word * 4)
            schedule[word] = (
                (paddedByte(index) << 24) |
                (paddedByte(index + 1) << 16) |
                (paddedByte(index + 2) << 8) |
                paddedByte(index + 3)
            ) >>> 0
        }
        for (let word = 16; word < 64; word++) {
            const x = schedule[word - 15]
            const y = schedule[word - 2]
            const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)
            const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)
            schedule[word] = (schedule[word - 16] + sigma0 + schedule[word - 7] + sigma1) >>> 0
        }

        let a = h0
        let b = h1
        let c = h2
        let d = h3
        let e = h4
        let f = h5
        let g = h6
        let h = h7
        for (let round = 0; round < 64; round++) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
            const choose = (e & f) ^ (~e & g)
            const temp1 = (h + sum1 + choose + SHA256_CONSTANTS[round] + schedule[round]) >>> 0
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
            const majority = (a & b) ^ (a & c) ^ (b & c)
            const temp2 = (sum0 + majority) >>> 0
            h = g
            g = f
            f = e
            e = (d + temp1) >>> 0
            d = c
            c = b
            b = a
            a = (temp1 + temp2) >>> 0
        }
        h0 = (h0 + a) >>> 0
        h1 = (h1 + b) >>> 0
        h2 = (h2 + c) >>> 0
        h3 = (h3 + d) >>> 0
        h4 = (h4 + e) >>> 0
        h5 = (h5 + f) >>> 0
        h6 = (h6 + g) >>> 0
        h7 = (h7 + h) >>> 0
    }

    const output = new Uint8Array(32)
    const view = new DataView(output.buffer)
    ;[h0, h1, h2, h3, h4, h5, h6, h7].forEach((value, index) => view.setUint32(index * 4, value))
    return output
}

export function sha256HexPortable(input: Uint8Array): string {
    return Array.from(sha256BytesPortable(input), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** HMAC-SHA-256 for browser contexts where SubtleCrypto is unavailable. */
export function hmacSha256Portable(key: Uint8Array, input: Uint8Array): Uint8Array {
    if (!(key instanceof Uint8Array) || !(input instanceof Uint8Array)) {
        throw new TypeError('HMAC key and input must be Uint8Array values')
    }
    if (key.byteLength > 1024 * 1024 || input.byteLength > 64 * 1024 * 1024) {
        throw new Error('Portable HMAC input exceeds the safety limit')
    }

    const block = new Uint8Array(64)
    const normalizedKey = key.byteLength > block.byteLength ? sha256BytesPortable(key) : key
    block.set(normalizedKey)
    const inner = new Uint8Array(block.byteLength + input.byteLength)
    const outer = new Uint8Array(block.byteLength + 32)
    for (let index = 0; index < block.byteLength; index++) {
        inner[index] = block[index] ^ 0x36
        outer[index] = block[index] ^ 0x5c
    }
    inner.set(input, block.byteLength)
    outer.set(sha256BytesPortable(inner), block.byteLength)
    return sha256BytesPortable(outer)
}

type DerElement = {
    tag: number
    bodyStart: number
    bodyEnd: number
    nextOffset: number
}

function readDerElement(input: Uint8Array, offset: number, expectedTag?: number): DerElement {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 2 > input.byteLength) {
        throw new Error('Invalid PKCS#8 DER offset')
    }
    const tag = input[offset++]
    if (expectedTag !== undefined && tag !== expectedTag) {
        throw new Error(`Invalid PKCS#8 DER tag: expected ${expectedTag}, received ${tag}`)
    }
    const firstLength = input[offset++]
    let length = firstLength
    if ((firstLength & 0x80) !== 0) {
        const count = firstLength & 0x7f
        if (count === 0 || count > 4 || offset + count > input.byteLength) {
            throw new Error('Unsupported PKCS#8 DER length')
        }
        length = 0
        for (let index = 0; index < count; index++) length = (length * 256) + input[offset++]
    }
    const bodyStart = offset
    const bodyEnd = bodyStart + length
    if (!Number.isSafeInteger(bodyEnd) || bodyEnd > input.byteLength) {
        throw new Error('Truncated PKCS#8 DER value')
    }
    return { tag, bodyStart, bodyEnd, nextOffset: bodyEnd }
}

function positiveDerInteger(input: Uint8Array, element: DerElement): Uint8Array {
    if (element.tag !== 0x02 || element.bodyStart >= element.bodyEnd) {
        throw new Error('Invalid RSA private-key integer')
    }
    let start = element.bodyStart
    if ((input[start] & 0x80) !== 0) throw new Error('Negative RSA private-key integer')
    if (input[start] === 0 && start + 1 < element.bodyEnd) start++
    return input.subarray(start, element.bodyEnd)
}

function bytesToBigInt(input: Uint8Array): bigint {
    let result = 0n
    for (const byte of input) result = (result << 8n) | BigInt(byte)
    return result
}

function bigIntToFixedBytes(value: bigint, byteLength: number): Uint8Array {
    if (value < 0n) throw new Error('Cannot encode a negative RSA value')
    const output = new Uint8Array(byteLength)
    for (let index = byteLength - 1; index >= 0; index--) {
        output[index] = Number(value & 0xffn)
        value >>= 8n
    }
    if (value !== 0n) throw new Error('RSA signature exceeds the modulus size')
    return output
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
    if (modulus <= 1n || exponent <= 0n) throw new Error('Invalid RSA private key')
    let result = 1n
    base %= modulus
    while (exponent > 0n) {
        if ((exponent & 1n) === 1n) result = (result * base) % modulus
        exponent >>= 1n
        if (exponent > 0n) base = (base * base) % modulus
    }
    return result
}

export type PortableRsaPrivateKey = {
    modulus: bigint
    privateExponent: bigint
    byteLength: number
}

/**
 * Parses the RSA modulus/private exponent from a PKCS#8 rsaEncryption key.
 * The returned BigInts remain only in the calling page's memory.
 */
export function parseRsaPrivateKeyPkcs8Portable(input: Uint8Array): PortableRsaPrivateKey {
    if (!(input instanceof Uint8Array) || input.byteLength < 64 || input.byteLength > 32 * 1024) {
        throw new Error('Invalid PKCS#8 RSA private-key size')
    }
    const outer = readDerElement(input, 0, 0x30)
    if (outer.nextOffset !== input.byteLength) throw new Error('Trailing PKCS#8 DER data')
    let outerOffset = outer.bodyStart
    outerOffset = readDerElement(input, outerOffset, 0x02).nextOffset
    const algorithm = readDerElement(input, outerOffset, 0x30)
    outerOffset = algorithm.nextOffset
    const algorithmOid = readDerElement(input, algorithm.bodyStart, 0x06)
    const rsaEncryptionOid = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]
    const oid = input.subarray(algorithmOid.bodyStart, algorithmOid.bodyEnd)
    if (oid.length !== rsaEncryptionOid.length || oid.some((byte, index) => byte !== rsaEncryptionOid[index])) {
        throw new Error('PKCS#8 key is not an rsaEncryption private key')
    }
    const privateKeyOctets = readDerElement(input, outerOffset, 0x04)
    const rsaKey = readDerElement(input, privateKeyOctets.bodyStart, 0x30)
    if (rsaKey.nextOffset !== privateKeyOctets.bodyEnd) throw new Error('Invalid embedded RSA private key')

    let rsaOffset = rsaKey.bodyStart
    rsaOffset = readDerElement(input, rsaOffset, 0x02).nextOffset
    const modulusElement = readDerElement(input, rsaOffset, 0x02)
    rsaOffset = modulusElement.nextOffset
    rsaOffset = readDerElement(input, rsaOffset, 0x02).nextOffset // public exponent
    const privateExponentElement = readDerElement(input, rsaOffset, 0x02)
    const modulusBytes = positiveDerInteger(input, modulusElement)
    const privateExponentBytes = positiveDerInteger(input, privateExponentElement)
    if (modulusBytes.byteLength < 128 || modulusBytes.byteLength > 2048) {
        throw new Error('Portable RSA supports 1024-16384 bit keys')
    }
    const modulus = bytesToBigInt(modulusBytes)
    const privateExponent = bytesToBigInt(privateExponentBytes)
    if (modulus <= 1n || privateExponent <= 1n) throw new Error('Invalid RSA private key values')
    return { modulus, privateExponent, byteLength: modulusBytes.byteLength }
}

const SHA256_DIGEST_INFO_PREFIX = Uint8Array.from([
    0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01,
    0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
])

/** RSASSA-PKCS1-v1_5 with SHA-256 for insecure LAN browser contexts. */
export function signRsaPkcs1Sha256Portable(key: PortableRsaPrivateKey, input: Uint8Array): Uint8Array {
    if (!(input instanceof Uint8Array) || input.byteLength > 64 * 1024 * 1024) {
        throw new Error('Portable RSA input exceeds the safety limit')
    }
    const digest = sha256BytesPortable(input)
    const digestInfo = new Uint8Array(SHA256_DIGEST_INFO_PREFIX.byteLength + digest.byteLength)
    digestInfo.set(SHA256_DIGEST_INFO_PREFIX)
    digestInfo.set(digest, SHA256_DIGEST_INFO_PREFIX.byteLength)
    const paddingLength = key.byteLength - digestInfo.byteLength - 3
    if (paddingLength < 8) throw new Error('RSA modulus is too small for SHA-256')

    const encoded = new Uint8Array(key.byteLength)
    encoded[1] = 0x01
    encoded.fill(0xff, 2, 2 + paddingLength)
    encoded[2 + paddingLength] = 0
    encoded.set(digestInfo, 3 + paddingLength)
    const message = bytesToBigInt(encoded)
    if (message >= key.modulus) throw new Error('RSA encoded message exceeds the modulus')
    return bigIntToFixedBytes(modPow(message, key.privateExponent, key.modulus), key.byteLength)
}

let fallbackCounter = 0

function injectedPageSeed(): string | undefined {
    return (globalThis as typeof globalThis & {
        __POCKETRISU_PLUGIN_NONCE_SEED__?: string
    }).__POCKETRISU_PLUGIN_NONCE_SEED__
}

/**
 * Web Crypto is absent in some insecure LAN WebViews. Node mode injects a
 * fresh, server-generated 256-bit seed per page; SHA-256 counter expansion
 * turns that seed into independent bytes without ever falling back to
 * Math.random().
 */
export function secureRandomBytes(
    length: number,
    cryptoSource: Crypto | undefined = globalThis.crypto,
    pageSeed: string | undefined = injectedPageSeed(),
): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 1 || length > 64) {
        throw new Error('Secure random byte length must be an integer from 1 to 64')
    }
    const output = new Uint8Array(length)
    if (typeof cryptoSource?.getRandomValues === 'function') {
        cryptoSource.getRandomValues(output)
        return output
    }
    if (!/^[0-9a-f]{64}$/i.test(pageSeed ?? '')) {
        throw new Error('A cryptographically secure random source is unavailable')
    }

    const seed = new Uint8Array(32)
    for (let index = 0; index < seed.length; index++) {
        seed[index] = Number.parseInt(pageSeed!.slice(index * 2, (index * 2) + 2), 16)
    }
    let written = 0
    while (written < output.length) {
        fallbackCounter = (fallbackCounter + 1) >>> 0
        if (fallbackCounter === 0) fallbackCounter = 1
        const material = new Uint8Array(40)
        material.set(seed)
        // Domain separation ("PRIS") plus the monotonic counter.
        material.set([0x50, 0x52, 0x49, 0x53], 32)
        new DataView(material.buffer).setUint32(36, fallbackCounter)
        const block = sha256BytesPortable(material)
        const take = Math.min(block.length, output.length - written)
        output.set(block.subarray(0, take), written)
        written += take
    }
    return output
}
