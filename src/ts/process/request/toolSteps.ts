// Tool-execution rounds allowed per request before we stop and surface a
// marker. Deliberately separate from the network retry budget (db.requestRetrys,
// applied by the outer requestChatData loop): conflating them would let a failed
// follow-up re-run already-executed (possibly write-side) tools.
export const MODEL_PRESET_MAX_TOOL_STEPS = 8

// With the bot edit mode's tools (Risu Access, `risu-*`) the model reads the
// bot's lorebook entries and modules one call at a time before it writes:
// eight rounds ran out on reads, once just as the write came (the user's
// report, 2026-11-08). Those requests get more.
export const EDIT_MODE_MAX_TOOL_STEPS = 30

// Waits before sending a rate-limited or failed follow-up again (toolLoop.ts):
// the edit mode also stopped on a 429 after its reads (the same report).
export const TOOL_FOLLOW_UP_RETRY_DELAYS_MS: readonly number[] = [3000, 8000, 15000]

/** The tool rounds a request may run: more when it carries the edit mode's tools. */
export function maxToolStepsFor(tools: readonly { name: string }[]): number {
    return tools.some((tool) => tool.name.startsWith('risu-')) ? EDIT_MODE_MAX_TOOL_STEPS : MODEL_PRESET_MAX_TOOL_STEPS
}
