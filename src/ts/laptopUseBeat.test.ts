import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetLaptopUseBeatForTests, startLaptopUseBeat } from './laptopUseBeat'

afterEach(() => resetLaptopUseBeatForTests())

describe('startLaptopUseBeat', () => {
    it('beats on input at most every 3 min, only while visible', () => {
        let now = 0
        let visible = true
        const send = vi.fn()
        vi.stubGlobal('window', {})
        try {
            const onInput = startLaptopUseBeat({ now: () => now, visible: () => visible, send, target: { addEventListener: () => {} } })!
            now = 60_000
            onInput()
            expect(send).not.toHaveBeenCalled() // 1 min after the page opened
            now = 3 * 60_000
            onInput()
            expect(send).toHaveBeenCalledTimes(1)
            now = 4 * 60_000
            onInput()
            expect(send).toHaveBeenCalledTimes(1) // 1 min after that beat
            visible = false
            now = 10 * 60_000
            onInput()
            expect(send).toHaveBeenCalledTimes(1) // hidden
            visible = true
            onInput()
            expect(send).toHaveBeenCalledTimes(2)
            expect(startLaptopUseBeat({ send })).toBeNull() // started once
        } finally {
            vi.unstubAllGlobals()
        }
    })
})
