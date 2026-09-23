export const BLANK_FIRST_MESSAGE_INDEX = -2
export const DEFAULT_FIRST_MESSAGE_INDEX = -1

export interface FirstMessageSource {
    firstMessage?: string
    alternateGreetings?: ReadonlyArray<string>
}

export function normalizeFirstMessageIndex(index: unknown): number {
    if (!Number.isFinite(index)) return DEFAULT_FIRST_MESSAGE_INDEX
    return Math.max(BLANK_FIRST_MESSAGE_INDEX, Math.trunc(index as number))
}

/**
 * Page 0 is a synthetic blank greeting. It is never written into character
 * cards, so upstream imports/exports keep their original first message intact.
 */
export function getFirstMessageAtIndex(source: FirstMessageSource, index: unknown): string {
    const normalized = normalizeFirstMessageIndex(index)
    if (normalized === BLANK_FIRST_MESSAGE_INDEX) return ''
    if (normalized === DEFAULT_FIRST_MESSAGE_INDEX) return source.firstMessage ?? ''
    return source.alternateGreetings?.[normalized] ?? source.firstMessage ?? ''
}

export function nextFirstMessageIndex(index: unknown, alternateCount: number): number {
    const normalized = normalizeFirstMessageIndex(index)
    return normalized >= Math.max(DEFAULT_FIRST_MESSAGE_INDEX, alternateCount - 1)
        ? BLANK_FIRST_MESSAGE_INDEX
        : normalized + 1
}

export function previousFirstMessageIndex(index: unknown, alternateCount: number): number {
    const normalized = normalizeFirstMessageIndex(index)
    return normalized === BLANK_FIRST_MESSAGE_INDEX
        ? Math.max(DEFAULT_FIRST_MESSAGE_INDEX, alternateCount - 1)
        : normalized - 1
}

/** Zero-based visible page number: blank=0, default=1, alternates=2... */
export function firstMessagePageNumber(index: unknown): number {
    return normalizeFirstMessageIndex(index) - BLANK_FIRST_MESSAGE_INDEX
}

/** Highest zero-based page number, not the number of pages. */
export function lastFirstMessagePageNumber(alternateCount: number): number {
    return Math.max(1, alternateCount + 1)
}
