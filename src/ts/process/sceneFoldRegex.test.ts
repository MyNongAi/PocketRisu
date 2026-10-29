import { writable } from 'svelte/store'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { risuChatParser } from '../parser/parser.svelte'
import { REQUEST_REGEX } from '../../../modules/scene-fold/build.mjs'

// The 📁 장면 접기 module's request regexes (modules/scene-fold/build.mjs) run
// through the real CBS parser, the way processScriptFull applies a regex with
// the <cbs> flag to a message while the request is built.

const store = vi.hoisted(() => ({ global: {} as Record<string, string>, chat: {} as Record<string, string> }))

vi.mock(import('../storage/database.svelte'), () => ({
    appVer: '1234.5.67',
    getCurrentCharacter: () => ({}),
    getCurrentChat: () => ({}),
    getDatabase: () => ({}),
}) as unknown as typeof import('../storage/database.svelte'))

vi.mock(import('../globalApi.svelte'), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(''),
}) as unknown as typeof import('../globalApi.svelte'))

vi.mock(import('../stores.svelte'), () => ({
    DBState: {
        db: {
            characters: [{ chatPage: 0, chats: [{ scriptstate: store.chat }], defaultVariables: '' }],
            globalChatVariables: store.global,
            templateDefaultVariables: '',
        },
    },
    selIdState: { selId: 0 },
    selectedCharID: writable(0),
}) as unknown as typeof import('../stores.svelte'))

function request(text: string): string {
    let data = risuChatParser(text)
    for (const script of REQUEST_REGEX) {
        const reg = new RegExp(risuChatParser(script.in), 'g')
        if (reg.test(data)) data = risuChatParser(data.replace(reg, script.out.replaceAll('$n', '\n')))
    }
    return data
}

beforeEach(() => {
    for (const key of Object.keys(store.global)) delete store.global[key]
    for (const key of Object.keys(store.chat)) delete store.chat[key]
    store.chat.$sf_text_ab12cd34 = '[Folded scene · battle] The full text of this finished scene was left out; this is what happened:\nWon.'
})

describe('the request regexes', () => {
    test('the first message of a folded scene becomes its summary, the others go empty', () => {
        expect(request('fight\n<!--sf:s:battle:ab12cd34-->\n<!--sf:f:battle:ab12cd34-->')).toBe(store.chat.$sf_text_ab12cd34)
        expect(request('hit\n<!--sf:m:ab12cd34-->')).toBe('')
        expect(request('won\n<!--sf:e:ab12cd34-->\n<!--sf:m:ab12cd34-->')).toBe('')
    })

    test('a scene not folded yet, or a plain message, stays as it is', () => {
        expect(request('fight\n<!--sf:s:battle:ab12cd34-->')).toBe('fight\n<!--sf:s:battle:ab12cd34-->')
        expect(request('just talking')).toBe('just talking')
    })

    test('a battle inside a folded run goes with the run', () => {
        expect(request('fight\n<!--sf:s:battle:b1-->\n<!--sf:f:battle:b1-->\n<!--sf:m:ab12cd34-->')).toBe('')
        store.chat.$sf_text_r1 = '[Undone run 1 · only Subaru remembers] ...'
        expect(request('woke up\n<!--sf:s:loop:r1-->\n<!--sf:f:battle:b2-->\n<!--sf:f:loop:r1-->')).toBe(store.chat.$sf_text_r1)
    })

    test('요청에서만 접기 (choice 2) leaves every message as it is; the other choices take scenes out', () => {
        store.global['toggle_scenefold.cut'] = '2'
        expect(request('hit\n<!--sf:m:ab12cd34-->')).toBe('hit\n<!--sf:m:ab12cd34-->')
        expect(request('fight\n<!--sf:f:battle:ab12cd34-->')).toBe('fight\n<!--sf:f:battle:ab12cd34-->')
        store.global['toggle_scenefold.cut'] = '1'
        expect(request('hit\n<!--sf:m:ab12cd34-->')).toBe('')
        store.global['toggle_scenefold.cut'] = '0'
        expect(request('hit\n<!--sf:m:ab12cd34-->')).toBe('')
    })
})
