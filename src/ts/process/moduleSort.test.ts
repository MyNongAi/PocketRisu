import { describe, expect, it } from 'vitest'
import {
    activationHistoryAfterPlacement,
    getLatestModuleCatalogPromotion,
    interleaveModuleCatalogGroups,
    recordModuleActivation,
    recordModuleFolderActivation,
    recordModuleFolderOrder,
    recordNewModules,
    seedModuleActivationHistory,
    shouldRootModulesLeadByActivation,
    sortModuleFoldersByActivation,
    sortModulesByActivation,
} from './moduleSort'

describe('interleaved module catalog', () => {
    const groups = [
        { folder: { id: 'first' }, indexes: [1] },
        { folder: { id: 'second' }, indexes: [3] },
        { folder: null, indexes: [0, 2, 4] },
    ]

    it('keeps unrelated folders between standalone modules instead of grouping all folders second', () => {
        expect(interleaveModuleCatalogGroups(groups, 2)).toEqual([
            { kind: 'root', indexes: [2, 0] },
            { kind: 'folder', folderId: 'first' },
            { kind: 'folder', folderId: 'second' },
            { kind: 'root', indexes: [4] },
        ])
    })

    it('promotes only the active folder and leaves the remaining entries interleaved', () => {
        expect(interleaveModuleCatalogGroups(groups, -1, 'second')).toEqual([
            { kind: 'folder', folderId: 'second' },
            { kind: 'root', indexes: [0] },
            { kind: 'folder', folderId: 'first' },
            { kind: 'root', indexes: [2, 4] },
        ])
    })
})

const modules = [
    { id: 'bravo', name: 'Bravo' },
    { id: 'alpha', name: 'Alpha' },
    { id: 'charlie', name: 'Charlie' },
    { id: 'delta', name: 'Delta' },
]

describe('sortModulesByActivation', () => {
    it('uses existing module order as a fallback when no history exists', () => {
        const sorted = sortModulesByActivation(modules, '', {
            fallbackOrders: [['alpha', 'charlie']],
        })

        expect(sorted.map((module) => module.id)).toEqual([
            'charlie',
            'alpha',
            'bravo',
            'delta',
        ])
    })

    it('uses later activation scopes as the latest occurrence', () => {
        const sorted = sortModulesByActivation(
            modules,
            '',
            {
                fallbackOrders: [
                    ['charlie', 'alpha'],
                    ['bravo', 'charlie'],
                ],
            },
        )

        expect(sorted.map((module) => module.id)).toEqual([
            'charlie',
            'bravo',
            'alpha',
            'delta',
        ])
    })

    it('keeps search filtering while preserving activation sorting', () => {
        const sorted = sortModulesByActivation(modules, 'ha', {
            fallbackOrders: [['alpha', 'charlie']],
        })

        expect(sorted.map((module) => module.id)).toEqual([
            'charlie',
            'alpha',
        ])
    })

    it('keeps recently deactivated modules ahead of never-used modules', () => {
        const sorted = sortModulesByActivation(modules, '', {
            fallbackOrders: [['alpha']],
            activationHistory: ['charlie', 'alpha', 'delta'],
        })

        expect(sorted.map((module) => module.id)).toEqual([
            'delta',
            'alpha',
            'charlie',
            'bravo',
        ])
    })

    it('moves a reactivated module to the newest history position', () => {
        expect(recordModuleActivation(['alpha', 'charlie'], 'alpha')).toEqual([
            'charlie',
            'alpha',
        ])
    })

    it('records newly added modules as the newest catalog entries', () => {
        expect(recordNewModules(
            ['old'],
            [['enabled']],
            ['import-a', 'import-b'],
        )).toEqual(['enabled', 'old', 'import-a', 'import-b'])
    })

    it('seeds legacy active modules before recording later changes', () => {
        expect(seedModuleActivationHistory(
            ['charlie'],
            ['alpha', 'bravo'],
        )).toEqual(['alpha', 'bravo', 'charlie'])
    })

    it('floats the folder containing the most recently activated module without mutating folders', () => {
        const folders = [
            { id: 'older', moduleIds: ['alpha'] },
            { id: 'inactive', moduleIds: ['bravo'] },
            { id: 'newer', moduleIds: ['charlie'] },
        ]
        const sorted = sortModuleFoldersByActivation(folders, modules, {
            activationHistory: ['alpha', 'charlie'],
        })

        expect(sorted.map((folder) => folder.id)).toEqual(['newer', 'older', 'inactive'])
        expect(folders.map((folder) => folder.id)).toEqual(['older', 'inactive', 'newer'])
    })

    it('also reads official module.folderId membership', () => {
        const sorted = sortModuleFoldersByActivation(
            [{ id: 'first' }, { id: 'second' }],
            [{ id: 'alpha', name: 'Alpha', folderId: 'second' }],
            { activationHistory: ['alpha'] },
        )

        expect(sorted.map((folder) => folder.id)).toEqual(['second', 'first'])
    })

    it('keeps favorites above recent modules without changing source order', () => {
        const source = modules.map((module) => ({ ...module, favorite: module.id === 'bravo' }))
        const sorted = sortModulesByActivation(source, '', { activationHistory: ['alpha', 'charlie'] })
        expect(sorted.map((module) => module.id)).toEqual(['bravo', 'charlie', 'alpha', 'delta'])
        expect(source.map((module) => module.id)).toEqual(modules.map((module) => module.id))
    })

    it('preserves manual folder order across rerenders despite old activation history', () => {
        const folders = recordModuleFolderOrder([
            { id: 'alpha-folder', moduleIds: ['alpha'] },
            { id: 'charlie-folder', moduleIds: ['charlie'] },
        ])
        const options = { activationHistory: ['alpha', 'charlie'] }
        const first = sortModuleFoldersByActivation(folders, modules, options)
        const second = sortModuleFoldersByActivation(first, modules, options)
        expect(first.map((folder) => folder.id)).toEqual(['alpha-folder', 'charlie-folder'])
        expect(second).toEqual(first)
    })

    it('promotes the activated folder to the absolute top after a manual move', () => {
        const folders = recordModuleFolderOrder([
            { id: 'pinned', moduleIds: ['bravo'], favorite: true },
            { id: 'alpha-folder', moduleIds: ['alpha'] },
            { id: 'charlie-folder', moduleIds: ['charlie'] },
        ])
        const promoted = recordModuleFolderActivation(folders, modules, 'charlie', { activationHistory: ['charlie'] })
        const sorted = sortModuleFoldersByActivation(promoted, modules)
        expect(sorted.map((folder) => folder.id)).toEqual(['charlie-folder', 'pinned', 'alpha-folder'])
        expect(folders.map((folder) => folder.id)).toEqual(['pinned', 'alpha-folder', 'charlie-folder'])
        expect(sortModuleFoldersByActivation(sorted, modules)).toEqual(sorted)
    })

    it('leaves folders unchanged for uncategorized activation', () => {
        const folders = [{ id: 'folder', moduleIds: ['alpha'] }]
        expect(recordModuleFolderActivation(folders, modules, 'bravo')).toEqual(folders)
    })

    it('puts a newly activated member folder above loose modules', () => {
        const source = [
            { id: 'loose', name: 'Loose' },
            { id: 'foldered', name: 'Foldered', folderId: 'folder' },
        ]
        const folders = [{ id: 'folder', moduleIds: ['foldered'] }]

        expect(shouldRootModulesLeadByActivation(source, folders, {
            activationHistory: ['loose', 'foldered'],
        })).toBe(false)
        expect(shouldRootModulesLeadByActivation(source, folders, {
            activationHistory: ['foldered', 'loose'],
        })).toBe(true)
    })

    it('identifies one concrete top-level entry instead of promoting its whole block', () => {
        const source = [
            { id: 'loose-a', name: 'Loose A' },
            { id: 'foldered', name: 'Foldered', folderId: 'folder' },
            { id: 'loose-b', name: 'Loose B' },
        ]
        const folders = [{ id: 'folder', moduleIds: ['foldered'] }]

        expect(getLatestModuleCatalogPromotion(source, folders, {
            activationHistory: ['loose-a', 'loose-b', 'foldered'],
        })).toEqual({ moduleId: 'foldered', folderId: 'folder' })
        expect(getLatestModuleCatalogPromotion(source, folders, {
            activationHistory: ['foldered', 'loose-a'],
        })).toEqual({ moduleId: 'loose-a', folderId: undefined })
    })

    it('also detects legacy folder membership when choosing the leading block', () => {
        expect(shouldRootModulesLeadByActivation(
            [{ id: 'legacy', name: 'Legacy' }],
            [{ id: 'folder', moduleIds: ['legacy'] }],
            { activationHistory: ['legacy'] },
        )).toBe(false)
    })

    it('uses a deterministic order when older backups mix ranked and unranked folders', () => {
        const folders = [
            { id: 'unranked', moduleIds: ['charlie'] },
            { id: 'ranked', moduleIds: ['alpha'], sortOrder: 0 },
            { id: 'unranked-second', moduleIds: ['bravo'] },
        ]
        const first = sortModuleFoldersByActivation(folders, modules, { activationHistory: ['charlie'] })
        expect(first.map((folder) => folder.id)).toEqual(['ranked', 'unranked', 'unranked-second'])
        expect(sortModuleFoldersByActivation(first, modules, { activationHistory: ['bravo'] })).toEqual(first)
    })
})

describe('activationHistoryAfterPlacement', () => {
    // Recency, oldest first: M4 M3 M5 M2 M1 M6 M8. Shown newest first.
    const history = ['M4', 'M3', 'M5', 'M2', 'M1', 'M6', 'M8']
    const before = [
        { id: 'M8', folderId: 'F3' }, { id: 'M6' }, { id: 'M1', folderId: 'F1' }, { id: 'M2', folderId: 'F1' },
        { id: 'M5' }, { id: 'M3', folderId: 'F2' }, { id: 'M4', folderId: 'F2' }, { id: 'M7', folderId: 'F3' },
    ]

    it('keeps the history when a folder is deleted (its modules only change group)', () => {
        // FolderedList lists folders first, then the top level.
        const after = [
            { id: 'M8', folderId: 'F3' }, { id: 'M7', folderId: 'F3' }, { id: 'M3', folderId: 'F2' }, { id: 'M4', folderId: 'F2' },
            { id: 'M6' }, { id: 'M1' }, { id: 'M2' }, { id: 'M5' },
        ]
        expect(activationHistoryAfterPlacement(before, after, history)).toEqual(history)
    })

    it('keeps the history when a module moves to another folder', () => {
        const after = before.map((item) => (item.id === 'M6' ? { id: 'M6', folderId: 'F2' } : item))
        expect(activationHistoryAfterPlacement(before, after, history)).toEqual(history)
    })

    it('swaps only the recency slots of modules reordered within their group', () => {
        // M5 dragged above M6 at the top level; nothing else moves.
        const after = [
            { id: 'M8', folderId: 'F3' }, { id: 'M7', folderId: 'F3' }, { id: 'M1', folderId: 'F1' }, { id: 'M2', folderId: 'F1' },
            { id: 'M3', folderId: 'F2' }, { id: 'M4', folderId: 'F2' }, { id: 'M5' }, { id: 'M6' },
        ]
        expect(activationHistoryAfterPlacement(before, after, history)).toEqual(['M4', 'M3', 'M6', 'M2', 'M1', 'M5', 'M8'])
    })

    it('gives a slot to a module without recency that was dragged up', () => {
        // M7 (never used) above M8 in F3.
        const after = before.map((item) => item.id === 'M8' ? { id: 'M7', folderId: 'F3' } : item.id === 'M7' ? { id: 'M8', folderId: 'F3' } : item)
        const next = activationHistoryAfterPlacement(before, after, history)
        expect(next.indexOf('M7')).toBeGreaterThan(next.indexOf('M8'))
        expect(next.filter((id) => id !== 'M7' && id !== 'M8')).toEqual(['M4', 'M3', 'M5', 'M2', 'M1', 'M6'])
    })
})
