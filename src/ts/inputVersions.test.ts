import { describe, expect, it } from 'vitest'
import { inputVersionIndex, isRequestInput, recordInputEdit, recordRequestInput, stepInputVersion, textHash } from './inputVersions'

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
})
