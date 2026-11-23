// CHAT-COMPACT (2026-11-23): a compact's run-only focus note ("/compact 전투 결과
// 위주로") goes into the summary request as its own message, before a closing
// assistant prefill. Text appended to the configured prompt would land inside
// or after the last turn of a ChatML prompt, and the prompt itself is the
// user's (left as it is, never read).
export function withFocusNote<T extends { role: string, content: string }>(chats: T[], note: string, make: (content: string) => T): T[] {
    if (!note) return chats
    let at = chats.length
    while (at > 0 && chats[at - 1].role === 'assistant') at--
    return [...chats.slice(0, at), make(`Focus for this summary: ${note}`), ...chats.slice(at)]
}
