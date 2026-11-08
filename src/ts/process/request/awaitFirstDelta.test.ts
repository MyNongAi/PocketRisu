import { describe, expect, test } from 'vitest'
import { awaitFirstDelta } from './presetStreamPump'
import type { AdapterChatStreamDelta } from 'src/ts/preset/adapter'

// A 429 or 5xx throws from the adapter before its first delta. Waiting for that
// delta lets the refusal reject the request itself, where requestChatData's
// retry loop sees it, instead of failing inside a stream already handed to the
// chat (2026-11-09: each 429 was sent once, never retried).

type Gen = AsyncGenerator<AdapterChatStreamDelta, void, void>
const delta = (textDelta: string) => ({ textDelta }) as AdapterChatStreamDelta

async function texts(gen: Gen): Promise<string[]> {
    const out: string[] = []
    for await (const d of gen) out.push(d.textDelta)
    return out
}

describe('awaitFirstDelta', () => {
    test('a refusal before any delta rejects at once', async () => {
        const refused = (async function* (): Gen {
            throw Object.assign(new Error('HTTP 429'), { kind: 'rate-limit' })
        })()
        await expect(awaitFirstDelta(refused)).rejects.toMatchObject({ kind: 'rate-limit' })
    })

    test('the first delta stays in front of the rest', async () => {
        const pulled: string[] = []
        const source = (async function* (): Gen {
            for (const v of ['a', 'b', 'c']) {
                pulled.push(v)
                yield delta(v)
            }
        })()
        const stream = await awaitFirstDelta(source)
        expect(pulled).toEqual(['a'])
        expect(await texts(stream)).toEqual(['a', 'b', 'c'])
    })

    test('a failure after output still reaches the stream reader', async () => {
        const source = (async function* (): Gen {
            yield delta('a')
            throw new Error('cut')
        })()
        const stream = await awaitFirstDelta(source)
        await expect(texts(stream)).rejects.toThrow('cut')
    })

    test('an empty stream stays empty', async () => {
        const source = (async function* (): Gen {})()
        expect(await texts(await awaitFirstDelta(source))).toEqual([])
    })
})

// The real Google adapter on a model preset: a 429 rejects before the stream
// is handed out, as a rate-limit error (request.ts marks it rateLimited and
// the retry loop waits), and the next try streams normally.
describe('awaitFirstDelta on the Gemini preset adapter', () => {
    test('a 429 rejects as rate-limit; the retry streams', async () => {
        const { streamGoogleChatRequest } = await import('src/ts/preset/adapter/googleGemini')
        const preset = {
            id: 'preset-studio',
            name: 'AI Studio',
            profileSnapshot: {
                profileId: 'demo:google', profileVersion: 1, providerBaseId: 'google', providerBaseVersion: 1,
                adapterKind: 'google-gemini',
                auth: { kind: 'x-goog-api-key', fields: ['apiKey'] },
                endpoint: { kind: 'static', url: 'https://generativelanguage.googleapis.com/v1beta/models' },
                modelId: 'gemini-test',
                schema: [
                    { key: 'apiKey', type: 'string', label: 'API Key', secret: true, mapsTo: { target: 'auth', path: 'apiKey' } },
                    { key: 'modelId', type: 'string', label: 'Model ID', default: 'gemini-test', mapsTo: { target: 'body', path: 'model' } },
                ],
                uiSchema: { groups: [], fields: [] },
                defaults: {},
                headerTemplate: { 'Content-Type': 'application/json' },
                capabilities: ['streaming'],
            },
            userValues: {},
            createdAt: 0,
            updatedAt: 0,
        } as any
        let calls = 0
        const fetchImpl = (async () => {
            calls++
            if (calls === 1) {
                return new Response(JSON.stringify({ error: { code: 429, message: 'Resource exhausted.', status: 'RESOURCE_EXHAUSTED' } }), { status: 429 })
            }
            const chunk = { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }
            return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }) as typeof fetch
        const options = { messages: [{ role: 'user' as const, content: 'hello' }], fetchImpl }

        await expect(awaitFirstDelta(streamGoogleChatRequest(preset, options, { apiKey: 'k' }))).rejects.toMatchObject({ kind: 'rate-limit', status: 429 })
        const stream = await awaitFirstDelta(streamGoogleChatRequest(preset, options, { apiKey: 'k' }))
        expect((await texts(stream)).join('')).toBe('hi')
        expect(calls).toBe(2)
    })
})
