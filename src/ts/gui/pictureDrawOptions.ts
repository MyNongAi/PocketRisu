// DRAW-SKIP-EMPTY-IMG (2026-11-24): html-to-image embeds images even inside hidden panels.
// An empty image URL resolves to the app page, whose HTML cannot load as a picture and can reject the whole drawing with an Event.
// Skip images without a URL and leave unreadable pictures blank so the rest can draw.

/** html-to-image `filter`: leaves out an <img> (or SVG <image>) that names no picture. */
export function drawableNode(node: HTMLElement): boolean {
    if (node instanceof HTMLImageElement) {
        return !!node.getAttribute('src')?.trim() || !!node.getAttribute('srcset')?.trim()
    }
    if (typeof SVGImageElement !== 'undefined' && node instanceof SVGImageElement) {
        return !!node.getAttribute('href')?.trim() || !!node.getAttribute('xlink:href')?.trim()
    }
    return true
}

/** html-to-image `onImageErrorHandler`: a picture that cannot be read is left blank instead of failing the whole drawing. */
export function ignoreUndrawableImage(): void {}

/** Text for a drawing failure: an Error's message; for an Event or anything without a message, `fallback`. */
export function drawErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message
    if (typeof error === 'string' && error) return error
    return fallback
}
