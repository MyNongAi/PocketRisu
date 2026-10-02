import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'

const mocks = vi.hoisted(() => ({ allowNextUnload: vi.fn() }))
vi.mock('../../preload', () => ({ allowNextUnload: mocks.allowNextUnload }))

const {
    BUILD_ID_HEADER,
    addBuildIdHeader,
    checkServerBuild,
    decideStaleBuildAction,
    isStaleBuild,
    onStaleBuild,
    readStaleBuildRefusal,
    registerUnsavedText,
    reloadIntoNewBuild,
    reportStaleBuild,
    resetBuildFenceForTests,
    setClientBuildIdForTests,
    setStaleBuildSaveState,
    staleBuildNotice,
} = await import('./buildFence')

function memoryStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial))
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value) },
        removeItem: (key: string) => { map.delete(key) },
        map,
    }
}

function refusal(serverBuild: string, status = 426) {
    return new Response(JSON.stringify({ code: 'STALE_CLIENT_BUILD', serverBuild }), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

beforeEach(() => {
    resetBuildFenceForTests()
    setClientBuildIdForTests('old-build')
    mocks.allowNextUnload.mockReset()
})

afterEach(() => {
    resetBuildFenceForTests()
    setClientBuildIdForTests('')
})

describe('stale build decision', () => {
    test('reloads a clean tab', () => {
        expect(decideStaleBuildAction({ unsavedWork: false, serverBuildId: 'b2', reloadedFor: null })).toBe('reload')
    })

    test('keeps a tab with unsaved work open', () => {
        expect(decideStaleBuildAction({ unsavedWork: true, serverBuildId: 'b2', reloadedFor: null })).toBe('notice')
    })

    test('does not reload twice for the same server build', () => {
        expect(decideStaleBuildAction({ unsavedWork: false, serverBuildId: 'b2', reloadedFor: 'b2' })).toBe('notice')
        // A later server build may reload the tab again.
        expect(decideStaleBuildAction({ unsavedWork: false, serverBuildId: 'b3', reloadedFor: 'b2' })).toBe('reload')
    })
})

describe('reportStaleBuild', () => {
    test('a clean tab stops saving, marks the server build and reloads without the leave prompt', () => {
        const stop = vi.fn()
        onStaleBuild(stop)
        setStaleBuildSaveState({ hasUnsavedWork: () => false })
        const storage = memoryStorage()
        const reload = vi.fn()

        expect(reportStaleBuild('b2', { reload, storage })).toBe('reload')
        expect(stop).toHaveBeenCalledOnce()
        expect(isStaleBuild()).toBe(true)
        expect(storage.map.get('pocketrisu-stale-build-reload')).toBe('b2')
        expect(mocks.allowNextUnload).toHaveBeenCalledBefore(reload)
        expect(reload).toHaveBeenCalledOnce()
        expect(get(staleBuildNotice)).toBeNull()

        // Later refusals while the reload is underway do nothing more.
        expect(reportStaleBuild('b2', { reload, storage })).toBe('reload')
        expect(reload).toHaveBeenCalledOnce()
        expect(stop).toHaveBeenCalledOnce()
    })

    test('unsaved edits keep the tab open with the download offered', () => {
        const stop = vi.fn()
        onStaleBuild(stop)
        setStaleBuildSaveState({ hasUnsavedWork: () => true, downloadUnsavedEdits: async () => {} })
        const reload = vi.fn()

        expect(reportStaleBuild('b2', { reload, storage: memoryStorage() })).toBe('notice')
        expect(stop).toHaveBeenCalledOnce()
        expect(reload).not.toHaveBeenCalled()
        expect(mocks.allowNextUnload).not.toHaveBeenCalled()
        expect(get(staleBuildNotice)).toMatchObject({
            serverBuildId: 'b2',
            reloadTried: false,
            unsavedText: '',
            canDownloadEdits: true,
        })
    })

    test('unsent chat input keeps the tab open and is shown', () => {
        setStaleBuildSaveState({ hasUnsavedWork: () => false, downloadUnsavedEdits: async () => {} })
        const unregister = registerUnsavedText(() => 'half-written message')
        registerUnsavedText(() => '')
        const reload = vi.fn()

        expect(reportStaleBuild('b2', { reload, storage: memoryStorage() })).toBe('notice')
        expect(reload).not.toHaveBeenCalled()
        expect(get(staleBuildNotice)).toMatchObject({ unsavedText: 'half-written message', canDownloadEdits: false })

        // Each refusal refreshes the notice and reopens it.
        const firstSeq = get(staleBuildNotice)!.seq
        unregister()
        registerUnsavedText(() => 'edited message')
        reportStaleBuild('b2', { reload, storage: memoryStorage() })
        expect(get(staleBuildNotice)).toMatchObject({ unsavedText: 'edited message' })
        expect(get(staleBuildNotice)!.seq).toBe(firstSeq + 1)
    })

    test('a failing unsaved-work probe counts as unsaved', () => {
        setStaleBuildSaveState({ hasUnsavedWork: () => { throw new Error('not ready') } })
        const reload = vi.fn()
        expect(reportStaleBuild('b2', { reload, storage: memoryStorage() })).toBe('notice')
        expect(reload).not.toHaveBeenCalled()
    })

    test('a tab that already reloaded for this server build shows the notice instead of looping', () => {
        const reload = vi.fn()
        const storage = memoryStorage({ 'pocketrisu-stale-build-reload': 'b2' })
        expect(reportStaleBuild('b2', { reload, storage })).toBe('notice')
        expect(reload).not.toHaveBeenCalled()
        expect(get(staleBuildNotice)).toMatchObject({ reloadTried: true, unsavedText: '', canDownloadEdits: false })
    })

    test('without session storage there is no loop guard, so no automatic reload', () => {
        const reload = vi.fn()
        expect(reportStaleBuild('b2', { reload, storage: null })).toBe('notice')
        expect(reload).not.toHaveBeenCalled()
    })

    test('a listener registered after the report runs at once', () => {
        reportStaleBuild('b2', { reload: vi.fn(), storage: null })
        const late = vi.fn()
        onStaleBuild(late)
        expect(late).toHaveBeenCalledOnce()
    })

    test('the notice reload button skips the leave prompt', () => {
        const reload = vi.fn()
        reloadIntoNewBuild(reload)
        expect(mocks.allowNextUnload).toHaveBeenCalledBefore(reload)
    })
})

describe('refusal responses', () => {
    test('only a 426 carrying the stale-build code names a server build', async () => {
        expect(await readStaleBuildRefusal(refusal('b2'))).toBe('b2')
        expect(await readStaleBuildRefusal(refusal('b2', 409))).toBeNull()
        expect(await readStaleBuildRefusal(new Response('Upgrade Required', { status: 426 }))).toBeNull()
        expect(await readStaleBuildRefusal(new Response(JSON.stringify({ code: 'OTHER', serverBuild: 'b2' }), { status: 426 }))).toBeNull()
    })

    test('the response body stays readable for the caller', async () => {
        const response = refusal('b2')
        await readStaleBuildRefusal(response)
        expect(await response.json()).toMatchObject({ serverBuild: 'b2' })
    })
})

describe('build id header', () => {
    test('is sent by a production build only', () => {
        const headers = new Headers()
        addBuildIdHeader(headers)
        expect(headers.get(BUILD_ID_HEADER)).toBe('old-build')

        setClientBuildIdForTests('')
        const devHeaders = new Headers()
        addBuildIdHeader(devHeaders)
        expect(devHeaders.has(BUILD_ID_HEADER)).toBe(false)
    })
})

describe('checkServerBuild', () => {
    function text(body: string, status = 200) {
        return vi.fn(async () => new Response(body, { status }))
    }

    test('a matching build clears the reload mark', async () => {
        const fetchFn = text('old-build\n')
        const storage = memoryStorage({ 'pocketrisu-stale-build-reload': 'old-build' })
        expect(await checkServerBuild(fetchFn, { reload: vi.fn(), storage })).toBe('match')
        expect(fetchFn).toHaveBeenCalledWith('/build-id.txt', { cache: 'no-store' })
        expect(storage.map.has('pocketrisu-stale-build-reload')).toBe(false)
        expect(isStaleBuild()).toBe(false)
    })

    test('another build is reported, and a clean tab reloads', async () => {
        const reload = vi.fn()
        expect(await checkServerBuild(text('new-build\n'), { reload, storage: memoryStorage() })).toBe('stale')
        expect(reload).toHaveBeenCalledOnce()
        // Already stale: further checks neither fetch nor reopen anything.
        const again = text('new-build\n')
        expect(await checkServerBuild(again, { reload, storage: memoryStorage() })).toBe('stale')
        expect(again).not.toHaveBeenCalled()
    })

    test.each([
        ['a missing file', text('Cannot GET /build-id.txt', 404)],
        ['an HTML fallback page', text('<!doctype html><html></html>')],
        ['a network error', vi.fn(async () => { throw new TypeError('Failed to fetch') })],
    ])('%s is unknown and changes nothing', async (_label, fetchFn) => {
        const reload = vi.fn()
        expect(await checkServerBuild(fetchFn, { reload, storage: memoryStorage() })).toBe('unknown')
        expect(reload).not.toHaveBeenCalled()
        expect(isStaleBuild()).toBe(false)
    })

    test('a dev build never checks', async () => {
        setClientBuildIdForTests('')
        const fetchFn = text('new-build')
        expect(await checkServerBuild(fetchFn, { reload: vi.fn(), storage: memoryStorage() })).toBe('unknown')
        expect(fetchFn).not.toHaveBeenCalled()
    })
})
