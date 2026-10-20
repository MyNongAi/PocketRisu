// A reply's swipe arrows (with ↻) sit in a row at its top and in one at its
// bottom; an input message's version arrows and the input echo under a reply
// have their own. Pressing one redraws the message with another text of a
// different length, and the row the reader pressed moved with it: a longer
// swipe pushed the bottom row off the screen, a shorter one at the tail
// pulled the whole transcript down (the user's report, 2026-10-20). The
// chat list keeps the pressed row where it was on screen instead
// (Chats.svelte); these find the same row in the redrawn message.

export const SWIPE_ROW_BUTTONS = '.button-icon-unreroll, .button-icon-reroll, .button-icon-swipe-next, .button-icon-input-version, .input-echo-versions button'

/** The distinct rows the buttons' tops make, top to bottom (within `tolerance` px is one row). */
export function buttonRows(tops: readonly number[], tolerance = 4): number[] {
    const rows: number[] = []
    for (const top of [...tops].sort((a, b) => a - b)) {
        if (rows.length === 0 || top - rows[rows.length - 1] > tolerance) rows.push(top)
    }
    return rows
}

/** Which row, counted from the bottom (0 = bottom), holds a button at `top`. */
export function rowFromBottom(rows: readonly number[], top: number): number {
    if (rows.length === 0) return 0
    let nearest = 0
    for (let i = 1; i < rows.length; i++) {
        if (Math.abs(rows[i] - top) < Math.abs(rows[nearest] - top)) nearest = i
    }
    return rows.length - 1 - nearest
}

/** The top of the row `fromBottom` rows up from the bottom, or null when there is none. */
export function rowAt(rows: readonly number[], fromBottom: number): number | null {
    const index = rows.length - 1 - fromBottom
    return index >= 0 && index < rows.length ? rows[index] : null
}
