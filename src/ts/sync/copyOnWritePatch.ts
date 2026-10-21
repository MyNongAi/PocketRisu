// Another device's database patch, applied to this page's patch baseline
// without writing into it. The baseline is the patcher's own state: a write
// into it would make the next save diff against something the server never
// held, and a refused landing must leave it exactly as it was. Only the
// containers on each op's path are copied, so every subtree no op touched
// stays the very baseline object, and the landing (remoteLanding.ts) finds
// what changed by identity first.

import type { applyOperation as ApplyOperation } from 'fast-json-patch'

export class RemoteOpRejected extends Error {
    constructor(readonly reason: string, readonly index?: number) {
        super(index === undefined ? `remote op rejected: ${reason}` : `remote op ${index} rejected: ${reason}`)
        this.name = 'RemoteOpRejected'
    }
}

const ALLOWED_OPS = new Set(['add', 'replace', 'remove'])
const BANNED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])
const CANONICAL_INDEX = /^(0|[1-9]\d*)$/

const decodeSegment = (segment: string) => segment.replace(/~1/g, '/').replace(/~0/g, '~')

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

/** The op's decoded path segments, after the shape checks every op must pass. */
function checkedSegments(op: unknown, index: number): string[] {
    if (!isPlainObject(op)) throw new RemoteOpRejected('op-shape', index)
    if (typeof op.op !== 'string' || !ALLOWED_OPS.has(op.op)) throw new RemoteOpRejected('op-type', index)
    // add/replace/remove take no `from`; one present is not a patch this app wrote.
    if (Object.hasOwn(op, 'from')) throw new RemoteOpRejected('from', index)
    if (typeof op.path !== 'string' || !op.path.startsWith('/')) throw new RemoteOpRejected('path', index)
    const segments = op.path.split('/').slice(1).map(decodeSegment)
    if (segments[0] === '') throw new RemoteOpRejected('empty-segment', index)
    if (segments.some((segment) => BANNED_SEGMENTS.has(segment))) throw new RemoteOpRejected('proto-segment', index)
    // Plugin values live in the server's kv; the patcher never diffs this key.
    if (segments[0] === 'pluginCustomStorage') throw new RemoteOpRejected('plugin-storage', index)
    return segments
}

/**
 * Throws RemoteOpRejected unless `ops` is an array of add/replace/remove ops
 * (the only ones the patcher writes) with safe paths that the client chat
 * guard accepts. `findDangerousChatOps` is the save pipeline's guard
 * (storage/risuSave.ts), passed in so this module stays free of the app's
 * module graph.
 */
export function checkRemoteOps(
    ops: unknown,
    findDangerousChatOps: (ops: any[]) => readonly unknown[],
): void {
    if (!Array.isArray(ops)) throw new RemoteOpRejected('not-array')
    for (let i = 0; i < ops.length; i++) checkedSegments(ops[i], i)
    if (findDangerousChatOps(ops).length > 0) throw new RemoteOpRejected('chat-field')
}

const isContainer = (value: unknown): value is object => value !== null && typeof value === 'object'

/**
 * S: `base` with `ops` applied, sharing every subtree the ops did not touch.
 * `base` is never written, so it may be frozen. The op values are linked
 * into the result as fast-json-patch does, so the caller passes its own
 * copy of them (structuredClone of the event's ops). Each op's shape is
 * checked again here; the chat guard is checkRemoteOps' alone.
 */
export function applyOpsCopyOnWrite(
    base: Record<string, any>,
    ops: readonly any[],
    applyOperation: typeof ApplyOperation,
): Record<string, any> {
    const root: Record<string, any> = { ...base }
    // Containers this apply made or received: written freely. Anything else
    // is still the baseline's and is copied before the first write below it.
    const owned = new WeakSet<object>([root])
    let i = 0
    try {
        for (; i < ops.length; i++) {
            const op = ops[i]
            const segments = checkedSegments(op, i)
            let parent: any = root
            for (let depth = 0; depth < segments.length - 1; depth++) {
                const segment = segments[depth]
                let slot: string | number
                if (Array.isArray(parent)) {
                    if (!CANONICAL_INDEX.test(segment) || Number(segment) >= parent.length) throw new RemoteOpRejected('missing-parent', i)
                    slot = Number(segment)
                } else {
                    if (!Object.hasOwn(parent, segment)) throw new RemoteOpRejected('missing-parent', i)
                    slot = segment
                }
                let child: unknown = parent[slot]
                if (!isContainer(child)) throw new RemoteOpRejected('missing-parent', i)
                if (!owned.has(child)) {
                    const copy = Array.isArray(child) ? child.slice() : { ...child }
                    owned.add(copy)
                    parent[slot] = copy
                    child = copy
                }
                parent = child
            }
            // fast-json-patch reads "01" as index 1; the patcher never writes one.
            const last = segments[segments.length - 1]
            if (Array.isArray(parent) && !CANONICAL_INDEX.test(last) && !(op.op === 'add' && last === '-')) {
                throw new RemoteOpRejected('bad-index', i)
            }
            // The server's validated apply: validate, mutate, ban prototype writes.
            applyOperation(root, op, true, true, true, i)
            if ((op.op === 'add' || op.op === 'replace') && isContainer(op.value)) owned.add(op.value)
        }
    } catch (error) {
        if (error instanceof RemoteOpRejected) throw error
        throw new RemoteOpRejected('apply', i)
    }
    return root
}
