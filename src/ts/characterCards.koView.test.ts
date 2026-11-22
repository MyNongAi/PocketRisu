import { describe, expect, it, vi } from 'vitest'

// Keep the app's stores and import machinery out of this card-shape test
// (the same set characterCards.realm.test.ts mocks).
const { db } = vi.hoisted(() => ({ db: {} as Record<string, unknown> }))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => db, appVer: 'test-version' }))
vi.mock('./stores.svelte', () => ({ DBState: { db } }))
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
vi.mock('./process/moduleImport', () => ({}))
vi.mock('./characterRecentOrder', () => ({}))
vi.mock('./importProgress', () => ({}))
vi.mock('./charxPreflight', () => ({}))
vi.mock('./largeCharxImport', () => ({}))
vi.mock('./importTransaction', () => ({}))
vi.mock('./process/similarityFolders', () => ({}))
vi.mock('./creatorFolders', () => ({}))
vi.mock('./onboarding', () => ({}))
vi.mock('./rccCard', () => ({}))

import { createBaseV3 } from './characterCards'
import { validKoMap } from './koView'
import type { character, loreBook } from './storage/database.svelte'

function cardWithKorean() {
    const entry = {
        key: 'forest', secondkey: '', insertorder: 0, comment: '', content: 'A forest',
        mode: 'normal', alwaysActive: false, selective: false,
        nodeOnlyKo: { content: { text: '숲', src: 'a1' } },
    } as loreBook
    return { name: 'Bot', desc: 'English', firstMessage: 'Hello', globalLore: [entry],
        nodeOnlyKo: { desc: { text: '설명', src: 'b2' } },
    } as unknown as character
}

describe('KO-VIEW card extensions', () => {
    it('writes both maps to ignored V3 extensions and can validate them on read', () => {
        const card = createBaseV3(cardWithKorean())
        const characterMap = validKoMap((card.data.extensions as any).pocketrisu?.ko)
        const loreMap = validKoMap((card.data.character_book?.entries?.[0]?.extensions as any)?.pocketrisu_ko)
        expect(characterMap?.desc.text).toBe('설명')
        expect(loreMap?.content.text).toBe('숲')
    })

    it('drops invalid and oversized imported values', () => {
        expect(validKoMap({ desc: { text: null, src: 'a' } })).toBeUndefined()
        expect(validKoMap({ desc: { text: 'x'.repeat(200_001), src: 'a' } })).toBeUndefined()
    })

    it('does not add a pocketrisu key without Korean', () => {
        const char = cardWithKorean()
        delete char.nodeOnlyKo
        delete char.globalLore[0].nodeOnlyKo
        const card = createBaseV3(char)
        expect((card.data.extensions as any).pocketrisu).toBeUndefined()
        expect((card.data.character_book?.entries?.[0]?.extensions as any)?.pocketrisu_ko).toBeUndefined()
    })
})
