/** Auxiliary post-processing needs visible main output, not reasoning alone. */
export function hasRenderableMainOutput(text: string | null | undefined): boolean {
    return (text ?? '').replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, '').trim().length > 0
}
