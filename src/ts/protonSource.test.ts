import { describe, expect, it } from 'vitest'
import { protonLinkOf, snapshotImportedIds, stampProtonSource, type ProtonSourceRecord } from './protonSource'

const LINK = 'https://drive.proton.me/urls/ABC123#key'

describe('Proton source record', () => {
    it('stamps only the characters and modules an import added', () => {
        const db = {
            characters: [{ chaId: 'old' }] as { chaId: string, nodeOnlyProtonSource?: ProtonSourceRecord }[],
            modules: [{ id: 'm-old' }] as { id: string, nodeOnlyProtonSource?: ProtonSourceRecord, nodeOnlyProtonShare?: string }[],
        }
        const before = snapshotImportedIds(db)
        db.characters.push({ chaId: 'new' })
        db.modules.push({ id: 'm-new' })
        const source = { link: LINK, file: 'bot.charx', linkId: 'L1', path: ['P1'], at: 5 }
        expect(stampProtonSource(db, before, source)).toEqual({ characters: ['new'], modules: ['m-new'] })
        expect(db.characters[0].nodeOnlyProtonSource).toBeUndefined()
        expect(db.characters[1].nodeOnlyProtonSource).toEqual(source)
        expect(db.modules[1]).toMatchObject({ nodeOnlyProtonSource: source, nodeOnlyProtonShare: LINK })
        expect(db.modules[0].nodeOnlyProtonSource).toBeUndefined()
    })

    it('reads the link from a record or a Realm companion module share', () => {
        expect(protonLinkOf({ nodeOnlyProtonSource: { link: LINK, file: 'a', at: 1 } })).toBe(LINK)
        expect(protonLinkOf({ nodeOnlyProtonShare: LINK })).toBe(LINK)
        expect(protonLinkOf({})).toBe('')
        expect(protonLinkOf(undefined)).toBe('')
    })
})
