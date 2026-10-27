// Character counts beside a lorebook entry's token count (the user's request,
// 2026-10-27), the way Korean word processors count them: "공백 포함" counts
// spaces but not line breaks, "공백 미포함" leaves out every kind of
// whitespace. A character is a code point, so an emoji is not counted twice.
// It runs on every keystroke, so it walks code units instead of a regex.

export interface CharCount {
    noSpace: number
    withSpace: number
}

// What a regex's \s matches, line breaks included.
function isSpace(code: number): boolean {
    return (code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0xa0 || code === 0x1680
        || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
        || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
}

export function countChars(text: string): CharCount {
    let noSpace = 0
    let withSpace = 0
    const value = text ?? ''
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i)
        if (code >= 0xdc00 && code <= 0xdfff) continue
        if (code === 0x0a || code === 0x0d) continue
        withSpace++
        if (!isSpace(code)) noSpace++
    }
    return { noSpace, withSpace }
}
