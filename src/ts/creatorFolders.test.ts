import { describe, expect, it } from 'vitest'
import type { folder } from './storage/database.svelte'
import { CREATOR_FOLDER_PREFIX, creatorKey, creatorsOf, organizeCreatorFolders, placeImportedByCreator } from './creatorFolders'

type Entry = string | folder
const f = (id: string, data: string[], extra: Partial<folder> & { duplicateCandidate?: { kind: string, key: string } } = {}): folder =>
    ({ id, name: id, color: '', data, ...extra } as folder)
const similar = (id: string, data: string[]) => f(id, data, { duplicateCandidate: { kind: 'character', key: id } })
const ids = (order: Entry[]) => order.map((e) => (typeof e === 'string' ? e : `[${e.name}:${e.data.join(',')}${e.nodeOnlyParentFolderId ? '^' + e.nodeOnlyParentFolderId : ''}]`))

const creators = creatorsOf([
    { chaId: 'k1', creator: 'Kokomi' }, { chaId: 'k2', creator: ' kokomi ' }, { chaId: 'k3', creator: 'Kokomi' }, { chaId: 'k4', creator: 'Kokomi' },
    { chaId: 't1', creator: 'toxin' }, { chaId: 't2', creator: 'toxin' },
    { chaId: 'a1', creator: 'ㅇㅇ' }, { chaId: 'a2', creator: 'ㅇㅇ' },
    { chaId: 'solo', creator: 'Solo' }, { chaId: 'x' },
])
let n = 0
const newId = () => `C${++n}`

describe('creatorKey', () => {
    it('folds spacing and case, and drops placeholders', () => {
        expect(creatorKey(' Kokomi ')).toBe('kokomi')
        expect(creatorKey('Sunakgo,  Nanakgo')).toBe('sunakgo, nanakgo')
        expect(creatorKey('ㅇㅇ')).toBe('')
        expect(creatorKey(undefined)).toBe('')
    })
})

describe('organizeCreatorFolders', () => {
    it('gathers loose bots of one creator where the first one was, leaving other folders alone', () => {
        n = 0
        const order: Entry[] = ['x', 'k1', f('User', ['k2']), 't1', 'k3', 'solo', 't2', 'a1', 'a2']
        expect(ids(organizeCreatorFolders(order, creators, newId))).toEqual([
            'x', `[${CREATOR_FOLDER_PREFIX}Kokomi:k1,k3]`, '[User:k2]', `[${CREATOR_FOLDER_PREFIX}toxin:t1,t2]`, 'solo', 'a1', 'a2',
        ])
    })

    it('shows a one-creator [유사 후보] folder inside the creator folder; a mixed one stays', () => {
        n = 0
        const order: Entry[] = [similar('S1', ['k1', 'k2']), similar('Mixed', ['k3', 't1']), 'k4', 't2']
        const next = organizeCreatorFolders(order, creators, newId)
        expect(ids(next)).toEqual([`[${CREATOR_FOLDER_PREFIX}Kokomi:k4]`, '[S1:k1,k2^C1]', '[Mixed:k3,t1]', 't2'])
    })

    it('fills an existing creator folder and changes nothing when nothing is loose', () => {
        const order: Entry[] = [f('K', ['k1'], { nodeOnlyCreatorKey: 'kokomi' }), 'k2']
        expect(ids(organizeCreatorFolders(order, creators, newId))).toEqual(['[K:k1,k2]'])
        const settled: Entry[] = [f('K', ['k1', 'k2'], { nodeOnlyCreatorKey: 'kokomi' }), 'x']
        expect(organizeCreatorFolders(settled, creators, newId)).toBe(settled)
    })
})

describe('placeImportedByCreator', () => {
    it('moves a new loose bot to the front of its creator folder', () => {
        const order: Entry[] = ['k4', 'x', f('K', ['k1'], { nodeOnlyCreatorKey: 'kokomi' })]
        expect(ids(placeImportedByCreator(order, 'k4', creators))).toEqual(['x', '[K:k4,k1]'])
    })

    it('shows the [유사 후보] folder an import made inside the creator folder', () => {
        const order: Entry[] = [similar('S', ['k4', 'k2']), f('K', ['k1'], { nodeOnlyCreatorKey: 'kokomi' })]
        expect(ids(placeImportedByCreator(order, 'k4', creators))).toEqual(['[S:k4,k2^K]', '[K:k1]'])
    })

    it('leaves the order alone without a creator folder, a creator, or for a user folder', () => {
        const order: Entry[] = ['t1', f('User', ['k4']), f('K', ['k1'], { nodeOnlyCreatorKey: 'kokomi' })]
        expect(placeImportedByCreator(order, 't1', creators)).toBe(order)
        expect(placeImportedByCreator(order, 'x', creators)).toBe(order)
        expect(placeImportedByCreator(order, 'k4', creators)).toBe(order)
    })
})
