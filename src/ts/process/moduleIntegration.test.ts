import { describe, expect, it } from 'vitest'
import { addIntegration, integrationCandidates, integrationNames, removeIntegration, resolveIntegration } from './moduleIntegration'

const modules = [
    { id: 'm-life', name: 'Life module', namespace: 'boiled-egg' },
    { id: 'm-hn-a', name: 'Hunternet A', namespace: 'hn' },
    { id: 'm-hn-b', name: 'Hunternet B', namespace: 'hn' },
    { id: 'm-plain', name: 'Plain' },
    null,
]

describe('the preset module integration field', () => {
    it('reads the names, without blanks or repeats', () => {
        expect(integrationNames(' a, b ,,a, ')).toEqual(['a', 'b'])
        expect(integrationNames(undefined)).toEqual([])
    })

    it('shows what each name turns on, by namespace or id, and a name nothing matches', () => {
        expect(resolveIntegration('boiled-egg, hn, m-plain, Todo', modules)).toEqual([
            { value: 'boiled-egg', modules: [{ id: 'm-life', name: 'Life module' }] },
            { value: 'hn', modules: [{ id: 'm-hn-a', name: 'Hunternet A' }, { id: 'm-hn-b', name: 'Hunternet B' }] },
            { value: 'm-plain', modules: [{ id: 'm-plain', name: 'Plain' }] },
            { value: 'Todo', modules: [] },
        ])
    })

    it('adds and removes a name, once', () => {
        expect(addIntegration('a', 'b')).toBe('a, b')
        expect(addIntegration('a, b', 'a')).toBe('a, b')
        expect(addIntegration('', 'a')).toBe('a')
        expect(removeIntegration('a, b, c', 'b')).toBe('a, c')
        expect(removeIntegration('a', 'a')).toBe('')
    })

    it('offers the namespaces not linked yet, one entry per namespace', () => {
        expect(integrationCandidates('boiled-egg', modules)).toEqual([{ namespace: 'hn', names: ['Hunternet A', 'Hunternet B'] }])
        expect(integrationCandidates('', modules).map((c) => c.namespace)).toEqual(['hn', 'boiled-egg'])
    })
})
