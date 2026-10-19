import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../alert', () => ({ notifyWarning: vi.fn() }))
vi.mock('../process/request/pendingSends', () => ({ clearPendingSend: vi.fn() }))

import { endAllGenerations, endGeneration, registerAbort, tryStartGeneration } from '../process/generationState'
import { stopRequestReply } from './requestStop'

afterEach(() => {
    endGeneration('chat-a')
    endAllGenerations()
})

describe('the request card x', () => {
    it("stops the chat's reply when it is still that chat's generation", () => {
        expect(tryStartGeneration('chat-a', 'gen-1')).toBeTruthy()
        const controller = new AbortController()
        registerAbort('chat-a', controller)
        expect(stopRequestReply('gen-1', 'chat-a')).toBe(true)
        expect(controller.signal.aborted).toBe(true)
    })

    it('leaves a newer reply, and a request of no chat, alone', () => {
        tryStartGeneration('chat-a', 'gen-2')
        const controller = new AbortController()
        registerAbort('chat-a', controller)
        expect(stopRequestReply('gen-1', 'chat-a')).toBe(false)
        expect(stopRequestReply('gen-2', undefined)).toBe(false)
        expect(controller.signal.aborted).toBe(false)
    })
})
