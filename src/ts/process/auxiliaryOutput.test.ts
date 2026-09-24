import { describe, expect, it } from 'vitest'
import { hasRenderableMainOutput } from './auxiliaryOutput'

describe('hasRenderableMainOutput', () => {
    it('rejects empty, whitespace and reasoning-only replies', () => {
        expect(hasRenderableMainOutput('')).toBe(false)
        expect(hasRenderableMainOutput(' \n ')).toBe(false)
        expect(hasRenderableMainOutput('<Thoughts>internal reasoning</Thoughts>')).toBe(false)
    })

    it('accepts even a short visible reply; length is not a safe proxy for intent', () => {
        expect(hasRenderableMainOutput('응')).toBe(true)
        expect(hasRenderableMainOutput('<Thoughts>thinking</Thoughts> 안녕')).toBe(true)
    })
})
