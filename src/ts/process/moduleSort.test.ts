import { describe, expect, it } from 'vitest'
import {
    recordModuleActivation,
    recordModuleFolderActivation,
    recordModuleFolderOrder,
    recordNewModules,
    seedModuleActivationHistory,
    sortModuleFoldersByActivation,
    sortModulesByActivation,
} from './moduleSort'

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

    it('promotes only the activated folder after a manual move while favorites remain first', () => {
        const folders = recordModuleFolderOrder([
            { id: 'pinned', moduleIds: ['bravo'], favorite: true },
            { id: 'alpha-folder', moduleIds: ['alpha'] },
            { id: 'charlie-folder', moduleIds: ['charlie'] },
        ])
        const promoted = recordModuleFolderActivation(folders, modules, 'charlie', { activationHistory: ['charlie'] })
        const sorted = sortModuleFoldersByActivation(promoted, modules)
        expect(sorted.map((folder) => folder.id)).toEqual(['pinned', 'charlie-folder', 'alpha-folder'])
        expect(folders.map((folder) => folder.id)).toEqual(['pinned', 'alpha-folder', 'charlie-folder'])
        expect(sortModuleFoldersByActivation(sorted, modules)).toEqual(sorted)
    })

    it('leaves folders unchanged for uncategorized activation', () => {
        const folders = [{ id: 'folder', moduleIds: ['alpha'] }]
        expect(recordModuleFolderActivation(folders, modules, 'bravo')).toEqual(folders)
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
