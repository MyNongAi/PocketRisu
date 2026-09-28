import { describe, expect, test } from 'vitest'
import { parseRealmReference } from './realmLink'

const ID = '8b1f3c4e-2d6a-4f0b-9c3e-5a7d1e2f4b6c'

describe('parseRealmReference', () => {
    test('a Realm page URL, with or without scheme, trailing slash or query', () => {
        expect(parseRealmReference(`https://realm.risuai.net/character/${ID}`)).toBe(ID)
        expect(parseRealmReference(`realm.risuai.net/character/${ID}/`)).toBe(ID)
        expect(parseRealmReference(`  https://realm.risuai.net/character/${ID}?utm=x  `)).toBe(ID)
        expect(parseRealmReference(`https://realm.risuai.net/character/${ID}`, 'uuid')).toBe(ID)
    })

    test('a link carrying ?realm= or ?code=, on any host', () => {
        expect(parseRealmReference(`https://risuai.xyz/?realm=${ID}`)).toBe(ID)
        expect(parseRealmReference(`http://localhost:6001/?code=abc123`)).toBe('abc123')
    })

    test('other links are not Realm references', () => {
        expect(parseRealmReference('https://example.com/character/abc')).toBeNull()
        expect(parseRealmReference('https://realm.risuai.net/')).toBeNull()
        expect(parseRealmReference('https://realm.risuai.net/character')).toBeNull()
        expect(parseRealmReference('not a url://')).toBeNull()
    })

    test('a bare value: any id for a prompt, only a UUID for a search box', () => {
        expect(parseRealmReference('abc123')).toBe('abc123')
        expect(parseRealmReference(ID)).toBe(ID)
        expect(parseRealmReference('abc123', 'uuid')).toBeNull()
        expect(parseRealmReference('로맨스 판타지', 'uuid')).toBeNull()
        expect(parseRealmReference(ID, 'uuid')).toBe(ID)
        expect(parseRealmReference('two words')).toBeNull()
        expect(parseRealmReference('   ')).toBeNull()
    })
})
