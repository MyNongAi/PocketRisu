// The chat screen lends its messages a way to show a reply's swipe the way
// its own arrows do (scriptstate restored on the newest reply), so an input
// whose version is turned can bring its reply along (inputVersions.ts).
import { getContext, setContext } from 'svelte'

export interface RequestPairing {
    /** Show the newest swipe of the reply at `replyIndex` requested with `input`, if it has one. */
    showSwipeRequestedWith(replyIndex: number, input: string): void
}

const KEY = Symbol('request-pairing')

export function setRequestPairing(pairing: RequestPairing): void {
    setContext(KEY, pairing)
}

export function getRequestPairing(): RequestPairing | undefined {
    return getContext<RequestPairing | undefined>(KEY)
}
