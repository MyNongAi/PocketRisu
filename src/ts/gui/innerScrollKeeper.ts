/**
 * A message's body is rebuilt whole when its HTML changes (a card's HTML/CSS
 * button running a trigger, a variable update, a stream chunk): `{@html}`
 * drops the old nodes and inserts new ones. A box the reader had scrolled
 * inside a card (a status panel, a log, a tab strip) then came back at its
 * start. This remembers each scrolled box by its place in the body (or its id)
 * and puts the position back on the box that replaces it.
 */

export type ElementPath = number[]

/** Child indices from `root` down to `el`; null when `el` is not inside `root`. */
export function elementPath(root: Element, el: Element): ElementPath | null {
    const path: number[] = []
    let node: Element = el
    while (node !== root) {
        const parent = node.parentElement
        if (!parent) return null
        path.push(Array.prototype.indexOf.call(parent.children, node))
        node = parent
    }
    return path.reverse()
}

export function elementAtPath(root: Element, path: ElementPath): Element | null {
    let node: Element | null = root
    for (const index of path) {
        node = node.children[index] ?? null
        if (!node) return null
    }
    return node
}

type KeptScroll = { path: ElementPath, tag: string, id: string, top: number, left: number }

/**
 * After a rebuild, scroll events on the new boxes come from the restore (or
 * from a clamp while images inside still load) until the reader touches the
 * page again, so they must not overwrite what was kept.
 */
export const INNER_SCROLL_SETTLE_MS = 2000

const TOUCH_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

function findKept(root: HTMLElement, entry: KeptScroll): Element | null {
    if (entry.id) {
        const byId = Array.from(root.querySelectorAll('[id]')).find((el) => el.id === entry.id)
        if (byId && byId.tagName === entry.tag) return byId
    }
    const el = elementAtPath(root, entry.path)
    return el && el.tagName === entry.tag ? el : null
}

function scrollBoxTo(el: Element, top: number, left: number) {
    if (el.scrollTop === top && el.scrollLeft === left) return
    // 'instant': a card's own `scroll-behavior: smooth` would otherwise animate it back from the start.
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, left, behavior: 'instant' })
    else {
        el.scrollTop = top
        el.scrollLeft = left
    }
}

/** Keeps the scroll positions of boxes inside `root` across rebuilds of its content. Returns a cleanup. */
export function keepInnerScroll(root: HTMLElement): () => void {
    const kept = new Map<string, KeptScroll>()
    let restoredAt = -Infinity
    let touchedAt = -Infinity

    const settling = () => performance.now() - restoredAt < INNER_SCROLL_SETTLE_MS && touchedAt <= restoredAt

    const onScroll = (event: Event) => {
        const target = event.target
        if (!(target instanceof Element) || target === root || !root.contains(target)) return
        if (settling()) return
        const path = elementPath(root, target)
        if (!path) return
        const key = path.join('/')
        if (target.scrollTop === 0 && target.scrollLeft === 0) kept.delete(key)
        else kept.set(key, { path, tag: target.tagName, id: target.id, top: target.scrollTop, left: target.scrollLeft })
    }

    const restore = () => {
        for (const entry of kept.values()) {
            const el = findKept(root, entry)
            if (el) scrollBoxTo(el, entry.top, entry.left)
        }
    }

    const onTouch = () => {
        touchedAt = performance.now()
    }

    // An image inside the box that loads after the rebuild grows it; a
    // position clamped before that is put back.
    const onLoad = () => {
        if (kept.size && settling()) restore()
    }

    // Only the body's own nodes being swapped (`{@html}`); an image or inlay
    // resolving deeper inside does not move a box.
    const observer = new MutationObserver((records) => {
        if (!kept.size) return
        if (!records.some((record) => record.addedNodes.length > 0)) return
        restoredAt = performance.now()
        restore()
    })
    observer.observe(root, { childList: true })
    root.addEventListener('scroll', onScroll, true)
    root.addEventListener('load', onLoad, true)
    for (const type of TOUCH_EVENTS) root.addEventListener(type, onTouch, { capture: true, passive: true })

    return () => {
        observer.disconnect()
        root.removeEventListener('scroll', onScroll, true)
        root.removeEventListener('load', onLoad, true)
        for (const type of TOUCH_EVENTS) root.removeEventListener(type, onTouch, { capture: true })
    }
}
