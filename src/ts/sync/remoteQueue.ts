// Other devices' changes waiting to land (globalApi's realtime worker).
// Database patches form a chain, each starting at the hash the previous one
// ended at, so they stay in arrival order; a chat only ever needs its newest
// body, so a newer event for the same chat replaces the queued one.

/** A database patch's place in the chain. */
export interface ChainEvent {
    seq: number
    prevHash: string
    nextHash: string
    instanceId?: string
}

/** Where this page's baseline stands in the server's feed (the last patch it holds). */
export interface FeedCursor {
    instanceId: string
    seq: number
}

/** Queue a chat event, dropping an older one queued for the same chat. */
export function queueNewestChat<C extends { chaId: string, chatId: string }>(queue: C[], event: C): void {
    for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].chaId === event.chaId && queue[i].chatId === event.chatId) queue.splice(i, 1)
    }
    queue.push(event)
}

/** A patch the baseline already holds: numbered at or below the cursor by the same server instance. */
export function alreadyLanded(event: ChainEvent, cursor: FeedCursor | null): boolean {
    return !!cursor && !!event.instanceId && event.instanceId === cursor.instanceId && event.seq <= cursor.seq
}

/**
 * The queued patch that starts where the baseline stands (`hash`), dropping
 * the ones the baseline already holds on the way. Undefined when none does.
 */
export function findChainEvent<D extends ChainEvent>(queue: D[], hash: string, cursor: FeedCursor | null): D | undefined {
    for (let i = 0; i < queue.length;) {
        if (alreadyLanded(queue[i], cursor)) {
            queue.splice(i, 1)
            continue
        }
        if (queue[i].prevHash === hash) return queue[i]
        i++
    }
    return undefined
}

export type CatchUpLand = 'applied' | 'already' | 'busy' | (string & {})

/**
 * After a save met a newer server revision: land the queued patches in chain
 * order until the baseline reaches `target` (the server's hash), so the save
 * can be retried without downloading the database. False as soon as that is
 * not possible: a gap the stream cannot fill (no usable link, or the deadline
 * passed while waiting for the next event), or a patch that did not land.
 */
export async function catchUp<D extends ChainEvent>(args: {
    target: string
    queue: D[]
    hash: () => string
    cursor: () => FeedCursor | null
    land: (event: D) => Promise<CatchUpLand>
    usable: () => boolean
    deadlineMs: number
    sleep: (ms: number) => Promise<unknown>
    now?: () => number
}): Promise<boolean> {
    const now = args.now ?? Date.now
    const deadline = now() + args.deadlineMs
    while (args.hash() !== args.target) {
        const event = findChainEvent(args.queue, args.hash(), args.cursor())
        if (!event) {
            if (!args.usable() || now() >= deadline) return false
            await args.sleep(50)
            continue
        }
        const result = await args.land(event)
        if (result === 'busy') {
            if (now() >= deadline) return false
            await args.sleep(50)
            continue
        }
        const at = args.queue.indexOf(event)
        if (at >= 0) args.queue.splice(at, 1)
        if (result !== 'applied' && result !== 'already') return false
    }
    return true
}
