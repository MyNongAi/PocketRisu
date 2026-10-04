import { describe, expect, it } from 'vitest'
import { personaHasContent, splitBlankPersona } from './blankPersona'

const blank = () => ({ id: 'blank', name: 'User', personaPrompt: '', icon: '', note: '빈 페르소나', nodeOnlyBlank: true, favorite: true })
const other = () => ({ id: 'alpha', name: 'Alpha', personaPrompt: 'alpha', icon: 'a.png', note: '' })

describe('personaHasContent', () => {
    it('counts a description, an image or a name other than User', () => {
        expect(personaHasContent({ name: 'User', personaPrompt: '', icon: '' })).toBe(false)
        expect(personaHasContent({ name: ' ', personaPrompt: '  ', icon: '' })).toBe(false)
        expect(personaHasContent({ name: 'User', personaPrompt: '야구선수', icon: '' })).toBe(true)
        expect(personaHasContent({ name: 'User', personaPrompt: '', icon: 'x.png' })).toBe(true)
        expect(personaHasContent({ name: '박찬호', personaPrompt: '', icon: '' })).toBe(true)
    })
})

describe('splitBlankPersona', () => {
    it('moves what was typed into the global blank persona to a new global persona', () => {
        const db = {
            personas: [other(), { ...blank(), name: '박찬호', personaPrompt: '야구선수' }],
            selectedPersona: 1,
            username: '박찬호',
            personaPrompt: '야구선수',
            userIcon: '',
            userNote: '빈 페르소나',
        }
        expect(splitBlankPersona(db, 'new-id', 1000)).toBe(2)
        expect(db.personas[1]).toEqual({ ...blank(), largePortrait: false })
        expect(db.personas[2]).toEqual({ id: 'new-id', name: '박찬호', personaPrompt: '야구선수', icon: '', note: '', createdAt: 1000, lastAppliedAt: 1000 })
        expect(db.selectedPersona).toBe(2)
        expect(db.username).toBe('박찬호')
        expect(db.userNote).toBe('')
        // Idempotent.
        expect(splitBlankPersona(db, 'again')).toBe(-1)
        expect(db.personas).toHaveLength(3)
    })

    it('takes the root fields, not the stale card, while the blank is global', () => {
        const db = { personas: [blank()], selectedPersona: 0, username: 'Kim', personaPrompt: 'knight', userIcon: '', userNote: '메모' }
        splitBlankPersona(db, 'new-id', 5)
        expect(db.personas[1]).toMatchObject({ name: 'Kim', personaPrompt: 'knight', note: '메모' })
        expect(db.selectedPersona).toBe(1)
        expect(db.userNote).toBe('메모')
    })

    it('moves content out of a blank card that is not the global persona', () => {
        const db = { personas: [other(), { ...blank(), personaPrompt: 'oops' }], selectedPersona: 0, username: 'Alpha', personaPrompt: 'alpha', userIcon: 'a.png', userNote: '' }
        expect(splitBlankPersona(db, 'new-id', 7)).toBe(2)
        expect(db.personas[1].personaPrompt).toBe('')
        expect(db.personas[2]).toMatchObject({ name: 'User', personaPrompt: 'oops', note: '' })
        expect(db.selectedPersona).toBe(0)
        expect(db.username).toBe('Alpha')
    })

    it('leaves a blank blank persona and a list without one alone', () => {
        const db = { personas: [other(), blank()], selectedPersona: 1, username: 'User', personaPrompt: '', userIcon: '', userNote: '빈 페르소나' }
        expect(splitBlankPersona(db, 'x')).toBe(-1)
        expect(splitBlankPersona({ ...db, personas: [other()] }, 'x')).toBe(-1)
    })
})
