import { describe, expect, it } from 'vitest'
import {
    recordModuleActivation,
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
})
