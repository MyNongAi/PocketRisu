import { afterEach, describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    requestImmediateSave: vi.fn(async () => {}),
    hasUnsavedWork: vi.fn(() => false),
    alertConfirm: vi.fn(async () => true),
    notifyError: vi.fn(),
    allowNextUnload: vi.fn(),
}))
const doingChat = writable(false)

vi.mock('./globalApi.svelte', () => ({ requestImmediateSave: mocks.requestImmediateSave, hasUnsavedWork: mocks.hasUnsavedWork }))
vi.mock('./alert', () => ({ alertConfirm: mocks.alertConfirm, notifyError: mocks.notifyError }))
vi.mock('../preload', () => ({ allowNextUnload: mocks.allowNextUnload }))
vi.mock('./process/generationState', () => ({ doingChat }))

const { reloadApp } = await import('./reloadApp')

afterEach(() => {
    vi.clearAllMocks()
    mocks.hasUnsavedWork.mockReturnValue(false)
    doingChat.set(false)
})

describe('reloadApp', () => {
    it('saves first, then reloads without the leave-site prompt', async () => {
        const reload = vi.fn()
        expect(await reloadApp({ reload })).toBe(true)
        expect(mocks.requestImmediateSave).toHaveBeenCalledBefore(mocks.allowNextUnload)
        expect(mocks.allowNextUnload).toHaveBeenCalledBefore(reload)
        expect(mocks.alertConfirm).not.toHaveBeenCalled()
    })

    it('does not reload while edits are still waiting on the server', async () => {
        mocks.hasUnsavedWork.mockReturnValue(true)
        const reload = vi.fn()
        expect(await reloadApp({ reload })).toBe(false)
        expect(reload).not.toHaveBeenCalled()
        expect(mocks.allowNextUnload).not.toHaveBeenCalled()
        expect(mocks.notifyError).toHaveBeenCalled()
    })

    it('asks before cutting off a reply that is still generating', async () => {
        doingChat.set(true)
        mocks.alertConfirm.mockResolvedValueOnce(false)
        const reload = vi.fn()
        expect(await reloadApp({ reload })).toBe(false)
        expect(reload).not.toHaveBeenCalled()

        mocks.alertConfirm.mockResolvedValueOnce(true)
        expect(await reloadApp({ reload })).toBe(true)
        expect(reload).toHaveBeenCalledOnce()
    })
})
