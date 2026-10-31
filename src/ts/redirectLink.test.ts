import { describe, expect, test } from 'vitest'
import { unwrapRedirectLink } from './redirectLink'

const PROTON = 'https://drive.proton.me/urls/AB12cd34EF#k3yPart_9'

describe('unwrapRedirectLink', () => {
    test('arca.live\'s unsafelink wrapper gives the link inside, fragment and all', () => {
        expect(unwrapRedirectLink(`https://unsafelink.com/${PROTON}`)).toBe(PROTON)
        expect(unwrapRedirectLink(`  http://www.unsafelink.com/${PROTON} `)).toBe(PROTON)
        expect(unwrapRedirectLink(`https://unsafelink.com/${encodeURIComponent(PROTON)}`)).toBe(PROTON)
    })

    test('any other link, or the wrapper alone, stays as given', () => {
        expect(unwrapRedirectLink(` ${PROTON} `)).toBe(PROTON)
        expect(unwrapRedirectLink('https://example.com/https://realm.risuai.net/')).toBe('https://example.com/https://realm.risuai.net/')
        expect(unwrapRedirectLink('https://unsafelink.com/')).toBe('https://unsafelink.com/')
        expect(unwrapRedirectLink('https://unsafelink.com/https%3A%2F%2Fbad%E0%A4%A')).toBe('https://unsafelink.com/https%3A%2F%2Fbad%E0%A4%A')
    })
})
