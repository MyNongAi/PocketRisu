// PLUGIN-STOP-CUT (2026-11-20): host-side cuts for chat provider fetches.
type Scope = { signal: AbortSignal; requests: Set<AbortController>; close: () => void };
const active = new Map<string, Set<Scope>>();

export function beginPluginProviderCall(plugin: string, signal?: AbortSignal) {
    if (!signal) return { close: () => {} };
    const scopes = active.get(plugin) ?? new Set<Scope>();
    active.set(plugin, scopes);
    const scope: Scope = { signal, requests: new Set(), close: () => {} };
    const onAbort = () => {
        for (const request of scope.requests) request.abort();
        scope.requests.clear();
        scope.close();
    };
    scope.close = () => {
        signal.removeEventListener('abort', onAbort);
        scopes.delete(scope);
        if (!scopes.size) active.delete(plugin);
    };
    if (!signal.aborted) {
        scopes.add(scope);
        signal.addEventListener('abort', onAbort, { once: true });
    }
    return scope;
}

export function pluginFetchSignal(plugin: string, original?: AbortSignal) {
    const scopes = active.get(plugin);
    // Overlapping calls cannot be attributed through the V3 RPC. Leave their
    // new requests to the signal explicitly supplied by the plugin.
    if (!scopes || scopes.size !== 1) return { signal: original, done: () => {} };
    const scope = scopes.values().next().value as Scope;
    if (scope.signal.aborted) return { signal: original, done: () => {} };
    const controller = new AbortController();
    scope.requests.add(controller);
    return {
        signal: original ? AbortSignal.any([original, controller.signal]) : controller.signal,
        done: () => scope.requests.delete(controller),
    };
}
