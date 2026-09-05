import { describe, expect, it } from 'vitest'
import type { folder } from 'src/ts/storage/database.svelte'
import {
    applySidebarItemDrop,
    moveSidebarItem,
    type SidebarOrder,
} from './sidebarDrag'

function makeFolder(id: string, data: string[], extra: Partial<folder> = {}): folder {
    return { id, data, name: id, color: '', ...extra }
}

const createFolder = () => ({ id: 'created', name: 'New Folder', color: '' })

describe('moveSidebarItem', () => {
    it('moves a root character into a folder without mutating metadata or input', () => {
        const source: SidebarOrder = [
            'alpha',
            makeFolder('favorites', ['beta'], { favorite: true, sourceInfo: { label: 'web' } as any }),
            'gamma',
        ]
        const moved = moveSidebarItem(source, { kind: 'character', id: 'alpha' }, {
            kind: 'folder', folderId: 'favorites', index: 1,
        })

        expect(moved).toEqual([
            makeFolder('favorites', ['beta', 'alpha'], { favorite: true, sourceInfo: { label: 'web' } as any }),
            'gamma',
        ])
        expect(source).toEqual([
            'alpha',
            makeFolder('favorites', ['beta'], { favorite: true, sourceInfo: { label: 'web' } as any }),
            'gamma',
        ])
    })

    it('moves a folder child back to the root by stable id after order changes', () => {
        const moved = moveSidebarItem(
            ['new-import', makeFolder('old-folder', ['alpha', 'beta']), 'omega'],
            { kind: 'character', id: 'beta' },
            { kind: 'root', index: 1 },
        )

        expect(moved).toEqual(['new-import', 'beta', makeFolder('old-folder', ['alpha']), 'omega'])
    })

    it('reorders inside one folder and corrects the removal offset', () => {
        const moved = moveSidebarItem(
            [makeFolder('folder', ['alpha', 'beta', 'gamma'])],
            { kind: 'character', id: 'alpha' },
            { kind: 'folder', folderId: 'folder', index: 3 },
        )

        expect(moved).toEqual([makeFolder('folder', ['beta', 'gamma', 'alpha'])])
    })

    it('moves a whole folder only at root and preserves its custom fields', () => {
        const folder = makeFolder('folder', ['alpha'], { favorite: true, imgFile: 'external://disk/hash' })
        expect(moveSidebarItem(
            [folder, 'beta', 'gamma'],
            { kind: 'folder', id: 'folder' },
            { kind: 'root', index: 3 },
        )).toEqual(['beta', 'gamma', folder])
        expect(moveSidebarItem(
            [folder, makeFolder('other', [])],
            { kind: 'folder', id: 'folder' },
            { kind: 'folder', folderId: 'other', index: 0 },
        )).toBeNull()
    })

    it('refuses stale and ambiguous sources instead of deleting the wrong item', () => {
        const contaminated: SidebarOrder = ['duplicate', makeFolder('folder', ['duplicate'])]
        expect(moveSidebarItem(contaminated, { kind: 'character', id: 'duplicate' }, { kind: 'root', index: 0 }))
            .toBeNull()
        expect(moveSidebarItem(contaminated, { kind: 'character', id: 'missing' }, { kind: 'root', index: 0 }))
            .toBeNull()
        expect(contaminated).toEqual(['duplicate', makeFolder('folder', ['duplicate'])])
    })
})

describe('applySidebarItemDrop', () => {
    it('creates a folder from two root characters without mutating the source order', () => {
        const source: SidebarOrder = ['alpha', 'beta', makeFolder('existing', ['gamma'])]
        const moved = applySidebarItemDrop(
            source,
            { kind: 'character', id: 'alpha' },
            { kind: 'character', id: 'beta' },
            createFolder,
        )

        expect(moved).toEqual([
            { id: 'created', name: 'New Folder', color: '', data: ['alpha', 'beta'] },
            makeFolder('existing', ['gamma']),
        ])
        expect(source).toEqual(['alpha', 'beta', makeFolder('existing', ['gamma'])])
    })

    it('moves a character from another folder to the target folder bottom', () => {
        const moved = applySidebarItemDrop(
            [makeFolder('source-folder', ['alpha', 'sibling']), makeFolder('target-folder', ['beta'])],
            { kind: 'character', id: 'alpha' },
            { kind: 'folder', id: 'target-folder' },
            createFolder,
        )

        expect(moved).toEqual([
            makeFolder('source-folder', ['sibling']),
            makeFolder('target-folder', ['beta', 'alpha']),
        ])
    })

    it('does not merge onto a nested character or create duplicate folder ids', () => {
        expect(applySidebarItemDrop(
            ['alpha', makeFolder('folder', ['beta'])],
            { kind: 'character', id: 'alpha' },
            { kind: 'character', id: 'beta' },
            createFolder,
        )).toBeNull()
        expect(applySidebarItemDrop(
            ['alpha', 'beta', makeFolder('created', [])],
            { kind: 'character', id: 'alpha' },
            { kind: 'character', id: 'beta' },
            createFolder,
        )).toBeNull()
    })
})
