import { describe, expect, it, vi } from 'vitest'
import { CONTINUE_FROM_PREFILL, endingOnUserTurn, refusesTrailingAssistant, sendAllowingPrefillRefusal } from './trailingPrefill'

type Msg = { role: string, content: string }
const prefilled: Msg[] = [
    { role: 'system', content: 'Summarize.' },
    { role: 'user', content: 'user: hello' },
    { role: 'assistant', content: 'Understood.\n\n# Response Template' },
]

describe('a summary prompt that ends in a prefill', () => {
    it('knows the refusals and ends the messages on a user turn', () => {
        expect(refusesTrailingAssistant('Requests ending with a model turn are not supported.')).toBe(true)
        expect(refusesTrailingAssistant(new Error('This model does not support assistant message prefill. The conversation must end with a user message.'))).toBe(true)
        expect(refusesTrailingAssistant('429 Too Many Requests')).toBe(false)
        expect(endingOnUserTurn(prefilled)).toEqual([...prefilled, { role: 'user', content: CONTINUE_FROM_PREFILL }])
        expect(endingOnUserTurn(prefilled.slice(0, 2))).toBeNull()
    })

    it('is sent once more ending on a user turn after the model refused it', async () => {
        const send = vi.fn()
            .mockResolvedValueOnce({ type: 'fail', result: 'Requests ending with a model turn are not supported.' })
            .mockResolvedValueOnce({ type: 'success', result: 'the summary' })
        await expect(sendAllowingPrefillRefusal(prefilled, send)).resolves.toEqual({ type: 'success', result: 'the summary' })
        expect(send).toHaveBeenCalledTimes(2)
        expect(send.mock.calls[0][0]).toBe(prefilled)
        expect(send.mock.calls[1][0]).toEqual([...prefilled, { role: 'user', content: CONTINUE_FROM_PREFILL }])
    })

    it('is not sent again for any other result', async () => {
        const failed = vi.fn().mockResolvedValue({ type: 'fail', result: '429 Too Many Requests' })
        await expect(sendAllowingPrefillRefusal(prefilled, failed)).resolves.toEqual({ type: 'fail', result: '429 Too Many Requests' })
        expect(failed).toHaveBeenCalledTimes(1)
        // a refusal for a request that already ends on the user: nothing to change
        const plain = vi.fn().mockResolvedValue({ type: 'fail', result: 'Requests ending with a model turn are not supported.' })
        await sendAllowingPrefillRefusal(prefilled.slice(0, 2), plain)
        expect(plain).toHaveBeenCalledTimes(1)
    })
})
