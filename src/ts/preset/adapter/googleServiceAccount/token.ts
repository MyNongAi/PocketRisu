import {
    extractErrorMessage,
    ModelPresetAdapterError,
    normalizeFetchError,
    normalizeHttpStatus,
} from '../error'
import { buildServiceAccountAssertion, DEFAULT_SCOPE } from './jwt'
import type { ParsedServiceAccount } from './serviceAccount'

const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

export interface ExchangeServiceAccountInput {
    serviceAccount: ParsedServiceAccount
    scope?: string
    now?: () => number
    fetchImpl?: typeof fetch
    abortSignal?: AbortSignal
}

export interface AccessTokenResult {
    accessToken: string
    tokenType: string
    expiresInSeconds: number
    issuedAtMs: number
}

export async function exchangeServiceAccountForAccessToken(
    input: ExchangeServiceAccountInput,
): Promise<AccessTokenResult> {
    const now = input.now ?? Date.now
    const issuedAtMs = now()
    const scope = input.scope && input.scope.length > 0 ? input.scope : DEFAULT_SCOPE

    const jwt = await buildServiceAccountAssertion({
        serviceAccount: input.serviceAccount,
        scope,
        now,
    })

    const body = new URLSearchParams({
        grant_type: JWT_BEARER_GRANT,
        assertion: jwt.assertion,
    }).toString()

    const fetchImpl = input.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
        throw new ModelPresetAdapterError(
            'unsupported',
            'No fetch implementation available for OAuth token exchange',
            { retryable: false, fallbackEligible: false },
        )
    }

    let response: Response
    try {
        response = await fetchImpl(input.serviceAccount.tokenUri, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body,
            signal: input.abortSignal,
        })
    } catch (err) {
        throw normalizeFetchError(err)
    }

    const bodyText = await response.text().catch(() => '')

    const httpError = normalizeHttpStatus(
        response.status,
        extractErrorMessage(bodyText) ?? `HTTP ${response.status}`,
    )
    if (httpError) {
        throw httpError
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(bodyText)
    } catch (err) {
        throw new ModelPresetAdapterError(
            'parse',
            'OAuth token response is not valid JSON',
            { retryable: true, fallbackEligible: true, cause: err },
        )
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ModelPresetAdapterError(
            'parse',
            'OAuth token response must be a JSON object',
            { retryable: true, fallbackEligible: true },
        )
    }

    const obj = parsed as Record<string, unknown>
    const accessToken = obj.access_token
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new ModelPresetAdapterError(
            'parse',
            "OAuth token response is missing 'access_token'",
            { retryable: false, fallbackEligible: false },
        )
    }
    const expiresInRaw = obj.expires_in
    const expiresInSeconds =
        typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0
            ? Math.floor(expiresInRaw)
            : 0
    if (expiresInSeconds === 0) {
        throw new ModelPresetAdapterError(
            'parse',
            "OAuth token response is missing or invalid 'expires_in'",
            { retryable: false, fallbackEligible: false },
        )
    }
    const tokenTypeRaw = obj.token_type
    const tokenType = typeof tokenTypeRaw === 'string' && tokenTypeRaw.length > 0
        ? tokenTypeRaw
        : 'Bearer'

    return {
        accessToken,
        tokenType,
        expiresInSeconds,
        issuedAtMs,
    }
}
