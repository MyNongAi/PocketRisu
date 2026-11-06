import { afterEach, describe, expect, it, vi } from 'vitest'

const { db, fetchMock } = vi.hoisted(() => ({
    db: { nodeOnlyRealmRelay: undefined as string | undefined, blockedRealmCreators: [], nodeOnlyBlockedRealmCards: [] },
    fetchMock: vi.fn(),
}))

vi.mock('./storage/database.svelte', () => ({ getDatabase: () => db, appVer: 'test-version' }))
vi.mock('./stores.svelte', () => ({ DBState: { db } }))
// Keep import/export machinery out of this search-only unit test.
vi.mock('./alert', () => ({}))
vi.mock('./util', () => ({}))
vi.mock('src/lang', () => ({}))
vi.mock('./characters', () => ({}))
vi.mock('./globalApi.svelte', () => ({}))
vi.mock('./media', () => ({}))
vi.mock('./routing', () => ({}))
vi.mock('./parser/parser.svelte', () => ({}))
vi.mock('./process/files/inlays', () => ({}))
vi.mock('./pngChunk', () => ({}))
vi.mock('./process/processzip', () => ({}))
vi.mock('./process/modules', () => ({}))
vi.mock('./characterRecentOrder', () => ({}))
vi.mock('./importProgress', () => ({}))
vi.mock('./charxPreflight', () => ({}))
vi.mock('./largeCharxImport', () => ({}))
vi.mock('./importTransaction', () => ({}))
vi.mock('./process/similarityFolders', () => ({}))
vi.mock('./creatorFolders', () => ({}))
vi.mock('./onboarding', () => ({}))
vi.mock('./rccCard', () => ({}))

import { getRisuHub } from './characterCards'

afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
})

describe('getRisuHub search routing', () => {
    it.each([
        { nsfw: true, relay: ' http://relay:8787/base/ ', route: '/api/realm-relay', header: 'http://relay:8787/base/' },
        { nsfw: false, relay: 'http://relay:8787', route: '/hub-proxy', header: undefined },
        { nsfw: true, relay: undefined, route: '/hub-proxy', header: undefined },
        { nsfw: true, relay: '', route: '/hub-proxy', header: undefined },
        { nsfw: true, relay: '   ', route: '/hub-proxy', header: undefined },
    ])('uses $route with nsfw=$nsfw and relay="$relay"', async ({ nsfw, relay, route, header }) => {
        db.nodeOnlyRealmRelay = relay
        const cards = [{ id: 'kept', name: 'Search result' }]
        fetchMock.mockResolvedValue({ status: 200, json: async () => cards })
        vi.stubGlobal('fetch', fetchMock)

        expect(await getRisuHub({ search: 'space / 한글', page: 2, nsfw, sort: 'latest' })).toEqual(cards)
        const query = `search==space / 한글 __shared&&page==2&&nsfw==${nsfw}&&sort==latest&&web==other`
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${route}/realm/${encodeURIComponent(query)}?cache=30`, {
            headers: header
                ? { 'x-risuai-info': 'test-version;node', 'x-risu-realm-relay': header }
                : { 'x-risuai-info': 'test-version;node' },
        })
    })
})
