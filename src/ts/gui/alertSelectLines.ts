// alertSelect's options as lines (AlertComp.svelte): neighbours with the same
// `row` (AlertAction.row) share one line, side by side.
export function alertSelectLines(count: number, actions: readonly ({ row?: string } | undefined)[] | undefined): number[][] {
    const lines: number[][] = []
    for (let i = 0; i < count; i++) {
        const row = actions?.[i]?.row
        const last = lines.at(-1)
        if (row && last && actions?.[last[0]]?.row === row) last.push(i)
        else lines.push([i])
    }
    return lines
}
