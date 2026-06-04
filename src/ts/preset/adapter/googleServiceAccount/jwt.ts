import { ModelPresetAdapterError } from '../error'
import type { ParsedServiceAccount } from './serviceAccount'

export const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

const JWT_TTL_SECONDS = 3600

export interface BuildAssertionInput {
    serviceAccount: ParsedServiceAccount
    scope?: string
    now?: () => number
}

export interface JwtParts {
    header: { alg: 'RS256'; typ: 'JWT'; kid?: string }
    payload: {
        iss: string
        scope: string
        aud: string
        iat: number
        exp: number
    }
    signingInput: string
    signature: string
    assertion: string
}

export async function buildServiceAccountAssertion(input: BuildAssertionInput): Promise<JwtParts> {
    const scope = input.scope && input.scope.length > 0 ? input.scope : DEFAULT_SCOPE
    const nowMs = (input.now ?? Date.now)()
    const iat = Math.floor(nowMs / 1000)
    const exp = iat + JWT_TTL_SECONDS

    const header: JwtParts['header'] = { alg: 'RS256', typ: 'JWT' }
    if (input.serviceAccount.privateKeyId) {
        header.kid = input.serviceAccount.privateKeyId
    }
    const payload: JwtParts['payload'] = {
        iss: input.serviceAccount.clientEmail,
        scope,
        aud: input.serviceAccount.tokenUri,
        iat,
        exp,
    }

    const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`
    const signature = await signRs256(signingInput, input.serviceAccount.privateKey)
    return {
        header,
        payload,
        signingInput,
        signature,
        assertion: `${signingInput}.${signature}`,
    }
}

// Signs with the Web Crypto API (RSASSA-PKCS1-v1_5 + SHA-256 is exactly RS256)
// rather than node:crypto. The request pipeline runs in the browser bundle, and
// `node:crypto` is externalized there, so a node-only signer would throw at
// runtime for Vertex / google-service-account presets. `globalThis.crypto.subtle`,
// `TextEncoder`, and `atob`/`btoa` are available in both the browser and Node 16+.
async function signRs256(signingInput: string, pemPrivateKey: string): Promise<string> {
    try {
        const subtle = globalThis.crypto?.subtle
        if (!subtle) {
            throw new Error('Web Crypto subtle API is unavailable in this environment')
        }
        const key = await subtle.importKey(
            'pkcs8',
            bytesToArrayBuffer(pemToDer(pemPrivateKey)),
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['sign'],
        )
        const sig = await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput))
        return bytesToBase64Url(new Uint8Array(sig))
    } catch (err) {
        if (err instanceof ModelPresetAdapterError) throw err
        throw new ModelPresetAdapterError(
            'invalid-request',
            'Failed to sign service account JWT with provided private key',
            { retryable: false, fallbackEligible: false, cause: err },
        )
    }
}

function pemToDer(pem: string): Uint8Array {
    const body = pem
        .replace(/-----BEGIN [^-]+-----/gu, '')
        .replace(/-----END [^-]+-----/gu, '')
        .replace(/\s+/gu, '')
    if (body.length === 0) throw new Error('PEM body is empty')
    return base64ToBytes(body)
}

function base64UrlJson(value: unknown): string {
    return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)))
}

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary).replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_')
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function decodeJwtPayloadForTest(assertion: string): unknown {
    return decodeSegmentForTest(assertion, 1)
}

export function decodeJwtHeaderForTest(assertion: string): unknown {
    return decodeSegmentForTest(assertion, 0)
}

function decodeSegmentForTest(assertion: string, index: number): unknown {
    const segments = assertion.split('.')
    if (segments.length !== 3) throw new Error('not a JWT')
    const seg = segments[index]
    const padded = seg.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (seg.length % 4)) % 4)
    return JSON.parse(new TextDecoder().decode(base64ToBytes(padded)))
}
