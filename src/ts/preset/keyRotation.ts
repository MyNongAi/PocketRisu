import type { AdapterCredential } from './adapter/types'
import type { ApiKeyPoolEntry, ModelPreset } from './types'

const currentIndexes = new Map<string, number>()

/** Build a request-local snapshot. A deleted pool reference contributes no attempt. */
export function rotationCredentials(
    preset: ModelPreset,
    first: AdapterCredential | undefined,
    pool: Record<string, ApiKeyPoolEntry> | undefined,
): AdapterCredential[] {
    const credentials: AdapterCredential[] = first ? [first] : []
    const seen = new Set(first?.apiKey ? [first.apiKey] : [])
    for (const ref of preset.rotationKeyRefs ?? []) {
        const key = pool?.[ref]?.key
        if (!key || seen.has(key)) continue
        seen.add(key)
        credentials.push({ apiKey: key })
    }
    return credentials
}

export function currentRotationIndex(presetId: string, count: number): number {
    return count ? (currentIndexes.get(presetId) ?? 0) % count : 0
}

export function advanceRotationIndex(presetId: string, count: number): number {
    const next = (currentRotationIndex(presetId, count) + 1) % count
    currentIndexes.set(presetId, next)
    return next
}

export function shouldRotateKey(error: unknown, aborted = false): boolean {
    if (aborted || (error as { name?: string })?.name === 'AbortError') return false
    const status = (error as { status?: unknown })?.status
    return typeof status === 'number' && (status === 429 || (status >= 500 && status < 600))
}

/** Run each distinct key at most once; keep the succeeding key current. */
export async function runKeyRotation<T>(
    presetId: string,
    credentials: readonly AdapterCredential[],
    aborted: () => boolean,
    attempt: (credential: AdapterCredential) => Promise<T>,
): Promise<T> {
    for (let tried = 0; tried < credentials.length; tried++) {
        const index = currentRotationIndex(presetId, credentials.length)
        try {
            return await attempt(credentials[index])
        } catch (error) {
            if (!shouldRotateKey(error, aborted())) throw error
            advanceRotationIndex(presetId, credentials.length)
            if (tried === credentials.length - 1) throw error
        }
    }
    throw new Error('No rotation credentials')
}

export function resetKeyRotationForTests(): void {
    currentIndexes.clear()
}
