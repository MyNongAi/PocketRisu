import { createSign } from 'node:crypto'
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

export function buildServiceAccountAssertion(input: BuildAssertionInput): JwtParts {
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
    const signature = signRs256(signingInput, input.serviceAccount.privateKey)
    return {
        header,
        payload,
        signingInput,
        signature,
        assertion: `${signingInput}.${signature}`,
    }
}

function signRs256(signingInput: string, pemPrivateKey: string): string {
    try {
        const signer = createSign('RSA-SHA256')
        signer.update(signingInput)
        signer.end()
        const sig = signer.sign(pemPrivateKey)
        return toBase64Url(sig)
    } catch (err) {
        throw new ModelPresetAdapterError(
            'invalid-request',
            'Failed to sign service account JWT with provided private key',
            { retryable: false, fallbackEligible: false, cause: err },
        )
    }
}

function base64UrlJson(value: unknown): string {
    return toBase64Url(Buffer.from(JSON.stringify(value), 'utf8'))
}

function toBase64Url(input: Buffer): string {
    return input.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_')
}

export function decodeJwtPayloadForTest(assertion: string): unknown {
    const segments = assertion.split('.')
    if (segments.length !== 3) throw new Error('not a JWT')
    const padded = segments[1] + '='.repeat((4 - (segments[1].length % 4)) % 4)
    const json = Buffer.from(padded.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString(
        'utf8',
    )
    return JSON.parse(json)
}

export function decodeJwtHeaderForTest(assertion: string): unknown {
    const segments = assertion.split('.')
    if (segments.length !== 3) throw new Error('not a JWT')
    const padded = segments[0] + '='.repeat((4 - (segments[0].length % 4)) % 4)
    const json = Buffer.from(padded.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString(
        'utf8',
    )
    return JSON.parse(json)
}
