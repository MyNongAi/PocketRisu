import { describe, expect, it } from 'vitest'
import type { RisuPersona } from './storage/database.svelte'
import {
    addNameOnlyNames,
    boundPersona,
    isNameOnlyPersona,
    keepsNameOnly,
    nameOnlyNamesFor,
    nameOnlyPersonaCount,
    personaFromNameOnly,
    retireNameOnlyPersonas,
    setNameOnlyName,
} from './nameOnlyPersona'

const persona = (id: string, fields: Partial<RisuPersona> = {}): RisuPersona => ({ id, name: id, icon: '', personaPrompt: '', note: '', ...fields })

describe('name-only persona bindings', () => {
    it('draws a chat bound to a name as a persona with only that name', () => {
        const db = { personas: [persona('alpha', { personaPrompt: 'tall' })], nodeOnlyPersonaNames: { kim: '김' } }
        expect(boundPersona(db, 'alpha')).toBe(db.personas[0])
        expect(boundPersona(db, 'kim')).toEqual({ id: 'kim', name: '김', icon: '', personaPrompt: '', note: '' })
        expect(boundPersona(db, 'gone')).toBeUndefined()
        expect(boundPersona(db, '')).toBeUndefined()
        // An inherited key is no binding.
        expect(boundPersona(db, 'toString')).toBeUndefined()
    })

    it('stays a name until a description or note is typed, then becomes a persona under its id', () => {
        expect(keepsNameOnly({ name: '김' })).toBe(true)
        expect(keepsNameOnly({ personaPrompt: '  ' })).toBe(true)
        expect(keepsNameOnly({ personaPrompt: 'tall' })).toBe(false)
        expect(keepsNameOnly({ note: 'main' })).toBe(false)

        const db: { personas: RisuPersona[], nodeOnlyPersonaNames?: Record<string, string> } = { personas: [persona('alpha')] }
        setNameOnlyName(db, 'kim', '김')
        setNameOnlyName(db, 'kim', '김철수')
        expect(db.nodeOnlyPersonaNames).toEqual({ kim: '김철수' })

        expect(personaFromNameOnly(db, 'gone', { personaPrompt: 'x' })).toBe(-1)
        expect(personaFromNameOnly(db, 'kim', { personaPrompt: 'tall' }, 5)).toBe(1)
        expect(db.personas[1]).toEqual({ id: 'kim', name: '김철수', icon: '', personaPrompt: 'tall', note: '', createdAt: 5, lastAppliedAt: 5 })
        expect(db.nodeOnlyPersonaNames).toEqual({})
        expect(boundPersona(db, 'kim')).toBe(db.personas[1])
    })

    it('counts and retires personas with nothing but a name, keeping their names for the chats bound to them', () => {
        const db = {
            selectedPersona: 3,
            personas: [
                persona('blank', { name: '', nodeOnlyBlank: true }),
                persona('only-name'),
                persona('described', { personaPrompt: 'tall' }),
                persona('selected'),
                persona('noted', { note: 'main' }),
                persona('pictured', { icon: 'assets/a.png' }),
                persona('starred', { favorite: true }),
                persona('filed', { folderId: 'f' }),
                { name: 'no id', icon: '', personaPrompt: '' },
                persona('only-name-2', { personaPrompt: '   ' }),
            ] as RisuPersona[],
            nodeOnlyPersonaNames: { older: '옛 이름' } as Record<string, string>,
        }
        expect(isNameOnlyPersona(db, 0)).toBe(false)
        expect(isNameOnlyPersona(db, 3)).toBe(false)
        expect(nameOnlyPersonaCount(db)).toBe(3)

        const selected = db.personas[3]
        expect(retireNameOnlyPersonas(db)).toBe(3)
        expect(db.personas.map((entry) => entry.id)).toEqual(['blank', 'described', 'selected', 'noted', 'pictured', 'starred', 'filed'])
        expect(db.personas[db.selectedPersona]).toBe(selected)
        expect(db.nodeOnlyPersonaNames).toEqual({ older: '옛 이름', 'only-name': 'only-name', 'only-name-2': 'only-name-2' })
        expect(boundPersona(db, 'only-name')?.name).toBe('only-name')
        expect(retireNameOnlyPersonas(db)).toBe(0)
    })

    it('carries the names a package\'s chats bind, never renaming one the database has', () => {
        const source = { nodeOnlyPersonaNames: { kim: '김', lee: '이' } }
        expect(nameOnlyNamesFor(source, [{ bindedPersona: 'kim' }, { bindedPersona: 'alpha' }, {}, null])).toEqual({ kim: '김' })

        const db: { personas: RisuPersona[], nodeOnlyPersonaNames?: Record<string, string> } = { personas: [], nodeOnlyPersonaNames: { kim: '김민수' } }
        addNameOnlyNames(db, { kim: '김', park: '박', bad: 3 })
        expect(db.nodeOnlyPersonaNames).toEqual({ kim: '김민수', park: '박' })
        addNameOnlyNames(db, undefined)
        addNameOnlyNames(db, ['x'])
        expect(db.nodeOnlyPersonaNames).toEqual({ kim: '김민수', park: '박' })
    })
})
