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
