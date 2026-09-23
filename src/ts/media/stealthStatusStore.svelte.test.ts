import { flushSync } from 'svelte'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../globalApi.svelte', () => ({ getFileSrc: vi.fn(async () => '') }))

import { getStealthStatus, requestStealthStatus, resetStealthStatuses } from './stealthStatusStore.svelte'

describe('stealth status store', () => {
    it('re-runs readers when a status arrives', async () => {
        resetStealthStatuses()
        const seen: (string | undefined)[] = []
        const cleanup = $effect.root(() => {
            $effect(() => {
                seen.push(getStealthStatus('assets/a.mp3'))
            })
        })
        flushSync()

        // An audio file resolves to 'unsupported' without any fetch. The icon
        // colour only changes if this write wakes up the reader above.
        requestStealthStatus('assets/a.mp3', 'mp3')
        await new Promise((resolve) => setTimeout(resolve, 0))
        flushSync()
        cleanup()

        expect(seen).toEqual([undefined, 'unsupported'])
    })

    it('runs only a few detections at once', async () => {
        resetStealthStatuses()
        let active = 0
        let peak = 0
        const { getFileSrc } = await import('../globalApi.svelte')
        vi.mocked(getFileSrc).mockImplementation(async () => {
            active++
            peak = Math.max(peak, active)
            await new Promise((resolve) => setTimeout(resolve, 5))
            active--
            return ''
        })

        for (let i = 0; i < 12; i++) requestStealthStatus(`assets/${i}.png`, 'png')
        await vi.waitFor(() => expect(getStealthStatus('assets/11.png')).toBe('error'), { timeout: 2000 })

        expect(peak).toBeLessThanOrEqual(3)
    })
})
