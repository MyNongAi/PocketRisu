import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginPluginProviderCall, pluginFetchSignal } from './pluginStopCut';

// Fake host transport: no network, with a request that stays pending until cut.
const requests: AbortSignal[] = [];
function nativeFetch(signal?: AbortSignal): Promise<string> {
    requests.push(signal!);
    return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('cut', 'AbortError')), { once: true });
    });
}
async function provider(signal: AbortSignal, passSignal: boolean) {
    const scope = beginPluginProviderCall('Yumi', signal);
    try {
        const tracked = pluginFetchSignal('Yumi', passSignal ? signal : undefined);
        return await nativeFetch(tracked.signal);
    } finally {
        scope.close();
    }
}
afterEach(() => { requests.length = 0; vi.restoreAllMocks(); });

describe('PLUGIN-STOP-CUT', () => {
    it('cuts a streaming provider request that forwards its signal', async () => {
        const stop = new AbortController();
        const scope = beginPluginProviderCall('Yumi', stop.signal);
        const tracked = pluginFetchSignal('Yumi', stop.signal);
        const body = new ReadableStream<string>({
            start(controller) {
                controller.enqueue('partial');
                tracked.signal?.addEventListener('abort', () => controller.error(new DOMException('cut', 'AbortError')), { once: true });
            },
        });
        const reader = body.getReader();
        expect((await reader.read()).value).toBe('partial');
        const send = reader.read();
        requests.push(tracked.signal!);
        expect(requests).toHaveLength(1);
        stop.abort();
        await expect(send).rejects.toMatchObject({ name: 'AbortError' });
        expect(requests[0].aborted).toBe(true);
        scope.close();
    });

    it('cuts a provider awaiting the whole body even without a forwarded signal', async () => {
        const stop = new AbortController();
        const send = provider(stop.signal, false);
        stop.abort();
        await expect(send).rejects.toMatchObject({ name: 'AbortError' });
        expect(requests[0].aborted).toBe(true);
    });

    it('does not cut a cleanup request begun after stop', () => {
        const stop = new AbortController();
        const scope = beginPluginProviderCall('Yumi', stop.signal);
        stop.abort();
        const cleanup = pluginFetchSignal('Yumi');
        expect(cleanup.signal).toBeUndefined();
        scope.close();
    });

    it('leaves ambiguous overlapping calls alone and retains earlier ownership', () => {
        const first = new AbortController();
        const second = new AbortController();
        const one = beginPluginProviderCall('Yumi', first.signal);
        const firstRequest = pluginFetchSignal('Yumi');
        const two = beginPluginProviderCall('Yumi', second.signal);
        const ambiguous = pluginFetchSignal('Yumi');
        first.abort();
        expect(firstRequest.signal?.aborted).toBe(true);
        expect(ambiguous.signal).toBeUndefined();
        expect(second.signal.aborted).toBe(false);
        one.close(); two.close();
    });
});
