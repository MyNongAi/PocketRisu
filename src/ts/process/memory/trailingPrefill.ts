// A summary prompt that ends in an assistant turn pre-writes the start of the
// answer (a prefill; the Default HypaV3 prompt ends "Understood. … # Response
// Template"). Newer models refuse such a request outright: Gemini with
// "Requests ending with a model turn are not supported", newer Claude models
// with "does not support assistant message prefill" (the user's report,
// 2026-10-20: every summary failed, so every send in a long chat failed).
// The refused request is sent once more ending on a user turn that asks the
// model to go on from that pre-written start.

/** The provider refused the request because it ends on the model's turn. */
export function refusesTrailingAssistant(error: unknown): boolean {
    const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
    return /ending with a model turn|assistant message prefill|must end with a user message/i.test(text)
}

export const CONTINUE_FROM_PREFILL = 'Continue from the end of your previous message.'

/** Models that continue from a request ending on their own turn (a prefill); later Gemini refuse it. */
export function acceptsTrailingModelTurn(modelId: string | undefined): boolean {
    return /(?:^|[/])(?:gemini-[12](?:[.-]|$)|gemini-exp|gemma|learnlm)/i.test(modelId ?? '')
}

/** The same messages ending on a user turn; null when they already do not end on the assistant. */
export function endingOnUserTurn<T extends { role: string, content: string }>(messages: readonly T[]): T[] | null {
    if (messages.at(-1)?.role !== 'assistant') return null
    return [...messages, { role: 'user', content: CONTINUE_FROM_PREFILL } as T]
}

/**
 * Send, and when the model refuses the trailing prefill, send once more
 * ending on a user turn. Any other result comes back as it is.
 */
export async function sendAllowingPrefillRefusal<T extends { role: string, content: string }, R extends { type: string, result?: unknown }>(
    messages: T[],
    send: (messages: T[]) => Promise<R>,
): Promise<R> {
    const response = await send(messages)
    const userEnded = response.type === 'fail' && refusesTrailingAssistant(response.result) ? endingOnUserTurn(messages) : null
    return userEnded ? send(userEnded) : response
}
