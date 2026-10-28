// A bot's asset images shown whole, per bot (the user's request, 2026-10-28).
// A bot's or module's CSS may crop the pictures it draws into messages: the
// asset module the user met draws each one as a 100%-wide, 10em-tall box with
// `background-size: cover` under 768px, so a phone shows only the top tenth of
// a portrait. With the bot's switch on (Toggles.svelte), a cropped picture in
// a message is shown whole at its own ratio. Small ones (status-window icons,
// round avatars) keep the bot's design, and so does anything outside messages.

/** Marks a picture shown whole; styles.css sizes it by its ratio. */
export const WHOLE_ASSET_ATTR = 'data-pr-whole-asset'
/** The picture's own width / height, for the CSS. */
export const WHOLE_RATIO_VAR = '--pr-whole-ratio'
/** Narrower pictures are icons or avatars and keep the bot's design. */
export const MIN_WIDTH = 160
/** How far the box's ratio may stray from the picture's before it counts as cropped. */
export const RATIO_SLACK = 0.03

const MESSAGES = '.chattext'

export type Size = { width: number, height: number }

/** Whether a box of `box` shows a picture of `picture` cropped (or stretched). */
export function isCropped(box: Size, picture: Size): boolean {
    if (!(box.width > 0 && box.height > 0 && picture.width > 0 && picture.height > 0)) return false
    const ratio = (box.width / box.height) / (picture.width / picture.height)
    return Math.abs(ratio - 1) > RATIO_SLACK
}

/** The one picture a computed `background-image` shows, or null (none, a gradient, several layers). */
export function backgroundUrl(backgroundImage: string): string | null {
    const match = /^url\((?:"([^"]*)"|'([^']*)'|([^"')]*))\)$/.exec(backgroundImage.trim())
    return (match && (match[1] ?? match[2] ?? match[3])) || null
}

/** Whether an element draws nothing but its background (no text, no child elements). */
function isBareBox(element: Element): boolean {
    return element.childElementCount === 0 && !(element.textContent ?? '').trim()
}

const sizes = new Map<string, Promise<Size | null>>()

/** The picture's own size, loaded once per address. */
export function pictureSize(url: string): Promise<Size | null> {
    let found = sizes.get(url)
    if (!found) {
        found = new Promise((resolve) => {
            const image = new Image()
            image.onload = () => resolve(image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null)
            image.onerror = () => resolve(null)
            image.src = url
        })
        sizes.set(url, found)
        // a failure is not remembered: the address may load later
        found.then((size) => { if (!size) sizes.delete(url) })
    }
    return found
}

function boxOf(element: Element): Size {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
}

function mark(element: HTMLElement, picture: Size) {
    element.style.setProperty(WHOLE_RATIO_VAR, `${picture.width} / ${picture.height}`)
    element.setAttribute(WHOLE_ASSET_ATTR, '')
}

/** Show the cropped pictures in the messages under `screen` whole. Resolves to how many were marked. */
export async function showWholeAssets(screen: Element): Promise<number> {
    const view = screen.ownerDocument.defaultView
    if (!view) return 0
    const pending: Promise<boolean>[] = []
    for (const root of Array.from(screen.querySelectorAll(MESSAGES))) {
        for (const element of Array.from(root.querySelectorAll(`*:not([${WHOLE_ASSET_ATTR}])`))) {
            if (!(element instanceof view.HTMLElement)) continue
            if (element instanceof view.HTMLImageElement) {
                if (!element.complete || !element.naturalWidth) continue
                const box = boxOf(element)
                const fit = view.getComputedStyle(element).objectFit
                if (box.width < MIN_WIDTH || (fit !== 'cover' && fit !== 'none')) continue
                const picture = { width: element.naturalWidth, height: element.naturalHeight }
                if (isCropped(box, picture)) { mark(element, picture); pending.push(Promise.resolve(true)) }
                continue
            }
            if (!isBareBox(element)) continue
            const style = view.getComputedStyle(element)
            const url = backgroundUrl(style.backgroundImage)
            if (!url || style.backgroundSize === 'contain' || boxOf(element).width < MIN_WIDTH) continue
            pending.push(pictureSize(url).then((picture) => {
                if (!picture || !element.isConnected || element.hasAttribute(WHOLE_ASSET_ATTR)) return false
                if (!isCropped(boxOf(element), picture)) return false
                mark(element, picture)
                return true
            }))
        }
    }
    return (await Promise.all(pending)).filter(Boolean).length
}

export function showCroppedAssets(screen: Element): void {
    for (const element of Array.from(screen.querySelectorAll(`[${WHOLE_ASSET_ATTR}]`))) {
        element.removeAttribute(WHOLE_ASSET_ATTR)
        ;(element as HTMLElement).style.removeProperty(WHOLE_RATIO_VAR)
    }
}

/**
 * Svelte action for the chat screen: while `enabled`, show the cropped
 * pictures in messages whole, again whenever messages change, a picture
 * loads or the window is resized.
 */
export function wholeBotAssets(screen: HTMLElement, enabled: boolean) {
    let on = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
        if (!on || timer) return
        timer = setTimeout(() => {
            timer = null
            if (on) void showWholeAssets(screen)
        }, 150)
    }
    // Marking a picture changes its style; that alone does not rescan.
    const observer = new MutationObserver((records) => {
        if (records.some((record) => !(record.type === 'attributes' && (record.target as Element).hasAttribute?.(WHOLE_ASSET_ATTR)))) schedule()
    })
    const start = () => {
        on = true
        observer.observe(screen, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'src'] })
        screen.addEventListener('load', schedule, true)
        window.addEventListener('resize', schedule)
        void showWholeAssets(screen)
        schedule() // once more after the markdown settles
    }
    const stop = () => {
        on = false
        observer.disconnect()
        screen.removeEventListener('load', schedule, true)
        window.removeEventListener('resize', schedule)
        if (timer) { clearTimeout(timer); timer = null }
        showCroppedAssets(screen)
    }
    if (enabled) start()
    return {
        update(next: boolean) {
            if (next && !on) start()
            else if (!next && on) stop()
        },
        destroy() { if (on) stop() },
    }
}
