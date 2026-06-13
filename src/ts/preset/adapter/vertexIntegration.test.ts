import { describe, expect, test } from 'vitest'
import { loadBundledRegistry, resolveSnapshot } from '../registry'
import type { ModelPreset } from '../types'
import { buildPreparedRequest } from './buildRequest'
import { createServiceAccountTokenCache } from './googleServiceAccount/cache'
import type { ExchangeServiceAccountInput } from './googleServiceAccount/token'
import { prepareAdapterRequest, resolveAdapterCredential } from './resolveCredential'

const VALID_SA_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'demo',
    private_key_id: 'kid-1',
    private_key:
        '-----BEGIN PRIVATE KEY-----\nMIIBVwIB...\n-----END PRIVATE KEY-----\n',
    client_email: 'svc@demo.iam.gserviceaccount.com',
    client_id: '1',
    token_uri: 'https://oauth2.googleapis.com/token',
})

function bundledPreset(profileId: string, userValues: Record<string, unknown>): ModelPreset {
    const registry = loadBundledRegistry()
    const snapshot = resolveSnapshot(registry, profileId)
    return {
        id: 'preset-1',
        name: 'Vertex Preset',
        profileSnapshot: snapshot,
        userValues,
        createdAt: 1,
        updatedAt: 1,
    }
}

function vertexPreset(userValues: Record<string, unknown>): ModelPreset {
    return bundledPreset('vertex-openai:standard', userValues)
}

function stubCache(accessToken: string) {
    const calls: ExchangeServiceAccountInput[] = []
    const exchange = async (input: ExchangeServiceAccountInput) => {
        calls.push(input)
        return {
            accessToken,
            tokenType: 'Bearer',
            expiresInSeconds: 3600,
            issuedAtMs: 1_000_000,
        }
    }
    return {
        cache: createServiceAccountTokenCache({ now: () => 1_000_000, exchange }),
        calls,
    }
}

describe('Vertex OpenAI end-to-end (bundled registry)', () => {
    test('resolves SA credential then builds the prepared request with bearer token + endpoint URL', async () => {
        const { cache, calls } = stubCache('ya29.integration')
        const preset = vertexPreset({
            serviceAccountJson: VALID_SA_JSON,
            projectId: 'my-proj',
            modelId: 'google/gemini-2.5-pro',
        })

        const credential = await resolveAdapterCredential({
            preset,
            credential: { apiKey: VALID_SA_JSON },
            tokenCache: cache,
        })
        expect(credential?.apiKey).toBe('ya29.integration')

        const prepared = buildPreparedRequest({ preset, credential })

        expect(prepared.method).toBe('POST')
        expect(prepared.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions',
        )
        expect(prepared.headers.Authorization).toBe('Bearer ya29.integration')
        expect(prepared.body.model).toBe('google/gemini-2.5-pro')

        // SA parser ran and forwarded the parsed account to the cache.
        expect(calls).toHaveLength(1)
        expect(calls[0].serviceAccount.clientEmail).toBe('svc@demo.iam.gserviceaccount.com')
    })

    test('uses global location host when userValues sets location=global', async () => {
        const { cache } = stubCache('ya29.global')
        const preset = vertexPreset({
            serviceAccountJson: VALID_SA_JSON,
            projectId: 'my-proj',
            location: 'global',
            modelId: 'google/gemini-2.5-pro',
        })
        const credential = await resolveAdapterCredential({
            preset,
            credential: { apiKey: VALID_SA_JSON },
            tokenCache: cache,
        })
        const prepared = buildPreparedRequest({ preset, credential })
        expect(prepared.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions',
        )
    })
})

describe('Vertex Gemini native end-to-end (bundled registry)', () => {
    // Pins the shipped vertex-gemini-native:flash profile to the resolver
    // contract: mapsTo paths (custom.project / custom.location / serviceAccountJson
    // -> auth.apiKey) and the 'vertex-gemini' endpoint kind must all line up, or
    // the native '.../publishers/google/models' URL would not assemble. Goes
    // through prepareAdapterRequest, so the SA JSON is swapped for an OAuth token
    // BEFORE the URL is built — exercising the credential-threaded project_id
    // recovery for the pooled/inline path (Project ID blank, SA JSON NOT in
    // userValues), the documented normal case.
    test('resolves the bundled flash profile to the native base URL with project_id recovered from the credential SA JSON', async () => {
        const { cache, calls } = stubCache('ya29.gemini')
        const preset = bundledPreset('vertex-gemini-native:flash', {})

        const prepared = await prepareAdapterRequest({
            preset,
            credential: { apiKey: VALID_SA_JSON },
            tokenCache: cache,
        })

        expect(prepared.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models',
        )
        expect(prepared.headers.Authorization).toBe('Bearer ya29.gemini')
        // The OAuth swap ran (project_id had to come from the raw SA JSON, not
        // the post-swap token credential).
        expect(calls).toHaveLength(1)
    })
})
