import { describe, expect, it } from 'vitest'
import {
    recordModuleActivation,
    seedModuleActivationHistory,
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

    it('seeds legacy active modules before recording later changes', () => {
        expect(seedModuleActivationHistory(
            ['charlie'],
            ['alpha', 'bravo'],
        )).toEqual(['alpha', 'bravo', 'charlie'])
    })
})
