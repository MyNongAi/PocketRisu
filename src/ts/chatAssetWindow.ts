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

/**
 * Old messages stay cold until they are actually close to the viewport. The
 * newest-N window remains warm so returning to the composer does not flash.
 */
export function shouldResolveChatAssets(
    inRecentWindow: boolean,
    viewportVisible: boolean,
    configuredLimit: unknown,
): boolean {
    return normalizeExternalAssetRecentOutputs(configuredLimit) === 0
        || inRecentWindow
        || viewportVisible
}

/** A cold message warms once it is this close to the view... */
export const VIEWPORT_ASSET_WARM_MARGIN = '320px 0px'
/** ...and cools only once it is this far past it. */
export const VIEWPORT_ASSET_COOL_MARGIN = '200% 0px'

/**
 * Reports `true` when `element` comes near the chat view and `false` once it
 * is well past it. Warming or cooling redraws the message at another height
 * (asset names become images, or the other way round); with one edge for
 * both, a message ending just inside the view's top shrank out of the view,
 * cooled, grew back in and warmed again, every frame, and the transcript
 * under it shook up and down (the user's report, 2026-10-27).
 *
 * The chat scroller is the observers' root, so the margins reach past the
 * view: with the page as root, the scroller clipped them and a message
 * warmed only when it was already on screen.
 */
export function watchAssetViewport(element: Element, onChange: (visible: boolean) => void): () => void {
    const root = element.closest('.default-chat-screen')
    const warm = new IntersectionObserver((entries) => {
        if (entries[entries.length - 1]?.isIntersecting) onChange(true)
    }, { root, rootMargin: VIEWPORT_ASSET_WARM_MARGIN })
    const cool = new IntersectionObserver((entries) => {
        const latest = entries[entries.length - 1]
        if (latest && !latest.isIntersecting) onChange(false)
    }, { root, rootMargin: VIEWPORT_ASSET_COOL_MARGIN })
    warm.observe(element)
    cool.observe(element)
    return () => {
        warm.disconnect()
        cool.disconnect()
    }
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
