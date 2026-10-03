// A message body that changes in place. Svelte's {@html} swaps the whole
// fragment whenever the string changes, so a button in a reply that re-renders
// it (risu-btn, a trigger, reloadChat) reset everything the reader had: a
// panel's own scroll position, an opened <details>, a picked tab, a running
// animation, a playing video.
//
// MorphedHtml keeps the parsed source of the last string it rendered. On the
// next string it applies only the source changes between the two (a 3-way
// merge: last source -> new source, onto the live DOM), so:
// - a node whose source did not change is left exactly as it is, including
//   what the app changed after rendering (resolved asset src, classes,
//   resolved inlay placeholders) and what the reader changed (scroll, open);
// - an element whose source changed keeps its identity when its tag is the
//   same; only the attributes and text that changed in the source are set;
// - anything it cannot line up (different tags, or a live child list that no
//   longer matches the source) is replaced by a fresh copy, as before.

type Attr2 = { namespaceURI: string | null, name: string, localName: string, value: string }

function parse(html: string): Node[] {
    const template = document.createElement('template')
    template.innerHTML = html
    return Array.from(template.content.childNodes)
}

function fresh(node: Node): Node {
    return document.importNode(node, true)
}

function attrKey(attr: { namespaceURI: string | null, localName: string }): string {
    return `${attr.namespaceURI ?? ''}|${attr.localName}`
}

function attributesOf(element: Element): Map<string, Attr2> {
    const map = new Map<string, Attr2>()
    for (const attr of Array.from(element.attributes)) {
        map.set(attrKey(attr), { namespaceURI: attr.namespaceURI, name: attr.name, localName: attr.localName, value: attr.value })
    }
    return map
}

// Classes the app adds to a rendered asset image (ChatBody checkImg).
const APP_IMAGE_CLASS = /^root-loaded-image/

function setAttribute(live: Element, attr: Attr2): void {
    let value = attr.value
    if (attr.localName === 'class' && attr.namespaceURI === null && live instanceof HTMLImageElement) {
        const kept = Array.from(live.classList).filter((name) => APP_IMAGE_CLASS.test(name))
        value = [...new Set([...value.split(/\s+/).filter(Boolean), ...kept])].join(' ')
    }
    if (attr.namespaceURI) live.setAttributeNS(attr.namespaceURI, attr.name, value)
    else live.setAttribute(attr.name, value)
    // A form control the reader touched no longer follows its attribute.
    if (live instanceof HTMLInputElement && attr.namespaceURI === null) {
        if (attr.localName === 'value') live.value = value
        if (attr.localName === 'checked') live.checked = true
    }
}

function removeAttribute(live: Element, attr: Attr2): void {
    if (attr.namespaceURI) live.removeAttributeNS(attr.namespaceURI, attr.localName)
    else live.removeAttribute(attr.name)
    if (live instanceof HTMLInputElement && attr.namespaceURI === null) {
        if (attr.localName === 'value') live.value = ''
        if (attr.localName === 'checked') live.checked = false
    }
}

function mergeAttributes(live: Element, prev: Element, next: Element): void {
    const before = attributesOf(prev)
    const after = attributesOf(next)
    for (const [key, attr] of after) {
        if (before.get(key)?.value !== attr.value) setAttribute(live, attr)
    }
    for (const [key, attr] of before) {
        if (!after.has(key)) removeAttribute(live, attr)
    }
}

function sameShape(a: Node, b: Node): boolean {
    return a.nodeType === b.nodeType && a.nodeName === b.nodeName
}

/** Morph one live node; returns the node now in its place. */
function morphNode(live: Node, prev: Node, next: Node): Node {
    if (prev.isEqualNode(next)) return live
    if (!sameShape(prev, next) || !sameShape(live, prev) || next.nodeName === 'TEMPLATE') {
        const replacement = fresh(next)
        live.parentNode?.replaceChild(replacement, live)
        return replacement
    }
    if (next.nodeType === Node.TEXT_NODE || next.nodeType === Node.COMMENT_NODE || next.nodeType === Node.CDATA_SECTION_NODE) {
        if (prev.nodeValue !== next.nodeValue) live.nodeValue = next.nodeValue
        return live
    }
    if (next.nodeType !== Node.ELEMENT_NODE) {
        const replacement = fresh(next)
        live.parentNode?.replaceChild(replacement, live)
        return replacement
    }
    mergeAttributes(live as Element, prev as Element, next as Element)
    morphChildren(live, Array.from(live.childNodes), Array.from(prev.childNodes), Array.from(next.childNodes), null)
    return live
}

/**
 * Morph a run of live nodes in `parent` (in document order, followed by
 * `after` or the end of `parent`) from the `prev` source list to `next`.
 * Returns the live nodes that now stand for `next`, in order.
 */
function morphChildren(parent: Node, live: Node[], prev: Node[], next: Node[], after: Node | null): Node[] {
    if (live.length !== prev.length || live.some((node) => node.parentNode !== parent)) {
        // Something else rearranged these nodes: start over for this run.
        const end = live.length > 0 ? live[live.length - 1].nextSibling : after
        for (const node of live) node.parentNode?.removeChild(node)
        const replacements = next.map(fresh)
        for (const node of replacements) parent.insertBefore(node, end && end.parentNode === parent ? end : null)
        return replacements
    }
    let head = 0
    while (head < prev.length && head < next.length && prev[head].isEqualNode(next[head])) head++
    let tail = 0
    while (
        tail < prev.length - head && tail < next.length - head
        && prev[prev.length - 1 - tail].isEqualNode(next[next.length - 1 - tail])
    ) tail++

    const result = live.slice(0, head)
    const prevMiddle = prev.slice(head, prev.length - tail)
    const nextMiddle = next.slice(head, next.length - tail)
    const liveMiddle = live.slice(head, live.length - tail)
    const shared = Math.min(prevMiddle.length, nextMiddle.length)
    for (let index = 0; index < shared; index++) {
        result.push(morphNode(liveMiddle[index], prevMiddle[index], nextMiddle[index]))
    }
    for (const node of liveMiddle.slice(shared)) node.parentNode?.removeChild(node)
    const liveTail = live.slice(live.length - tail)
    const insertAt = liveTail[0] ?? (live.length > 0 ? live[live.length - 1].nextSibling : after)
    for (const node of nextMiddle.slice(shared)) {
        const added = fresh(node)
        parent.insertBefore(added, insertAt && insertAt.parentNode === parent ? insertAt : null)
        result.push(added)
    }
    return result.concat(liveTail)
}

export class MorphedHtml {
    private root: Node | null = null
    private live: Node[] = []
    private source: Node[] = []
    private html: string | null = null

    /** Show `html` at the end of `root`; returns whether the DOM changed. */
    render(root: Node, html: string): boolean {
        if (root !== this.root) {
            this.clear()
            this.root = root
        }
        if (html === this.html) return false
        const next = parse(html)
        if (this.html === null) {
            this.live = next.map(fresh)
            for (const node of this.live) root.appendChild(node)
        } else {
            this.live = morphChildren(root, this.live, this.source, next, null)
        }
        this.source = next
        this.html = html
        return true
    }

    /** Remove what this instance rendered. */
    clear(): void {
        for (const node of this.live) node.parentNode?.removeChild(node)
        this.live = []
        this.source = []
        this.html = null
        this.root = null
    }
}
