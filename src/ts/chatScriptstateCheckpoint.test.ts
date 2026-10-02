import { describe, expect, it } from 'vitest'
import {
    copyScriptstateCheckpoint,
    mergeRerollCheckpoint,
    pruneScriptstateCheckpoints,
    recordScriptstateCheckpoint,
    removeSwipeCheckpoint,
    restoreScriptstateBeforeReroll,
    restoreScriptstateSnapshot,
    restoreShownSwipeScriptstate,
    SCRIPTSTATE_SNAPSHOT_MAX_BYTES,
    snapshotScriptstate,
    type CheckpointMessage,
    type ScriptstateSnapshot,
} from './chatScriptstateCheckpoint'

type Msg = CheckpointMessage & { data: string }

function bigState(bytes: number): ScriptstateSnapshot {
    return { $blob: 'x'.repeat(bytes) }
}

describe('snapshotScriptstate', () => {
    it('takes a detached copy', () => {
        const state: ScriptstateSnapshot = { $count: '1' }
        const snapshot = snapshotScriptstate(state)
        state.$count = '2'
        expect(snapshot).toEqual({ $count: '1' })
    })

    it('treats a chat without variables as empty', () => {
        expect(snapshotScriptstate(undefined)).toEqual({})
        expect(snapshotScriptstate(null)).toEqual({})
    })

    it('skips a state over the size cap instead of truncating it', () => {
        expect(snapshotScriptstate(bigState(SCRIPTSTATE_SNAPSHOT_MAX_BYTES))).toBeNull()
        expect(snapshotScriptstate(bigState(SCRIPTSTATE_SNAPSHOT_MAX_BYTES - 100))).not.toBeNull()
    })

    it('measures the cap in UTF-8 bytes, not characters', () => {
        // 3 bytes per character: under the cap in characters, over it in bytes.
        const korean = { $text: '가'.repeat(Math.ceil(SCRIPTSTATE_SNAPSHOT_MAX_BYTES / 2)) }
        expect(snapshotScriptstate(korean)).toBeNull()
    })
})

describe('recordScriptstateCheckpoint', () => {
    it('records the variables before and after a new reply', () => {
        const message: Msg = { data: 'reply' }
        recordScriptstateCheckpoint(message, { $n: '0' }, { $n: '1' })
        expect(message.scriptstateCheckpoint).toEqual({ before: { $n: '0' }, after: [{ $n: '1' }] })
    })

    it('keeps the baseline stamped when the reply was pushed', () => {
        const message: Msg = { data: '' }
        recordScriptstateCheckpoint(message, { $n: '0' }, null)
        expect(message.scriptstateCheckpoint).toEqual({ before: { $n: '0' }, after: [null] })
        recordScriptstateCheckpoint(message, { $n: 'ignored' }, { $n: '1' })
        expect(message.scriptstateCheckpoint).toEqual({ before: { $n: '0' }, after: [{ $n: '1' }] })
    })

    it('a continue keeps the turn baseline and replaces the shown swipe result', () => {
        const message: Msg = {
            data: 'b',
            swipes: ['a', 'b'],
            swipeId: 1,
            scriptstateCheckpoint: { before: { $n: '0' }, after: [{ $n: '1' }, { $n: '2' }] },
        }
        recordScriptstateCheckpoint(message, { $n: '2' }, { $n: '3' })
        expect(message.scriptstateCheckpoint).toEqual({ before: { $n: '0' }, after: [{ $n: '1' }, { $n: '3' }] })
    })

    it('stores nothing when both snapshots were over the cap', () => {
        const message: Msg = { data: 'reply' }
        recordScriptstateCheckpoint(message, null, null)
        expect(message).not.toHaveProperty('scriptstateCheckpoint')
    })

    it('does not alias the snapshots it was given', () => {
        const after: ScriptstateSnapshot = { $n: '1' }
        const message: Msg = { data: 'reply' }
        recordScriptstateCheckpoint(message, {}, after)
        after.$n = 'mutated'
        expect(message.scriptstateCheckpoint?.after[0]).toEqual({ $n: '1' })
    })
})

describe('reroll', () => {
    it('restores the variables from before the turn, not what the last swipe left', () => {
        const chat = { scriptstate: { $n: '1' } as ScriptstateSnapshot }
        const message: Msg = { data: 'r1', scriptstateCheckpoint: { before: { $n: '0' }, after: [{ $n: '1' }] } }
        expect(restoreScriptstateBeforeReroll(chat, message)).toBe(true)
        expect(chat.scriptstate).toEqual({ $n: '0' })
    })

    it('hands the chat a copy, so later setvar does not rewrite the checkpoint', () => {
        const chat: { scriptstate?: ScriptstateSnapshot } = {}
        const message: Msg = { data: 'r1', scriptstateCheckpoint: { before: { $n: '0' }, after: [{ $n: '1' }] } }
        restoreScriptstateBeforeReroll(chat, message)
        chat.scriptstate!.$n = '5'
        expect(message.scriptstateCheckpoint?.before).toEqual({ $n: '0' })
    })

    it('appends the new reply to the rerolled message checkpoint', () => {
        const previous = { before: { $n: '0' }, after: [{ $n: '1' }, { $n: '2' }] }
        const generated = { before: { $n: '0' }, after: [{ $n: '3' }] }
        expect(mergeRerollCheckpoint(previous, 2, generated)).toEqual({
            before: { $n: '0' },
            after: [{ $n: '1' }, { $n: '2' }, { $n: '3' }],
        })
    })

    it('a pre-feature message gets null entries and the new reply baseline', () => {
        const generated = { before: { $n: '7' }, after: [{ $n: '8' }] }
        expect(mergeRerollCheckpoint(undefined, 2, generated)).toEqual({
            before: { $n: '7' },
            after: [null, null, { $n: '8' }],
        })
    })

    it('keeps the previous checkpoint even when the new reply recorded none', () => {
        const previous = { before: { $n: '0' }, after: [{ $n: '1' }] }
        expect(mergeRerollCheckpoint(previous, 1, undefined)).toEqual({
            before: { $n: '0' },
            after: [{ $n: '1' }, null],
        })
    })

    it('records nothing when neither side has a checkpoint', () => {
        expect(mergeRerollCheckpoint(undefined, 3, undefined)).toBeUndefined()
    })

    it('copies a checkpoint out of the message before it is replaced', () => {
        const message: Msg = {
            data: 'b',
            swipes: ['a', 'b'],
            swipeId: 1,
            scriptstateCheckpoint: { before: { $n: '0' }, after: [{ $n: '1' }] },
        }
        const copy = copyScriptstateCheckpoint(message)
        expect(copy).toEqual({ before: { $n: '0' }, after: [{ $n: '1' }, null] })
        copy!.before!.$n = 'x'
        expect(message.scriptstateCheckpoint?.before).toEqual({ $n: '0' })
        expect(copyScriptstateCheckpoint({})).toBeUndefined()
    })

    it('a failed reroll can put the original variables back', () => {
        const chat: { scriptstate?: ScriptstateSnapshot } = { scriptstate: { $n: '0' } }
        expect(restoreScriptstateSnapshot(chat, { $n: '1' })).toBe(true)
        expect(chat.scriptstate).toEqual({ $n: '1' })
        expect(restoreScriptstateSnapshot(chat, null)).toBe(false)
        expect(chat.scriptstate).toEqual({ $n: '1' })
    })
})

describe('swipe switching', () => {
    const checkpoint = () => ({ before: { $n: '0' }, after: [{ $n: '1' }, null, { $n: '3' }] })

    it('restores what the shown swipe left behind', () => {
        const chat = { scriptstate: { $n: '3' } as ScriptstateSnapshot }
        const message: Msg = { data: 'a', swipes: ['a', 'b', 'c'], swipeId: 0, scriptstateCheckpoint: checkpoint() }
        expect(restoreShownSwipeScriptstate(chat, message)).toBe(true)
        expect(chat.scriptstate).toEqual({ $n: '1' })
    })

    it('leaves the variables alone for a swipe without a snapshot', () => {
        const chat = { scriptstate: { $n: '3' } as ScriptstateSnapshot }
        const message: Msg = { data: 'b', swipes: ['a', 'b', 'c'], swipeId: 1, scriptstateCheckpoint: checkpoint() }
        expect(restoreShownSwipeScriptstate(chat, message)).toBe(false)
        expect(chat.scriptstate).toEqual({ $n: '3' })
    })

    it('keeps the snapshots aligned when a swipe is deleted', () => {
        const message: Msg = { data: 'a', swipes: ['a', 'c'], swipeId: 1, scriptstateCheckpoint: checkpoint() }
        removeSwipeCheckpoint(message, 1, 3)
        expect(message.scriptstateCheckpoint).toEqual({ before: { $n: '0' }, after: [{ $n: '1' }, { $n: '3' }] })
    })

    it('collapses to a single entry when one swipe remains', () => {
        const message: Msg = { data: 'c', scriptstateCheckpoint: { before: { $n: '0' }, after: [{ $n: '1' }, { $n: '3' }] } }
        removeSwipeCheckpoint(message, 0, 2)
        expect(message.scriptstateCheckpoint).toEqual({ before: { $n: '0' }, after: [{ $n: '3' }] })
    })
})

describe('chats from before this feature', () => {
    it('restores nothing and adds no fields', () => {
        const chat = { scriptstate: { $n: '9' } as ScriptstateSnapshot }
        const message: Msg = { data: 'b', swipes: ['a', 'b'], swipeId: 1 }
        expect(restoreScriptstateBeforeReroll(chat, message)).toBe(false)
        expect(restoreShownSwipeScriptstate(chat, message)).toBe(false)
        removeSwipeCheckpoint(message, 0, 2)
        expect(chat.scriptstate).toEqual({ $n: '9' })
        expect(message).toEqual({ data: 'b', swipes: ['a', 'b'], swipeId: 1 })
    })

    it('a chat without variables is left without them', () => {
        const chat: { scriptstate?: ScriptstateSnapshot } = {}
        expect(restoreScriptstateBeforeReroll(chat, { scriptstateCheckpoint: { before: null, after: [{}] } })).toBe(false)
        expect(chat).not.toHaveProperty('scriptstate')
    })

    it('survives the save path turning missing slots into null', () => {
        const message: Msg = { data: 'r', swipes: ['a', 'b'], swipeId: 0 }
        recordScriptstateCheckpoint(message, { $n: '0' }, { $n: '1' })
        const roundTripped = JSON.parse(JSON.stringify(message)) as Msg
        expect(roundTripped.scriptstateCheckpoint).toEqual({ before: { $n: '0' }, after: [{ $n: '1' }, null] })
        roundTripped.swipeId = 1
        const chat = { scriptstate: { $n: '1' } as ScriptstateSnapshot }
        expect(restoreShownSwipeScriptstate(chat, roundTripped)).toBe(false)
    })
})

describe('pruneScriptstateCheckpoints', () => {
    it('keeps the checkpoint on the newest reply only', () => {
        const older: Msg = { data: 'old', scriptstateCheckpoint: { before: {}, after: [{}] } }
        const user: Msg = { data: 'hi' }
        const newest: Msg = { data: 'new', scriptstateCheckpoint: { before: {}, after: [{}] } }
        expect(pruneScriptstateCheckpoints([older, user, newest], newest)).toBe(1)
        expect(older).not.toHaveProperty('scriptstateCheckpoint')
        expect(user).not.toHaveProperty('scriptstateCheckpoint')
        expect(newest.scriptstateCheckpoint).toEqual({ before: {}, after: [{}] })
    })
})
