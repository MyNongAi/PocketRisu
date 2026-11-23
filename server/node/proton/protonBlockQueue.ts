// PROTON-STREAM (2026-11-23): bounded block scheduling, shared with tests.
import { unlink } from "node:fs/promises";

export async function discardPartialFile(handle: { close(): Promise<void> } | undefined, destPath: string): Promise<void> {
    await handle?.close().catch(() => {});
    await unlink(destPath).catch(() => {});
}
export async function writeOrderedBlocks<T, R>(
    blocks: readonly T[],
    load: (block: T) => Promise<R>,
    write: (result: R) => Promise<void>,
    signal?: AbortSignal,
): Promise<void> {
    for (let start = 0; start < blocks.length; start += 4) {
        if (signal?.aborted) throw signal.reason ?? new Error("Download aborted");
        const settled = await Promise.allSettled(blocks.slice(start, start + 4).map(load));
        const failed = settled.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        for (const result of settled) {
            if (signal?.aborted) throw signal.reason ?? new Error("Download aborted");
            await write((result as PromiseFulfilledResult<R>).value);
        }
    }
}

export async function retryBlock<T, R>(
    initial: T,
    load: (block: T) => Promise<R>,
    refresh: (block: T) => Promise<T>,
    statusOf: (error: unknown) => number | undefined,
    signal?: AbortSignal,
): Promise<R> {
    let block = initial;
    for (let attempt = 0; attempt < 4; attempt++) {
        if (signal?.aborted) throw signal.reason ?? new Error("Download aborted");
        try {
            return await load(block);
        } catch (error) {
            if (signal?.aborted) throw signal.reason ?? new Error("Download aborted");
            const status = statusOf(error);
            if (attempt === 3 || (status && ![401, 403, 404].includes(status) && status < 500)) throw error;
            if (status && [401, 403, 404].includes(status)) block = await refresh(block);
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Download aborted")); };
                const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 150 * (attempt + 1));
                signal?.addEventListener("abort", onAbort, { once: true });
            });
        }
    }
    throw new Error("Block retry exhausted");
}
