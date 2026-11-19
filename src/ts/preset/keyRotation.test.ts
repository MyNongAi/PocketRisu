import { beforeEach, describe, expect, it } from 'vitest'
import { advanceRotationIndex, currentRotationIndex, resetKeyRotationForTests, rotationCredentials, runKeyRotation, shouldRotateKey } from './keyRotation'
import type { ApiKeyPoolEntry, ModelPreset } from './types'

const entry = (id: string, key: string): ApiKeyPoolEntry => ({ id, key, name: id, createdAt: 1, updatedAt: 1 })
const preset = { id: 'fake-preset', rotationKeyRefs: ['same', 'missing', 'second', 'second-again'] } as ModelPreset

describe('preset key rotation', () => {
    beforeEach(resetKeyRotationForTests)

    it('keeps key 1, collapses equal values, and skips deleted refs', () => {
        const credentials = rotationCredentials(preset, { apiKey: 'fake-first' }, {
            same: entry('same', 'fake-first'),
            second: entry('second', 'fake-second'),
            'second-again': entry('second-again', 'fake-second'),
        })
        expect(credentials.map((credential) => credential.apiKey)).toEqual(['fake-first', 'fake-second'])
        expect(rotationCredentials(preset, undefined, { second: entry('second', 'fake-second') }))
            .toEqual([{ apiKey: 'fake-second' }])
    })

    it('advances per preset and wraps', () => {
        expect(currentRotationIndex('fake-preset', 2)).toBe(0)
        expect(advanceRotationIndex('fake-preset', 2)).toBe(1)
        expect(currentRotationIndex('other-preset', 2)).toBe(0)
        expect(advanceRotationIndex('fake-preset', 2)).toBe(0)
    })

    it('rotates only on a numeric 429 or 5xx and never on abort', () => {
        for (const status of [429, 500, 503, 599]) expect(shouldRotateKey({ status })).toBe(true)
        for (const status of [400, 401, 408, 600]) expect(shouldRotateKey({ status })).toBe(false)
        expect(shouldRotateKey({ status: 429 }, true)).toBe(false)
        expect(shouldRotateKey({ name: 'AbortError', status: 503 })).toBe(false)
        expect(shouldRotateKey(new Error('HTTP 429'))).toBe(false)
    })

    it('retries a refused transport immediately, logs both statuses, and holds the winning key', async () => {
        const credentials = [{ apiKey: 'fake-first' }, { apiKey: 'fake-second' }]
        const statuses: number[] = []
        const result = await runKeyRotation('fake-preset', credentials, () => false, async (credential) => {
            const status = credential.apiKey === 'fake-first' ? 429 : 200
            statuses.push(status)
            if (status === 429) throw { status }
            return 'accepted'
        })
        expect(result).toBe('accepted')
        expect(statuses).toEqual([429, 200])
        expect(currentRotationIndex('fake-preset', 2)).toBe(1)
    })

    it('does not retry a 400 or a user abort', async () => {
        const credentials = [{ apiKey: 'fake-first' }, { apiKey: 'fake-second' }]
        const statuses: number[] = []
        await expect(runKeyRotation('fake-preset', credentials, () => false, async () => {
            statuses.push(400)
            throw { status: 400 }
        })).rejects.toMatchObject({ status: 400 })
        expect(statuses).toEqual([400])
        expect(currentRotationIndex('fake-preset', 2)).toBe(0)
        await expect(runKeyRotation('fake-preset', credentials, () => true, async () => {
            statuses.push(429)
            throw { status: 429 }
        })).rejects.toMatchObject({ status: 429 })
        expect(statuses).toEqual([400, 429])
        expect(currentRotationIndex('fake-preset', 2)).toBe(0)
    })

    it('tries every key once and wraps the next outer retry to key 1', async () => {
        const tried: string[] = []
        const credentials = [{ apiKey: 'fake-first' }, { apiKey: 'fake-second' }]
        await expect(runKeyRotation('fake-preset', credentials, () => false, async (credential) => {
            tried.push(credential.apiKey ?? '')
            throw { status: 503 }
        })).rejects.toMatchObject({ status: 503 })
        expect(tried).toEqual(['fake-first', 'fake-second'])
        expect(currentRotationIndex('fake-preset', 2)).toBe(0)
    })
})
