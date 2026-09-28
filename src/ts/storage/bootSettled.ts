// Resolved once saveDb's patcher is ready (bootReport marks 'saverReady').
// A boot-cache commit that fills the cache holds the whole payload while it
// encrypts; on a phone it should not overlap patcher.init, so it waits for
// this. No imports: nodeStorage and bootReport both reach it without a cycle.

let resolveSettled: () => void = () => {}
let settled = new Promise<void>((resolve) => { resolveSettled = resolve })

export function markBootSettled(): void {
    resolveSettled()
}

/** Resolves when boot has settled, or after `timeoutMs` if it never does. */
export function whenBootSettled(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        void settled.then(() => {
            clearTimeout(timer)
            resolve()
        })
    })
}

/** Tests only. */
export function resetBootSettledForTests(): void {
    settled = new Promise<void>((resolve) => { resolveSettled = resolve })
}
