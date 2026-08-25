import { describe, expect, it, vi } from 'vitest'
import { createAssetDragPrefetchQueue } from './assetDragPrefetch'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('asset drag prefetch queue', () => {
  it('never runs more original downloads than its configured bound', async () => {
    const queue = createAssetDragPrefetchQueue(2)
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
    const starts = gates.map(() => vi.fn())
    const leases = gates.map((gate, index) => queue.schedule(async () => {
      starts[index]()
      return gate.promise
    }))

    await Promise.resolve()
    expect(starts.map((start) => start.mock.calls.length)).toEqual([1, 1, 0])

    gates[0].resolve('first')
    await leases[0].promise
    await vi.waitFor(() => expect(starts[2]).toHaveBeenCalledOnce())

    gates[1].resolve('second')
    gates[2].resolve('third')
    await expect(Promise.all(leases.map((lease) => lease.promise))).resolves.toEqual(['first', 'second', 'third'])
  })

  it('removes queued intent and aborts active intent without rejecting consumers', async () => {
    const queue = createAssetDragPrefetchQueue(1)
    const activeGate = deferred<string>()
    let activeSignal: AbortSignal | undefined
    const active = queue.schedule(async (signal) => {
      activeSignal = signal
      return activeGate.promise
    })
    const queuedRun = vi.fn(async () => 'queued')
    const queued = queue.schedule(queuedRun)

    await Promise.resolve()
    queued.cancel()
    active.cancel()
    activeGate.resolve('late')

    await expect(active.promise).resolves.toBeNull()
    await expect(queued.promise).resolves.toBeNull()
    expect(activeSignal?.aborted).toBe(true)
    expect(queuedRun).not.toHaveBeenCalled()
  })
})
