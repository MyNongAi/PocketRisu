export const DEFAULT_EXTERNAL_ASSET_RECENT_OUTPUTS = 5

export interface ChatAssetWindowMessage {
    role?: string | null
    isComment?: boolean
    disabled?: boolean | 'allBefore'
}
export interface ChatAssetRenderWindow {
    messageIndices: Set<number>
    firstMessage: boolean
}

/**
 * Normalizes the advanced setting used by the chat renderer. A value of zero
 * deliberately means "legacy behaviour" (do not limit asset rendering).
 */
export function normalizeExternalAssetRecentOutputs(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return DEFAULT_EXTERNAL_ASSET_RECENT_OUTPUTS
    }

    return Math.floor(value)
}

function isActualCharacterOutput(message: ChatAssetWindowMessage | undefined): boolean {
    return message?.role === 'char' && !message.isComment && !message.disabled
}

/**
 * Calculates which messages may resolve chat assets for one chat page.
 *
 * `firstMessage` represents the greeting at index -1. It participates in the
 * same newest-N window, so it naturally falls out once enough real character
 * outputs have been added.
 */
export function getChatAssetRenderWindow(
    messages: readonly ChatAssetWindowMessage[],
    configuredLimit: unknown,
    includeFirstMessage = true,
): ChatAssetRenderWindow {
    const limit = normalizeExternalAssetRecentOutputs(configuredLimit)

    // Zero disables the optimization and preserves the previous rendering
    // behaviour for every role and message type.
    if (limit === 0) {
        return {
            messageIndices: new Set(messages.map((_, index) => index)),
            firstMessage: includeFirstMessage,
        }
    }

    const messageIndices = new Set<number>()
    let remaining = limit

    for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
        if (!isActualCharacterOutput(messages[index])) continue
        messageIndices.add(index)
        remaining--
    }

    return {
        messageIndices,
        firstMessage: includeFirstMessage && remaining > 0,
    }
}
