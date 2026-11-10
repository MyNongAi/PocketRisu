import { describe, expect, it } from 'vitest'
import { chatForSave, clearReplyInProgress, messagesWithoutPendingReply } from './chatCopySnapshot'

const m = (chatId: string, data = chatId) => ({ chatId, data })

describe('a copy or branch is not being answered', () => {
    it('drops the streaming flags a snapshot of a streaming chat carries', () => {
        const copy: { message: { chatId: string }[], isStreaming?: boolean, activeStreamingDisplayOptimizationMode?: string } =
            { message: [m('a'), m('out1')], isStreaming: true, activeStreamingDisplayOptimizationMode: 'balanced' }
        expect(clearReplyInProgress(copy)).toBe(copy)
        expect(copy.isStreaming).toBe(false)
        expect(copy.activeStreamingDisplayOptimizationMode).toBeUndefined()
        expect(copy.message.map((x) => x.chatId)).toEqual(['a', 'out1'])
    })
})

describe('chat copy while answering', () => {
    it('leaves out the reply being written and keeps the input that asked for it', () => {
        const messages = [m('a'), m('out1'), m('input2'), m('gen-1', 'partial…')]
        expect(messagesWithoutPendingReply(messages, 'gen-1').map((x) => x.chatId)).toEqual(['a', 'out1', 'input2'])
    })

    it('puts a reroll\'s old reply back in its place', () => {
        const old = { chatId: 'out1', data: 'old reply', swipes: ['x', 'old reply'] }
        const messages = [m('a'), m('input1'), m('gen-2', 'new…')]
        const copy = messagesWithoutPendingReply(messages, 'gen-2', { index: 2, message: old })
        expect(copy.map((x) => x.chatId)).toEqual(['a', 'input1', 'out1'])
        expect(copy[2]).toBe(old)
    })

    it('copies as it is when nothing is being written', () => {
        const messages = [m('a'), m('b')]
        expect(messagesWithoutPendingReply(messages, null)).toEqual(messages)
        // The old reply already in the chat is not added twice.
        expect(messagesWithoutPendingReply(messages, null, { index: 1, message: m('b') }).map((x) => x.chatId)).toEqual(['a', 'b'])
    })
})

describe('a chat saved while a reply is rerolled', () => {
    type Msg = { chatId: string, data: string, swipes?: string[], isComment?: boolean }
    const old: Msg = { chatId: 'out1', data: 'old reply', swipes: ['x', 'old reply'] }
    const comment: Msg = { chatId: 'note', data: 'branch note', isComment: true }

    it('keeps the old reply and the comments after it, without the reply being written', () => {
        const chat: { id: string, message: Msg[] } = { id: 'c', message: [m('a'), m('input1'), m('gen-2', 'new…')] }
        const saved = chatForSave(chat, 'gen-2', { index: 2, message: old, trailing: [comment] })
        expect(saved.message.map((x) => x.chatId)).toEqual(['a', 'input1', 'out1', 'note'])
        expect(saved.id).toBe('c')
        // the live chat is not touched
        expect(chat.message.map((x) => x.chatId)).toEqual(['a', 'input1', 'gen-2'])
    })

    it('is the chat itself when nothing is rerolled, and adds nothing twice', () => {
        const chat: { message: Msg[] } = { message: [m('a'), m('out1'), m('note')] }
        expect(chatForSave(chat, undefined, null)).toBe(chat)
        expect(chatForSave(chat, undefined, { index: 1, message: old, trailing: [comment] }).message.map((x) => x.chatId)).toEqual(['a', 'out1', 'note'])
    })
})

describe('a chat copied while it answers is the chat before the send (2026-11-08)', () => {
    type Msg = { chatId?: string, role: string, data: string, swipes?: string[], swipeId?: number, scriptstateCheckpoint?: { before: Record<string, string> | null, after: (Record<string, string> | null)[] } }
    let n = 0
    const newId = () => `id-${++n}`

    it('leaves out the sent input and the reply, puts the input back in the box, and the variables before the send', async () => {
        const { beginSendTurn, sendTurnOf, chatAsBeforeSend } = await import('./chatCopySnapshot')
        const chat = { id: 'c1', message: [{ role: 'char', data: 'hello' }, { chatId: 'u1', role: 'user', data: 'hi' }, { chatId: 'o1', role: 'char', data: 'out' }] as Msg[], scriptstate: { $pending: '0', $turn: 3 } as Record<string, string | number> }
        const end = beginSendTurn(chat, 'next input', '', newId)
        expect(chat.message[0].chatId).toBe('id-1')
        // The send goes on: the input, a bot's lock, the reply being written.
        chat.message.push({ chatId: 'u2', role: 'user', data: 'next input' }, { chatId: 'gen-1', role: 'char', data: 'partial' })
        chat.scriptstate.$pending = '1'
        chat.scriptstate.$turn = 4
        const copy = structuredClone({ message: chat.message, scriptstate: chat.scriptstate })
        const draft = chatAsBeforeSend(copy, { pendingGenerationId: 'gen-1', turn: sendTurnOf('c1') })
        expect(copy.message.map((m) => m.chatId)).toEqual(['id-1', 'u1', 'o1'])
        expect(copy.scriptstate).toEqual({ $pending: '0', $turn: 3 })
        expect(draft).toEqual({ input: 'next input', translate: '' })
        // The live chat is untouched.
        expect(chat.scriptstate.$pending).toBe('1')
        end()
        expect(sendTurnOf('c1')).toBeUndefined()
    })

    it('is the same before the reply starts, and as it is once the reply is in', async () => {
        const { beginSendTurn, sendTurnOf, chatAsBeforeSend } = await import('./chatCopySnapshot')
        const chat = { id: 'c2', message: [{ chatId: 'o1', role: 'char', data: 'out' }] as Msg[], scriptstate: { $x: '1' } as Record<string, string> }
        const end = beginSendTurn(chat, 'typed', 'typed-ko', newId)
        chat.message.push({ chatId: 'u2', role: 'user', data: 'typed' })
        chat.scriptstate.$x = '2'
        const early = structuredClone({ message: chat.message, scriptstate: chat.scriptstate })
        expect(chatAsBeforeSend(early, { turn: sendTurnOf('c2') })).toEqual({ input: 'typed', translate: 'typed-ko' })
        expect(early.message.map((m) => m.chatId)).toEqual(['o1'])
        // The reply is written and the send is only finishing up: copied as it is.
        chat.message.push({ chatId: 'r2', role: 'char', data: 'reply' })
        const late = structuredClone({ message: chat.message, scriptstate: chat.scriptstate })
        expect(chatAsBeforeSend(late, { turn: sendTurnOf('c2') })).toBeNull()
        expect(late.message.map((m) => m.chatId)).toEqual(['o1', 'u2', 'r2'])
        expect(late.scriptstate).toEqual({ $x: '2' })
        end()
    })

    it('a newer send keeps its record when an older one ends', async () => {
        const { beginSendTurn, sendTurnOf } = await import('./chatCopySnapshot')
        const chat = { id: 'c3', message: [] as Msg[] }
        const endOld = beginSendTurn(chat, 'a', '', newId)
        const endNew = beginSendTurn(chat, 'b', '', newId)
        endOld()
        expect(sendTurnOf('c3')?.input).toBe('b')
        endNew()
        expect(sendTurnOf('c3')).toBeUndefined()
    })

    it("a send the composer did not start ends at the last finished reply, with the variables it left", async () => {
        const { chatAsBeforeSend } = await import('./chatCopySnapshot')
        const out: Msg = { chatId: 'o1', role: 'char', data: 'out', scriptstateCheckpoint: { before: { $pending: '1' }, after: [{ $pending: '0' }] } }
        const copy = { message: [{ chatId: 'u1', role: 'user', data: 'hi' }, out, { chatId: 'req', role: 'user', data: '[REQUEST]' }, { chatId: 'gen-2', role: 'char', data: 'partial' }] as Msg[], scriptstate: { $pending: '1' } as Record<string, string> }
        expect(chatAsBeforeSend(copy, { pendingGenerationId: 'gen-2' })).toBeNull()
        expect(copy.message.map((m) => m.chatId)).toEqual(['u1', 'o1'])
        expect(copy.scriptstate).toEqual({ $pending: '0' })

        // Without a recorded checkpoint: only the reply being written goes, as before.
        const bare = { message: [{ chatId: 'o1', role: 'char', data: 'out' }, { chatId: 'req', role: 'user', data: '[REQUEST]' }, { chatId: 'gen-3', role: 'char', data: 'p' }] as Msg[], scriptstate: { $pending: '1' } as Record<string, string> }
        chatAsBeforeSend(bare, { pendingGenerationId: 'gen-3' })
        expect(bare.message.map((m) => m.chatId)).toEqual(['o1', 'req'])
        expect(bare.scriptstate).toEqual({ $pending: '1' })
    })

    it("a reroll's old reply goes back with the variables it left", async () => {
        const { chatAsBeforeSend } = await import('./chatCopySnapshot')
        const old: Msg = { chatId: 'o1', role: 'char', data: 'b', swipes: ['a', 'b'], swipeId: 1, scriptstateCheckpoint: { before: { $pending: '1' }, after: [{ $v: 'a' }, { $v: 'b' }] } }
        const copy = { message: [{ chatId: 'u1', role: 'user', data: 'hi' }, { chatId: 'gen-4', role: 'char', data: 'new' }] as Msg[], scriptstate: { $pending: '1' } as Record<string, string> }
        chatAsBeforeSend(copy, { pendingGenerationId: 'gen-4', placeholder: { index: 1, message: old } })
        expect(copy.message.map((m) => m.chatId)).toEqual(['u1', 'o1'])
        expect(copy.scriptstate).toEqual({ $v: 'b' })
    })
})
