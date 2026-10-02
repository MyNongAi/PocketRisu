// Chat variables (chat.scriptstate, written by Lua, triggers and CBS setvar)
// live on the chat, not on a message. Without a checkpoint a reroll runs the
// reply's scripts again on top of what the previous candidate already changed
// (counters pile up), and flipping between swipes keeps whatever the last run
// left. A checkpoint on the reply records the variables before its turn and
// after each candidate, so a reroll starts from the turn's baseline and showing
// a swipe brings back the variables that swipe produced.
//
// Only the newest reply carries a checkpoint (pruneScriptstateCheckpoints):
// older replies are not reroll targets, and every later message has changed
// the variables since, so their snapshots would only bloat the chat body.
// A message without a checkpoint (chats from before this feature, snapshots
// over the size cap) keeps the old behaviour: nothing is restored.

export type ScriptstateSnapshot = { [key: string]: string | number | boolean }

export interface ScriptstateCheckpoint {
    /** Variables right before the reply's turn was generated. Shared by every
     *  swipe, since each reroll starts from it. null = not recorded. */
    before: ScriptstateSnapshot | null
    /** Variables after each candidate finished, index-aligned with `swipes`
     *  (one entry when the message has no swipes). null = not recorded: a swipe
     *  from before this feature, over the size cap, or a generation that never
     *  finished (aborted, or slotted in by server-side recovery). */
    after: (ScriptstateSnapshot | null)[]
}

export interface ScriptstateHolder {
    scriptstate?: ScriptstateSnapshot
}

export interface CheckpointMessage {
    swipes?: string[]
    swipeId?: number
    scriptstateCheckpoint?: ScriptstateCheckpoint
}

// Snapshots over this size are skipped (stored as null), never truncated: a
// partial snapshot would restore a state no run ever produced. The cap keeps a
// bot that parks large JSON in its variables from doubling the chat body on
// every reply; that bot simply keeps the pre-checkpoint behaviour.
export const SCRIPTSTATE_SNAPSHOT_MAX_BYTES = 256 * 1024

function isSnapshot(value: unknown): value is ScriptstateSnapshot {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Detached, proxy-free copy of a chat's variables, or null when it cannot be
 * stored (over SCRIPTSTATE_SNAPSHOT_MAX_BYTES serialized, or unserializable).
 * A missing scriptstate snapshots as {}: every reader treats the two alike.
 */
export function snapshotScriptstate(state: ScriptstateSnapshot | null | undefined): ScriptstateSnapshot | null {
    let json: string
    try {
        json = JSON.stringify(state ?? {})
    } catch {
        return null
    }
    if (typeof json !== 'string') return null
    if (new TextEncoder().encode(json).byteLength > SCRIPTSTATE_SNAPSHOT_MAX_BYTES) return null
    const parsed: unknown = JSON.parse(json)
    return isSnapshot(parsed) ? parsed : null
}

// Deep, proxy-free copy. Values are primitives by type, but a script could
// still park an object there; a shallow copy would then share it between the
// stored snapshot and the live state.
function cloneSnapshot(snapshot: ScriptstateSnapshot | null | undefined): ScriptstateSnapshot | null {
    return isSnapshot(snapshot) ? JSON.parse(JSON.stringify(snapshot)) : null
}

function candidateCount(message: CheckpointMessage): number {
    return Array.isArray(message.swipes) && message.swipes.length > 0 ? message.swipes.length : 1
}

function shownCandidate(message: CheckpointMessage): number {
    if (!Array.isArray(message.swipes) || message.swipes.length === 0) return 0
    const id = message.swipeId ?? 0
    return Math.min(Math.max(0, Math.trunc(id) || 0), message.swipes.length - 1)
}

// Pad with null (never undefined: the save path turns undefined array slots
// into null anyway) or cut to the candidate count, cloning each snapshot so
// the result never aliases a stored or live object.
function alignAfter(after: unknown, count: number): (ScriptstateSnapshot | null)[] {
    const source = Array.isArray(after) ? after : []
    const aligned: (ScriptstateSnapshot | null)[] = []
    for (let i = 0; i < count; i++) {
        aligned.push(cloneSnapshot(source[i]))
    }
    return aligned
}

function readCheckpoint(message: CheckpointMessage): ScriptstateCheckpoint | null {
    const checkpoint = message.scriptstateCheckpoint
    if (!checkpoint || typeof checkpoint !== 'object') return null
    return checkpoint
}

function buildCheckpoint(
    before: ScriptstateSnapshot | null,
    after: (ScriptstateSnapshot | null)[],
): ScriptstateCheckpoint | undefined {
    // Nothing recorded at all → no field, so the message stays exactly as a
    // pre-feature one.
    if (before === null && after.every((snapshot) => snapshot === null)) return undefined
    return { before, after }
}

function writeCheckpoint(message: CheckpointMessage, checkpoint: ScriptstateCheckpoint | undefined): void {
    if (checkpoint) message.scriptstateCheckpoint = checkpoint
    else delete message.scriptstateCheckpoint
}

/**
 * Record the variables around the generation of the candidate the message
 * shows. `before` is taken only when the message has no checkpoint yet: a
 * continue (or the completion of a reply whose baseline was stamped when it
 * was pushed) keeps the turn's original baseline. Pass after = null to stamp
 * just the baseline.
 */
export function recordScriptstateCheckpoint(
    message: CheckpointMessage,
    before: ScriptstateSnapshot | null,
    after: ScriptstateSnapshot | null,
): void {
    const existing = readCheckpoint(message)
    const afters = alignAfter(existing?.after, candidateCount(message))
    afters[shownCandidate(message)] = cloneSnapshot(after)
    const baseline = existing ? cloneSnapshot(existing.before) : cloneSnapshot(before)
    writeCheckpoint(message, buildCheckpoint(baseline, afters))
}

/** Detached copy of a message's checkpoint, e.g. to carry it across a reroll. */
export function copyScriptstateCheckpoint(message: CheckpointMessage): ScriptstateCheckpoint | undefined {
    const existing = readCheckpoint(message)
    if (!existing) return undefined
    return buildCheckpoint(cloneSnapshot(existing.before), alignAfter(existing.after, candidateCount(message)))
}

/**
 * Checkpoint for the message a reroll produced, whose swipes become
 * [...previous swipes, new reply]. `previous` is the rerolled message's
 * checkpoint (undefined when it had none, or when the reroll did not replace
 * it), `previousCount` its swipe count, `generated` the new reply's own.
 */
export function mergeRerollCheckpoint(
    previous: ScriptstateCheckpoint | undefined,
    previousCount: number,
    generated: ScriptstateCheckpoint | undefined,
): ScriptstateCheckpoint | undefined {
    const afters = alignAfter(previous?.after, previousCount)
    afters.push(alignAfter(generated?.after, 1)[0])
    // The reroll restored previous.before, so the new reply started from it;
    // without one (pre-feature message) the new reply's own baseline is the
    // best one from now on and stops further pile-up.
    const before = cloneSnapshot(previous?.before) ?? cloneSnapshot(generated?.before)
    return buildCheckpoint(before, afters)
}

/** Keep the checkpoint aligned after the swipe at `removedIndex` was deleted. */
export function removeSwipeCheckpoint(message: CheckpointMessage, removedIndex: number, previousCount: number): void {
    const existing = readCheckpoint(message)
    if (!existing) return
    const afters = alignAfter(existing.after, previousCount)
    afters.splice(removedIndex, 1)
    writeCheckpoint(message, buildCheckpoint(cloneSnapshot(existing.before), alignAfter(afters, candidateCount(message))))
}

/** Drop checkpoints from every message except `keep` (see the header). */
export function pruneScriptstateCheckpoints(messages: CheckpointMessage[], keep: CheckpointMessage | null): number {
    let pruned = 0
    for (const message of messages) {
        if (message === keep || !message?.scriptstateCheckpoint) continue
        delete message.scriptstateCheckpoint
        pruned++
    }
    return pruned
}

function restore(chat: ScriptstateHolder, snapshot: ScriptstateSnapshot | null | undefined): boolean {
    // A fresh object: the live state is mutated in place (setChatVar), which
    // must never write through into the stored snapshot.
    const copy = cloneSnapshot(snapshot)
    if (!copy) return false
    chat.scriptstate = copy
    return true
}

/** Before rerolling `message`: put back the variables from before its turn. */
export function restoreScriptstateBeforeReroll(chat: ScriptstateHolder, message: CheckpointMessage): boolean {
    return restore(chat, readCheckpoint(message)?.before)
}

/** After switching or deleting a swipe: put back what the shown swipe left. */
export function restoreShownSwipeScriptstate(chat: ScriptstateHolder, message: CheckpointMessage): boolean {
    const existing = readCheckpoint(message)
    if (!existing || !Array.isArray(existing.after)) return false
    return restore(chat, existing.after[shownCandidate(message)])
}

/** Put back a snapshot taken with snapshotScriptstate (e.g. a failed reroll). */
export function restoreScriptstateSnapshot(chat: ScriptstateHolder, snapshot: ScriptstateSnapshot | null): boolean {
    return restore(chat, snapshot)
}
