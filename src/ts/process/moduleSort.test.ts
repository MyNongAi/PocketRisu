import { describe, expect, it } from 'vitest'
import { recordModuleActivation, sortModulesByActivation } from './moduleSort'

const modules = [
    { id: 'bravo', name: 'Bravo' },
    { id: 'alpha', name: 'Alpha' },
    { id: 'charlie', name: 'Charlie' },
    { id: 'delta', name: 'Delta' },
]

describe('sortModulesByActivation', () => {
    it('puts active modules first with the newest activation at the top', () => {
        const sorted = sortModulesByActivation(modules, '', {
            activeOrders: [['alpha', 'charlie']],
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
                activeOrders: [
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
            activeOrders: [['alpha', 'charlie']],
        })

        expect(sorted.map((module) => module.id)).toEqual([
            'charlie',
            'alpha',
        ])
    })

    it('keeps recently deactivated modules ahead of never-used modules', () => {
        const sorted = sortModulesByActivation(modules, '', {
            activeOrders: [['alpha']],
            activationHistory: ['charlie', 'alpha', 'delta'],
        })

        expect(sorted.map((module) => module.id)).toEqual([
            'alpha',
            'delta',
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
})
