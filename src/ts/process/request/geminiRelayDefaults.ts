import { get, writable } from 'svelte/store'
import { isNodeServer } from '../../platform'

export interface GeminiRelayDefaults {
    jpUrl?: string
    usUrl?: string
    key?: string
}

export const geminiRelayDefaults = writable<GeminiRelayDefaults>({})
let pending: Promise<void> | undefined
let loaded = false

export function currentGeminiRelayDefaults(): GeminiRelayDefaults {
    return get(geminiRelayDefaults)
}

export function loadGeminiRelayDefaults(): Promise<void> {
    if (!isNodeServer || loaded) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
        const { forageStorage } = await import('../../globalApi.svelte')
        const auth = await forageStorage.createAuth()
        const response = await fetch('/api/gemini-relay-defaults', {
            headers: { 'risu-auth': auth },
            cache: 'no-store',
        })
        if (!response.ok) throw new Error('Gemini relay defaults unavailable')
        geminiRelayDefaults.set(await response.json() as GeminiRelayDefaults)
        loaded = true
    })().catch(() => {}).finally(() => { pending = undefined })
    return pending
}

export async function waitForGeminiRelayDefaults(timeoutMs = 1500): Promise<void> {
    if (!isNodeServer || loaded) return
    await Promise.race([
        loadGeminiRelayDefaults(),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
}
