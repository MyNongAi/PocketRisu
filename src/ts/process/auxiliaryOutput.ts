/** Auxiliary post-processing needs visible main output, not reasoning alone. */
export function hasRenderableMainOutput(text: string | null | undefined): boolean {
    return (text ?? '').replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, '').trim().length > 0
}

/** A deliberately conservative length gate; no provider-specific censorship guesses. */
export function shouldRunAuxiliaryModel(text: string | null | undefined, minimumCharacters: number): boolean {
    const visible = (text ?? '')
        .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]*>/g, '')
        .trim()
    const minimum = Number.isFinite(minimumCharacters)
        ? Math.max(1, Math.min(500, Math.floor(minimumCharacters)))
        : 1
    return Array.from(visible).length >= minimum
}
