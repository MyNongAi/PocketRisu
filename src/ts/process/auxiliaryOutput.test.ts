import { describe, expect, it } from 'vitest'
import { hasRenderableMainOutput, shouldRunAuxiliaryModel } from './auxiliaryOutput'

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

describe('shouldRunAuxiliaryModel', () => {
    it('skips short output according to the configured threshold', () => {
        expect(shouldRunAuxiliaryModel('OOC', 20)).toBe(false)
        expect(shouldRunAuxiliaryModel('검열로 인해 답변할 수 없습니다.', 20)).toBe(false)
        expect(shouldRunAuxiliaryModel('이 문장은 충분히 긴 정상적인 응답입니다.', 20)).toBe(true)
    })

    it('ignores reasoning, style and markup but permits a zero threshold to mean nonempty', () => {
        expect(shouldRunAuxiliaryModel('<Thoughts>long reasoning</Thoughts>응', 20)).toBe(false)
        expect(shouldRunAuxiliaryModel('<style>lots of CSS</style><b>응</b>', 20)).toBe(false)
        expect(shouldRunAuxiliaryModel('응', 0)).toBe(true)
    })
})
