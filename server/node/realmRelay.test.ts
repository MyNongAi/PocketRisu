import { describe, expect, it } from 'vitest'
import pkg from './realmRelay.cjs'

const { realmRelayTarget } = pkg as {
    realmRelayTarget: (relay: unknown, pathAndQuery: unknown) => string | null
}

describe('realmRelayTarget', () => {
    const search = '/realm/search%3D%3D%20__shared%26%26nsfw%3D%3Dtrue?cache=30'

    it('sends a Realm search to the relay', () => {
        expect(realmRelayTarget('http://realm-relay:8787', search)).toBe(`http://realm-relay:8787/sv${search}`)
        expect(realmRelayTarget(' http://realm-relay:8787/ ', search)).toBe(`http://realm-relay:8787/sv${search}`)
        expect(realmRelayTarget('https://relay.example.ts.net/base', search)).toBe(`https://relay.example.ts.net/base/sv${search}`)
    })

    it('leaves every other hub request to the hub', () => {
        expect(realmRelayTarget('http://realm-relay:8787', '/resource/abc.png')).toBeNull()
        expect(realmRelayTarget('http://realm-relay:8787', '/hub/info/123')).toBeNull()
        expect(realmRelayTarget('http://realm-relay:8787', '/realmish')).toBeNull()
    })

    it('ignores a missing or malformed relay', () => {
        expect(realmRelayTarget(undefined, search)).toBeNull()
        expect(realmRelayTarget('', search)).toBeNull()
        expect(realmRelayTarget(['http://a', 'http://b'], search)).toBeNull()
        expect(realmRelayTarget('realm-relay:8787', search)).toBeNull()
        expect(realmRelayTarget('file:///etc/passwd', search)).toBeNull()
        expect(realmRelayTarget('http://user:pw@realm-relay:8787', search)).toBeNull()
        expect(realmRelayTarget('http://realm-relay:8787/?x=1', search)).toBeNull()
    })
})
