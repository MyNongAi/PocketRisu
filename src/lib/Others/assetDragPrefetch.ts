export interface AssetDragPrefetchLease<T> {
  promise: Promise<T | null>
  cancel: () => void
}

interface QueuedPrefetch<T> {
  controller: AbortController
  run: (signal: AbortSignal) => Promise<T>
  resolve: (value: T | null) => void
  reject: (reason?: unknown) => void
  started: boolean
  canceled: boolean
}

/**
 * Small shared admission queue for original-asset drag preparation.
 *
 * A visible grid can contain hundreds of LazyAssetPreview instances. Only an
 * explicit hover/focus/pointer intent may enqueue work, and this queue keeps a
 * fast sweep across the grid from starting an unbounded number of original
 * downloads at once.
 */
export function createAssetDragPrefetchQueue(maxConcurrent = 2) {
  const limit = Math.max(1, Math.floor(maxConcurrent) || 1)
  const queued: QueuedPrefetch<unknown>[] = []
  let active = 0

  function removeQueued(entry: QueuedPrefetch<unknown>) {
    const index = queued.indexOf(entry)
    if (index >= 0) queued.splice(index, 1)
  }

  function pump() {
    while (active < limit && queued.length > 0) {
      const entry = queued.shift()!
      if (entry.canceled) {
        entry.resolve(null)
        continue
      }

      entry.started = true
      active += 1
      Promise.resolve()
        .then(() => entry.run(entry.controller.signal))
        .then(
          (value) => entry.resolve(entry.canceled ? null : value),
          (error) => {
            if (entry.canceled || entry.controller.signal.aborted) entry.resolve(null)
            else entry.reject(error)
          },
        )
        .finally(() => {
          active -= 1
          pump()
        })
    }
  }

  function schedule<T>(run: (signal: AbortSignal) => Promise<T>): AssetDragPrefetchLease<T> {
    const controller = new AbortController()
    let resolve!: (value: T | null) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T | null>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const entry: QueuedPrefetch<T> = {
      controller,
      run,
      resolve,
      reject,
      started: false,
      canceled: false,
    }
    queued.push(entry as QueuedPrefetch<unknown>)
    pump()

    return {
      promise,
      cancel: () => {
        if (entry.canceled) return
        entry.canceled = true
        controller.abort()
        if (!entry.started) {
          removeQueued(entry as QueuedPrefetch<unknown>)
          resolve(null)
        }
      },
    }
  }

  return { schedule }
}

export const assetDragPrefetchQueue = createAssetDragPrefetchQueue(2)
