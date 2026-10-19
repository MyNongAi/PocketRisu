import { describe, expect, it } from 'vitest'
import { inputVersionIndex, isRequestInput, recordInputEdit, recordRequestInput, recordSentRequestInput, stepInputVersion, textHash } from './inputVersions'

describe('input versions', () => {
    it('keeps the sent input and each saved edit, in order', () => {
        const input = { data: 'sent text' } as any
        expect(inputVersionIndex(input)).toBe(-1)
        expect(recordInputEdit(input, 'sent text')).toBe(false)
        recordInputEdit(input, 'edited once')
        recordInputEdit(input, 'edited twice')
        expect(input.nodeOnlyInputVersions).toEqual(['sent text', 'edited once', 'edited twice'])
        expect(inputVersionIndex(input)).toBe(2)
    })

    it('steps through the versions, wrapping, and the shown one becomes the input', () => {
        const input = { data: 'b', nodeOnlyInputVersions: ['a', 'b'] } as any
        expect(stepInputVersion(input, -1)).toBe(true)
        expect(input.data).toBe('a')
        expect(stepInputVersion(input, -1)).toBe(true)
        expect(input.data).toBe('b')
        expect(stepInputVersion(input, 1)).toBe(true)
        expect(input.data).toBe('a')
        // Going back to an older version and saving does not duplicate it.
        recordInputEdit(input, 'b')
        expect(input.nodeOnlyInputVersions).toEqual(['a', 'b'])
    })

    it('adds an input changed elsewhere before stepping away from it', () => {
        const input = { data: 'changed elsewhere', nodeOnlyInputVersions: ['a', 'b'] } as any
        expect(stepInputVersion(input, -1)).toBe(true)
        expect(input.nodeOnlyInputVersions).toEqual(['a', 'b', 'changed elsewhere'])
        expect(input.data).toBe('b')
    })

    it('marks the input each swipe of a reply was requested with', () => {
        const reply = { data: 'first reply', swipes: ['first reply'] } as any
        recordRequestInput(reply, 'input a')
        expect(isRequestInput(reply, 'input a')).toBe(true)
        expect(isRequestInput(reply, 'input b')).toBe(false)

        reply.swipes.push('second reply')
        reply.data = 'second reply'
        recordRequestInput(reply, 'input b')
        expect(isRequestInput(reply, 'input b')).toBe(true)
        reply.data = 'first reply'
        expect(isRequestInput(reply, 'input a')).toBe(true)

        // A swipe that is gone loses its mark on the next write.
        reply.swipes = ['second reply']
        reply.data = 'second reply'
        recordRequestInput(reply, 'input b')
        expect(Object.keys(reply.nodeOnlyRequestInputs)).toEqual([textHash('second reply')])
    })

    it('marks the input the request read, not the one shown when the reply is done', () => {
        const input = { chatId: 'in-1', data: 'b', nodeOnlyInputVersions: ['a', 'b'] } as any
        const sent = { chatId: 'in-1', text: input.data }
        // The arrows are used while the reply is being written.
        stepInputVersion(input, -1)
        expect(input.data).toBe('a')

        const reply = { data: 'reply', swipes: ['reply'] } as any
        expect(recordSentRequestInput(reply, input, sent)).toBe(true)
        expect(isRequestInput(reply, 'b')).toBe(true)
        expect(isRequestInput(reply, 'a')).toBe(false)
    })

    it('marks nothing when the read input is not the one before the reply', () => {
        const reply = { data: 'reply' } as any
        expect(recordSentRequestInput(reply, { chatId: 'in-2' }, { chatId: 'in-1', text: 'a' })).toBe(false)
        expect(recordSentRequestInput(reply, { chatId: 'in-1' }, undefined)).toBe(false)
        expect(reply.nodeOnlyRequestInputs).toBeUndefined()
    })

    it('keeps the marks of earlier swipes when a reroll carries them to the new reply', () => {
        const old = { data: 'first', swipes: ['first'] } as any
        recordRequestInput(old, 'input a')
        const next = { data: 'second', swipes: ['first', 'second'], nodeOnlyRequestInputs: { ...old.nodeOnlyRequestInputs } } as any
        recordRequestInput(next, 'input b')
        expect(isRequestInput(next, 'input b')).toBe(true)
        next.data = 'first'
        expect(isRequestInput(next, 'input a')).toBe(true)
    })
})
