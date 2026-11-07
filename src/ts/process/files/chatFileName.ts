/**
 * The extension the chat's file upload reads a file by (multisend.ts,
 * inlays.ts). It was compared as written, so a photo named "IMG_0001.JPG"
 * or "a.PNG", and a JPEG saved as ".jfif" (as browsers save many web
 * images), matched no type and was dropped without a word (the user's
 * report, 2026-11-08: "더 올리려니 올려도 반응이없는데"). Now in lower case,
 * with a JPEG's other names read as jpeg.
 */
const JPEG_NAMES = new Set(['jfif', 'jpe', 'pjpeg', 'pjp'])

export function chatFileExtension(name: string): string {
    const dot = name.lastIndexOf('.')
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
    return JPEG_NAMES.has(ext) ? 'jpeg' : ext
}
