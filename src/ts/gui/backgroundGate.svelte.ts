/**
 * Message bodies wait for the bot's background <style> (the user's report,
 * 2026-11-08: 얼티네이트 헌터's panels and buttons looked like the app's own
 * buttons for about a second on entering it). A bot whose panel CSS lives
 * only in its background draws them unstyled while its first background
 * parse runs, and a heavy Lua display can let the greeting finish first.
 * On entering such a bot, each pane hides its message bodies (visibility,
 * so nothing moves) until its background first shows, a few seconds at most
 * (LatestBackground). Upstream shows nothing there until the parse ends too.
 */
const gates = new WeakMap<object, { waiting: boolean }>()

/** The gate of a pane (`getPaneView()`): `waiting` while its bodies stay hidden. */
export function backgroundGate(pane: object): { waiting: boolean } {
    const existing = gates.get(pane)
    if (existing) return existing
    const fresh = $state({ waiting: false })
    gates.set(pane, fresh)
    return fresh
}
