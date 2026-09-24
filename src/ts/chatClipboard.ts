const PORTABLE_STYLE_PROPERTIES = [
    'display', 'visibility', 'box-sizing',
    'position', 'top', 'right', 'bottom', 'left', 'z-index',
    'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'overflow', 'overflow-x', 'overflow-y',
    'color', 'background-color', 'background-image', 'background-size',
    'background-position', 'background-repeat', 'background-clip',
    'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-radius', 'box-shadow', 'outline',
    'font-family', 'font-size', 'font-style', 'font-weight', 'line-height',
    'letter-spacing', 'text-align', 'text-decoration', 'text-shadow',
    'white-space', 'word-break', 'overflow-wrap',
    'object-fit', 'object-position', 'opacity', 'filter', 'clip-path',
    'flex', 'flex-basis', 'flex-direction', 'flex-grow', 'flex-shrink',
    'flex-wrap', 'align-content', 'align-items', 'align-self',
    'justify-content', 'justify-items', 'justify-self', 'gap',
    'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
    'transform', 'transform-origin', 'vertical-align',
] as const

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function extractCssUrls(value: string): string[] {
    const urls: string[] = []
    const pattern = /url\(\s*(?:(['"])(.*?)\1|([^)]*))\s*\)/gi
    for (const match of value.matchAll(pattern)) {
        const url = (match[2] ?? match[3] ?? '').trim()
        if (url) urls.push(url)
    }
    return urls
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(reader.error ?? new Error('Failed to encode clipboard asset'))
        reader.readAsDataURL(blob)
    })
}

export async function fetchClipboardDataUrl(url: string, fetchFn: FetchLike = fetch): Promise<string> {
    if (!url || url.startsWith('data:')) return url
    const response = await fetchFn(url, { credentials: 'include' })
    if (!response.ok) throw new Error(`Clipboard asset fetch failed: ${response.status}`)
    return blobToDataUrl(await response.blob())
}

export async function inlineCssUrls(
    value: string,
    toDataUrl: (url: string) => Promise<string>,
): Promise<string> {
    let output = value
    const urls = [...new Set(extractCssUrls(value))]
    for (const url of urls) {
        if (url.startsWith('data:')) continue
        try {
            const embedded = await toDataUrl(url)
            if (!embedded) continue
            output = output.split(url).join(embedded)
        } catch {
            // Keep the original URL as a last-resort link instead of deleting
            // the author's background or failing the whole clipboard copy.
        }
    }
    return output
}

function portableStyle(style: CSSStyleDeclaration): string {
    const result: string[] = []
    for (const property of PORTABLE_STYLE_PROPERTIES) {
        const value = style.getPropertyValue(property)
        if (!value) continue
        result.push(`${property}:${value}${style.getPropertyPriority(property) ? ' !important' : ''}`)
    }
    return result.join(';')
}

async function embedElementAssets(
    source: Element,
    clone: Element,
    toDataUrl: (url: string) => Promise<string>,
): Promise<void> {
    if (source instanceof HTMLImageElement && clone instanceof HTMLImageElement) {
        const sourceUrl = source.currentSrc || source.getAttribute('src') || ''
        if (sourceUrl) {
            try {
                clone.src = await toDataUrl(sourceUrl)
                clone.removeAttribute('srcset')
                clone.removeAttribute('loading')
            } catch {
                clone.src = sourceUrl
            }
        }
    }

    if (source instanceof HTMLVideoElement && clone instanceof HTMLVideoElement && source.poster) {
        try { clone.poster = await toDataUrl(source.poster) } catch { clone.poster = source.poster }
    }

    if (source instanceof HTMLCanvasElement && clone instanceof HTMLCanvasElement) {
        try {
            const image = document.createElement('img')
            image.src = source.toDataURL('image/png')
            image.alt = source.getAttribute('aria-label') || 'canvas'
            image.setAttribute('style', clone.getAttribute('style') ?? '')
            clone.replaceWith(image)
        } catch { /* a tainted canvas remains as an empty canvas */ }
    }
}

/**
 * Flatten the currently rendered chat DOM into portable clipboard HTML.
 * Risu-only class rules and local/blob asset URLs cannot survive on another
 * origin, so computed styles and bytes are embedded while the source DOM is
 * left untouched.
 */
export async function buildPortableChatFragment(
    sourceRoot: HTMLElement,
    options: { fetchFn?: FetchLike } = {},
): Promise<string> {
    const cloneRoot = sourceRoot.cloneNode(true) as HTMLElement
    const sources = [sourceRoot, ...Array.from(sourceRoot.querySelectorAll('*'))]
    const clones = [cloneRoot, ...Array.from(cloneRoot.querySelectorAll('*'))]
    const fetchFn = options.fetchFn ?? fetch
    const cache = new Map<string, Promise<string>>()
    const toDataUrl = (url: string) => {
        let pending = cache.get(url)
        if (!pending) {
            pending = fetchClipboardDataUrl(url, fetchFn)
            cache.set(url, pending)
        }
        return pending
    }

    for (let index = 0; index < Math.min(sources.length, clones.length); index++) {
        const source = sources[index]
        const clone = clones[index]
        if (!(source instanceof HTMLElement) || !(clone instanceof HTMLElement)) continue

        const computed = getComputedStyle(source)
        const flattened = portableStyle(computed)
        if (flattened) clone.setAttribute('style', flattened)

        const background = computed.backgroundImage
        if (background && background !== 'none') {
            clone.style.backgroundImage = await inlineCssUrls(background, toDataUrl)
        }

        if (source instanceof HTMLDetailsElement && clone instanceof HTMLDetailsElement) {
            clone.open = source.open
        }

        await embedElementAssets(source, clone, toDataUrl)
    }

    cloneRoot.querySelectorAll('script, [data-risu-copy-ignore]').forEach((node) => node.remove())
    // Keep the chat body's own box as well. Many character cards attach the
    // visible frame/background to this top-level element rather than one of
    // its children, so returning only innerHTML silently dropped the frame.
    return cloneRoot.outerHTML
}

/** Embed ordinary parsed HTML when no live chat body is mounted. */
export async function embedParsedChatAssets(
    root: HTMLElement,
    options: { fetchFn?: FetchLike } = {},
): Promise<void> {
    const fetchFn = options.fetchFn ?? fetch
    const cache = new Map<string, Promise<string>>()
    const toDataUrl = (url: string) => {
        let pending = cache.get(url)
        if (!pending) {
            pending = fetchClipboardDataUrl(url, fetchFn)
            cache.set(url, pending)
        }
        return pending
    }

    for (const image of Array.from(root.querySelectorAll('img'))) {
        const url = image.getAttribute('src') ?? ''
        if (!url) continue
        try {
            image.src = await toDataUrl(url)
            image.removeAttribute('srcset')
        } catch { /* preserve source URL */ }
    }
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('[style*="background"]'))) {
        if (!element.style.backgroundImage) continue
        element.style.backgroundImage = await inlineCssUrls(element.style.backgroundImage, toDataUrl)
    }
}
