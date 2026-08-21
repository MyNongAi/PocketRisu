import { describe, expect, it } from 'vitest'
import { sortModulesByActivation } from './moduleSort'

const modules = [
    { id: 'bravo', name: 'Bravo' },
    { id: 'alpha', name: 'Alpha' },
    { id: 'charlie', name: 'Charlie' },
    { id: 'delta', name: 'Delta' },
]

describe('sortModulesByActivation', () => {
    it('puts active modules first with the newest activation at the top', () => {
        const sorted = sortModulesByActivation(modules, '', ['alpha', 'charlie'])

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
            ['charlie', 'alpha'],
            ['bravo', 'charlie'],
        )

        expect(sorted.map((module) => module.id)).toEqual([
            'charlie',
            'bravo',
            'alpha',
            'delta',
        ])
    })

    it('keeps search filtering while preserving activation sorting', () => {
        const sorted = sortModulesByActivation(modules, 'ha', ['alpha', 'charlie'])

        expect(sorted.map((module) => module.id)).toEqual([
            'charlie',
            'alpha',
        ])
    })
})
