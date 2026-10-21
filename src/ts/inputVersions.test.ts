import { describe, expect, it } from 'vitest'
import { inputVersionIndex, isRequestInput, pressedInput, recordInputEdit, recordRequestInput, recordSentRequestInput, rekeyRequestMark, requestedInputVersion, requestInputText, stepInputVersion, swipeRequestedWith, textHash } from './inputVersions'

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

    it('takes the newest input as it is when pressed', () => {
        const messages = [
            { role: 'user', data: 'old', chatId: 'u1' },
            { role: 'char', data: 'reply', chatId: 'c1' },
            { role: 'user', data: 'newest', chatId: 'u2' },
            { role: 'user', data: 'note', chatId: 'u3', isComment: true },
            { role: 'char', data: 'reply 2', chatId: 'c2' },
            { role: 'user', data: 'off', chatId: 'u4', disabled: true },
        ]
        expect(pressedInput(messages)).toEqual({ chatId: 'u2', text: 'newest' })
        expect(pressedInput([{ role: 'char', data: 'only a reply' }])).toBeUndefined()
        expect(pressedInput([{ role: 'user', data: 'no id' }])).toBeUndefined()
    })

    it('a request reads the version shown when it was pressed, not one picked after', () => {
        const input = { chatId: 'u1', data: 'b', nodeOnlyInputVersions: ['a', 'b'] } as any
        const pressed = pressedInput([{ role: 'user', ...input }])
        stepInputVersion(input, -1)
        expect(input.data).toBe('a')
        expect(requestInputText(input, pressed)).toBe('b')
        // the version picked after the press is the input for the next request
        expect(requestInputText(input, undefined)).toBe('a')
    })

    it('reads a change from elsewhere as it is', () => {
        const pressed = { chatId: 'u1', text: 'b' }
        // a trigger rewrote the input: not one of its versions
        expect(requestInputText({ chatId: 'u1', data: 'rewritten', nodeOnlyInputVersions: ['a', 'b'] } as any, pressed)).toBe('rewritten')
        // another message, or one without versions
        expect(requestInputText({ chatId: 'u2', data: 'a', nodeOnlyInputVersions: ['a', 'b'] } as any, pressed)).toBe('a')
        expect(requestInputText({ chatId: 'u1', data: 'a' } as any, pressed)).toBe('a')
    })

    it('keeps the mark when a picture is added to the reply afterwards', () => {
        const reply = { data: 'reply' } as any
        recordRequestInput(reply, 'input a')
        const tagged = 'reply\n{{inlay::x}}'
        rekeyRequestMark(reply, 'reply', tagged)
        reply.data = tagged
        expect(isRequestInput(reply, 'input a')).toBe(true)
        expect(Object.keys(reply.nodeOnlyRequestInputs)).toEqual([textHash(tagged)])
    })
})

describe('a reply and its input as pairs', () => {
    // Swipe 1 was requested with "v1", swipe 2 with "v2"; swipe 3 has no mark.
    const reply = () => {
        const r = { data: 'second', swipes: ['first', 'second', 'third'], swipeId: 1 } as any
        const marks = { [textHash('first')]: textHash('v1'), [textHash('second')]: textHash('v2') }
        r.nodeOnlyRequestInputs = marks
        return r
    }
    const input = { data: 'v1', nodeOnlyInputVersions: ['v1', 'v2'] }

    it('finds the input version a shown swipe was requested with', () => {
        expect(requestedInputVersion(reply(), input)).toBe('v2')
        const r = reply()
        r.data = 'first'
        expect(requestedInputVersion(r, input)).toBe('v1')
        r.data = 'third'
        expect(requestedInputVersion(r, input)).toBeNull()
        // a version since removed from the list is not brought back
        expect(requestedInputVersion(reply(), { data: 'v1', nodeOnlyInputVersions: ['v1', 'v3'] })).toBeNull()
    })

    it('finds the newest swipe requested with an input version', () => {
        expect(swipeRequestedWith(reply(), 'v1')).toBe(0)
        expect(swipeRequestedWith(reply(), 'v2')).toBe(1)
        expect(swipeRequestedWith(reply(), 'v3')).toBe(-1)
        expect(swipeRequestedWith({ data: 'x' }, 'v1')).toBe(-1)
    })
})
