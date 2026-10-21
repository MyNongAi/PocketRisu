// Landing another device's database patch in this page's live state (the
// orchestration is in saveDb, which owns the patch baseline).
//
// The patch is applied to the baseline B, never to live: copyOnWritePatch.ts
// gives the server's new state S, sharing every subtree the patch did not
// touch. remoteLanding.ts then merges three ways (B, S and live, which may
// hold unsaved edits) and either refuses or plans the writes; the plan lands
// in one synchronous step with the baseline advanced to S in the same step.
// So a page with edits of its own takes the other device's change at once,
// and the save that follows sends only its own edits. Anything that cannot
// be merged is refused untouched, and the save's rebase still catches up.

import type { PatcherSetOptions, toSaveType } from '../storage/risuSave'
import { applyRemoteChangesInPlace } from '../storage/applyRebasedDb'
import { applyOpsCopyOnWrite, checkRemoteOps, RemoteOpRejected } from './copyOnWritePatch'
import { localChangeSet, planLanding, remoteChangeSet, type ChatRef, type LandingPageView, type WritePlan } from './remoteLanding'

/** The slice of RisuSavePatcher this needs (kept structural to avoid an import cycle). */
export interface PatchBaseline<Self> {
    hash(): string
    fork(): Self
    baselineDb(): any
    baselineRootKeyJson(key: string): string | undefined
    baselineCharacterJson(chaId: string): string | undefined
    baselineModuleJson(id: string): string | undefined
    set(data: any, toSave: toSaveType, opts?: PatcherSetOptions): Promise<{ patch: any[], expectedHash: string }>
}

export type LandResult =
    | { status: 'applied', plan: WritePlan }
    /** The baseline already holds this patch. */
    | { status: 'already' }
    /** This page is not at the patch's starting point (it missed one). */
    | { status: 'not-at-base' }
    /** The baseline moved while the landing was prepared (an asset manifest edit); try again. */
    | { status: 'busy', reason: string }
    /** Not a patch this app writes, or it does not apply to the baseline. */
    | { status: 'invalid', reason: string }
    /** Applied to the baseline, it misses the server's hash. */
    | { status: 'diverged' }
    /** Both sides changed the same thing, or this page is using what the patch removes. */
    | { status: 'conflict', reasons: string[] }
    /** The write threw half way; the baseline was not advanced. */
    | { status: 'write-failed' }

/** What the landing needs from the page, all synchronous. */
export interface LandingPage extends LandingPageView {
    /** Pause dirty tracking for these chats while their catalog entries are rewritten; returns the release. */
    suppressChatTracking(chats: readonly ChatRef[]): () => void
    deselect(): void
    /** Point the selection at this character again after the order changed. */
    repointSelected(chaId: string | null | undefined): void
    /** A send in progress addresses characters by index: let it find them again. */
    notifyDatabaseRebased(): void
    /** Loaded chats moved between slots: their cache entries follow. */
    rehome(characters: any[]): void
}

/**
 * Land `event` on `db` (the live state). `writeSection` runs the synchronous
 * write it is given, waits for the screen to settle and then releases what
 * the write paused; `commit` adopts the advanced baseline inside the write.
 */
export async function landRemoteDbPatch<P extends PatchBaseline<P>>(args: {
    patcher: P
    db: any
    event: { ops: any[], prevHash: string, nextHash: string }
    page: LandingPage
    holds: ReadonlyMap<string, string>
    clone: <T>(value: T) => T
    normalize: (value: unknown) => any
    characterWithStubs: (char: any) => any
    findDangerousChatOps: (ops: any[]) => readonly unknown[]
    toPlaceholders: (chats: any[]) => any[]
    writeSection: (run: () => { result: LandResult, release?: () => void }) => Promise<LandResult>
    commit: (next: P, plan: WritePlan) => void
}): Promise<LandResult> {
    const { patcher, db, event, page, holds } = args
    const { applyOperation } = await import('fast-json-patch')
    if (patcher.hash() === event.nextHash) return { status: 'already' }
    if (patcher.hash() !== event.prevHash) return { status: 'not-at-base' }

    const B = patcher.baselineDb()
    let S: any
    try {
        // Our own copy: the op values become part of S.
        const ops = structuredClone(event.ops)
        checkRemoteOps(ops, args.findDangerousChatOps)
        S = applyOpsCopyOnWrite(B, ops, applyOperation)
    } catch (error) {
        if (error instanceof RemoteOpRejected) return { status: 'invalid', reason: error.reason }
        throw error
    }
    const R = remoteChangeSet(B, S)
    if (R.ambiguous === true) return { status: 'conflict', reasons: [`ambiguous:${R.reason}`] }

    // The baseline after the patch: S itself, diffed against B (cheap, it shares what did not change).
    const next = patcher.fork()
    await next.set(S, {
        character: [],
        chat: [],
        root: true,
        botPreset: R.botPresets,
        modules: !!R.modules,
        moduleIds: R.modules?.structure ? null : [...(R.modules?.changed ?? [])],
        plugins: false,
        pluginCustomStorage: false,
    }, { baselineShared: true })
    if (next.hash() !== event.nextHash) return { status: 'diverged' }

    return args.writeSection(() => {
        if (patcher.hash() !== event.prevHash) return { result: { status: 'busy', reason: 'baseline-moved' } }
        const L = localChangeSet({ B, live: db, R, patcher, normalize: args.normalize, characterWithStubs: args.characterWithStubs, holds })
        const plan = planLanding({ B, S, R, L, live: db, page, holds, clone: args.clone, toPlaceholders: args.toPlaceholders })
        if (plan.ok === false) return { result: { status: 'conflict', reasons: plan.conflicts } }
        const selectedBefore = page.selectedChaId()
        const release = page.suppressChatTracking(plan.suppress)
        try {
            applyRemoteChangesInPlace(db, plan)
            page.rehome(db.characters ?? [])
            if (plan.deselect) page.deselect()
            else page.repointSelected(selectedBefore)
            if (plan.structural) page.notifyDatabaseRebased()
            args.commit(next, plan)
        } catch (error) {
            console.warn('[RealtimeSync] a remote change failed half way:', error)
            return { result: { status: 'write-failed' }, release }
        }
        return { result: { status: 'applied', plan }, release }
    })
}
