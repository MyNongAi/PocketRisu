import { describe, expect, test } from 'vitest'
import {
    appendBtwExchange,
    BTW_LIMITS,
    BTW_SYSTEM_INSTRUCTION,
    buildBtwRequestMessages,
    cleanBtwMessageText,
    fillBtwPlaceholders,
    selectBtwTranscript,
    stripBtwThoughts,
    type BtwExchange,
    type BtwRequestInput,
    type BtwTranscriptMessage,
} from './btwSideChat'

const nameOf = (message: BtwTranscriptMessage) => message.role === 'user' ? 'Me' : 'Aria'

function chat(count: number, filler = 0): BtwTranscriptMessage[] {
    return Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? 'user' as const : 'char' as const,
        data: `m${i}:` + 'x'.repeat(filler),
    }))
}

function input(overrides: Partial<BtwRequestInput> = {}): BtwRequestInput {
    return {
        characterName: 'Aria',
        characterCard: 'A knight of the northern keep.',
        userName: 'Me',
        personaPrompt: 'A wandering bard.',
        transcript: { lines: ['Me: hello', 'Aria: hi'], omitted: 0 },
        history: [],
        question: 'What does Aria know about me?',
        ...overrides,
    }
}

describe('selectBtwTranscript', () => {
    test('keeps only the newest messages, oldest first', () => {
        const result = selectBtwTranscript(chat(50), nameOf, { maxMessages: 4 })
        expect(result.lines).toEqual([
            'Me: m46:',
            'Aria: m47:',
            'Me: m48:',
            'Aria: m49:',
        ])
        expect(result.omitted).toBe(46)
    })

    test('defaults to the documented message bound', () => {
        const result = selectBtwTranscript(chat(200), nameOf)
        expect(result.lines).toHaveLength(BTW_LIMITS.contextMessages)
        expect(result.omitted).toBe(200 - BTW_LIMITS.contextMessages)
    })

    test('stays within the character budget, dropping the oldest lines', () => {
        const messages = chat(40, 1000)
        const result = selectBtwTranscript(messages, nameOf, { maxChars: 5000 })
        const size = result.lines.reduce((sum, line) => sum + line.length + 1, 0)
        expect(size).toBeLessThanOrEqual(5000)
        expect(result.lines.at(-1)).toContain('m39:')
        expect(result.lines.length).toBeLessThan(40)
        expect(result.omitted).toBe(40 - result.lines.length)
    })

    test('a single message over the budget keeps its newest part', () => {
        const result = selectBtwTranscript([{ role: 'char', data: 'start' + 'y'.repeat(500) + 'END' }], nameOf, { maxChars: 100 })
        expect(result.lines).toHaveLength(1)
        expect(result.lines[0].startsWith('Aria: …')).toBe(true)
        expect(result.lines[0].endsWith('END')).toBe(true)
        expect(result.lines[0].length).toBeLessThanOrEqual(100)
    })

    test('follows the main prompt visibility rules', () => {
        const messages: BtwTranscriptMessage[] = [
            { role: 'user', data: 'too old' },
            { role: 'char', data: 'cut here', disabled: 'allBefore' },
            { role: 'user', data: 'kept 1' },
            { role: 'char', data: 'hidden', disabled: true },
            { role: 'char', data: 'kept 2' },
        ]
        const result = selectBtwTranscript(messages, nameOf, { greeting: { name: 'Aria', text: 'greeting' } })
        // The greeting belongs before the marker, so it is hidden as well.
        expect(result.lines).toEqual(['Me: kept 1', 'Aria: kept 2'])
    })

    test('adds the greeting only when the whole chat fits', () => {
        const greeting = { name: 'Aria', text: 'Welcome, {{user}}.' }
        const fill = (text: string) => fillBtwPlaceholders(text, 'Aria', 'Me')
        expect(selectBtwTranscript(chat(2), nameOf, { greeting, fill }).lines[0]).toBe('Aria: Welcome, Me.')
        expect(selectBtwTranscript(chat(10), nameOf, { greeting, maxMessages: 4 }).lines[0]).toBe('Me: m6:')
    })

    test('strips reasoning and inlay tokens and skips empty messages', () => {
        const messages: BtwTranscriptMessage[] = [
            { role: 'char', data: '<Thoughts>plan</Thoughts>She nods.{{inlayed::abc-123}}' },
            { role: 'char', data: '<Thoughts>only reasoning</Thoughts>' },
            { role: 'user', data: '{{char}}, look at {{user}}!' },
        ]
        const fill = (text: string) => fillBtwPlaceholders(text, 'Aria', 'Me')
        expect(selectBtwTranscript(messages, nameOf, { fill }).lines).toEqual(['Aria: She nods.', 'Me: Aria, look at Me!'])
    })
})

describe('text helpers', () => {
    test('stripBtwThoughts removes closed and still-open reasoning', () => {
        expect(stripBtwThoughts('<Thoughts>a</Thoughts>Answer')).toBe('Answer')
        expect(stripBtwThoughts('<Thoughts>still thinking')).toBe('')
    })

    test('cleanBtwMessageText keeps ordinary macros as written', () => {
        expect(cleanBtwMessageText(' {{getvar::mood}} ')).toBe('{{getvar::mood}}')
    })

    test('fillBtwPlaceholders fills only char and user placeholders', () => {
        expect(fillBtwPlaceholders('{{char}}/<bot>/{{User}}/<user>/{{setvar::a::1}}', 'Aria', 'Me'))
            .toBe('Aria/Aria/Me/Me/{{setvar::a::1}}')
        expect(fillBtwPlaceholders('{{char}} met {{user}}', 'Cash$&', '$1')).toBe('Cash$& met $1')
    })
})

describe('buildBtwRequestMessages', () => {
    test('one system message with the OOC instruction, card, persona and log, then the question', () => {
        const messages = buildBtwRequestMessages(input())
        expect(messages).toHaveLength(2)
        expect(messages[0].role).toBe('system')
        expect(messages[0].content.startsWith(BTW_SYSTEM_INSTRUCTION)).toBe(true)
        expect(messages[0].content).toContain('do not continue the roleplay')
        expect(messages[0].content).toContain('<character name="Aria">\nA knight of the northern keep.\n</character>')
        expect(messages[0].content).toContain('<user_persona name="Me">\nA wandering bard.\n</user_persona>')
        expect(messages[0].content).toContain('<chat_log note="The whole chat so far.">\nMe: hello\nAria: hi\n</chat_log>')
        expect(messages[1]).toEqual({ role: 'user', content: 'What does Aria know about me?' })
    })

    test('says how much of the chat was left out', () => {
        const messages = buildBtwRequestMessages(input({ transcript: { lines: ['Aria: last'], omitted: 41 } }))
        expect(messages[0].content).toContain('The last 1 messages; 41 earlier messages are not shown.')
    })

    test('an empty chat and missing card or persona still give a valid request', () => {
        const messages = buildBtwRequestMessages(input({ characterCard: ' ', personaPrompt: '', transcript: { lines: [], omitted: 0 } }))
        expect(messages[0].content).toContain('<character name="Aria" />')
        expect(messages[0].content).toContain('<user_persona name="Me" />')
        expect(messages[0].content).toContain('(The chat has no messages yet.)')
    })

    test('bounds the card and persona', () => {
        const messages = buildBtwRequestMessages(input({
            characterCard: 'c'.repeat(BTW_LIMITS.cardChars * 2),
            personaPrompt: 'p'.repeat(BTW_LIMITS.personaChars * 2),
        }))
        expect(messages[0].content).toContain('c'.repeat(BTW_LIMITS.cardChars - 1) + '…')
        expect(messages[0].content).not.toContain('c'.repeat(BTW_LIMITS.cardChars))
        expect(messages[0].content).not.toContain('p'.repeat(BTW_LIMITS.personaChars))
    })

    test('earlier side exchanges come before the question as user/assistant turns', () => {
        const history: BtwExchange[] = Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, answer: `a${i}`, time: i }))
        const messages = buildBtwRequestMessages(input({ history, question: 'follow-up' }))
        const turns = messages.slice(1)
        expect(turns).toHaveLength(BTW_LIMITS.historyExchanges * 2 + 1)
        expect(turns[0]).toEqual({ role: 'user', content: 'q3' })
        expect(turns[1]).toEqual({ role: 'assistant', content: 'a3' })
        expect(turns.at(-2)).toEqual({ role: 'assistant', content: 'a8' })
        expect(turns.at(-1)).toEqual({ role: 'user', content: 'follow-up' })
        // Roles alternate after the system message and end on the question.
        turns.forEach((turn, i) => expect(turn.role).toBe(i % 2 === 0 ? 'user' : 'assistant'))
    })

    test('long earlier answers are cut when sent as history', () => {
        const answer = 'z'.repeat(BTW_LIMITS.historyAnswerChars + 500)
        const messages = buildBtwRequestMessages(input({ history: [{ question: 'q', answer, time: 1 }] }))
        expect(messages[2].content.length).toBe(BTW_LIMITS.historyAnswerChars)
    })
})

describe('appendBtwExchange', () => {
    test('keeps the newest exchanges only and does not mutate the input', () => {
        const history: BtwExchange[] = Array.from({ length: BTW_LIMITS.storedExchanges }, (_, i) => ({ question: `q${i}`, answer: `a${i}`, time: i }))
        const next = appendBtwExchange(history, { question: 'new', answer: 'ans', time: 99 })
        expect(next).toHaveLength(BTW_LIMITS.storedExchanges)
        expect(next[0].question).toBe('q1')
        expect(next.at(-1)?.question).toBe('new')
        expect(history).toHaveLength(BTW_LIMITS.storedExchanges)
    })
})
