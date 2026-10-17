// A log image copied for a post: a board uploads a pasted image as a file,
// and Arca failed on a two-reply log image ("error during file upload", or
// its maintenance page) while one reply went through (the user's report,
// 2026-10-17). A copy larger than LOG_IMAGE_COPY_MAX_BYTES goes to the
// clipboard scaled down to fit; saving keeps the full image.

/** Largest PNG a log image copy carries (bytes). */
export const LOG_IMAGE_COPY_MAX_BYTES = 10 * 1024 * 1024

/**
 * The scale to try next for a PNG of `size` bytes to fit `maxBytes`: PNG size
 * goes roughly with the pixel count, so the square root of the ratio, with
 * some headroom.
 */
export function nextFitScale(size: number, maxBytes: number): number {
    return Math.min(1, Math.sqrt(maxBytes / size) * 0.95)
}

/** `blob` (a PNG) scaled down until it is at most `maxBytes`; as it is when it already fits or cannot be redrawn. */
export async function fitPngToBytes(blob: Blob, maxBytes = LOG_IMAGE_COPY_MAX_BYTES): Promise<Blob> {
    if (blob.size <= maxBytes || typeof createImageBitmap !== 'function') return blob
    const bitmap = await createImageBitmap(blob)
    try {
        let best = blob
        let scale = nextFitScale(blob.size, maxBytes)
        for (let attempt = 0; attempt < 4; attempt++) {
            const canvas = document.createElement('canvas')
            canvas.width = Math.max(1, Math.round(bitmap.width * scale))
            canvas.height = Math.max(1, Math.round(bitmap.height * scale))
            const context = canvas.getContext('2d')
            if (!context) return best
            context.imageSmoothingEnabled = true
            context.imageSmoothingQuality = 'high'
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
            const scaled = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
            canvas.width = 0
            canvas.height = 0
            if (!scaled) return best
            if (scaled.size < best.size) best = scaled
            if (scaled.size <= maxBytes) return scaled
            scale *= nextFitScale(scaled.size, maxBytes)
        }
        return best
    } finally {
        bitmap.close()
    }
}
