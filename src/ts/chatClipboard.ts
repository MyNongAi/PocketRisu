const PORTABLE_STYLE_PROPERTIES = [
    'display', 'visibility', 'box-sizing',
    'position', 'top', 'right', 'bottom', 'left', 'z-index',
    'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'aspect-ratio',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'overflow', 'overflow-x', 'overflow-y',
    'color', 'background-color', 'background-image', 'background-size',
    'background-position', 'background-repeat', 'background-clip',
    'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-radius', 'border-collapse', 'border-spacing', 'table-layout', 'box-shadow', 'outline',
    'font-family', 'font-size', 'font-style', 'font-weight', 'line-height',
    'letter-spacing', 'text-align', 'text-decoration', 'text-shadow',
    'white-space', 'word-break', 'overflow-wrap',
    'object-fit', 'object-position', 'opacity', 'filter', 'clip-path',
    'flex', 'flex-basis', 'flex-direction', 'flex-grow', 'flex-shrink',
    'flex-wrap', 'align-content', 'align-items', 'align-self',
    'justify-content', 'justify-items', 'justify-self', 'gap',
    'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
    'transform', 'transform-origin', 'transform-style', 'perspective', 'perspective-origin', 'backface-visibility', 'vertical-align',
    'fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
] as const

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Call directly in the click handler, before awaiting downloads. ClipboardItem
 * accepts a promised Blob, so the browser can authorize the write while the
 * click still has focus/user activation. Never silently downgrade image logs
 * to text or retry writeText after a focus failure. */
export function writeChatClipboard(text: string, html: Promise<string>): Promise<void> {
    const content = html.then(value => new Blob([value], { type: 'text/html' }))
    // The browser may reject before it ever consumes the promised HTML.
    void content.catch(() => {})
    if (!document.hasFocus()) {
        return Promise.reject(new Error('리스 창으로 돌아온 뒤 복사 버튼을 다시 눌러 주세요. 클립보드에는 아직 복사되지 않았습니다.'))
    }
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        return Promise.reject(new Error('이 브라우저에서는 이미지가 포함된 HTML 복사를 사용할 수 없습니다. localhost 또는 HTTPS에서 열어 주세요.'))
    }
    try {
        return navigator.clipboard.write([new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' }),
            'text/html': content,
        })])
    } catch (error) {
        return Promise.reject(error)
    }
}

export function chatClipboardErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    if (/not focused|notallowed|denied|not allowed/i.test(message)
        || (error instanceof DOMException && error.name === 'NotAllowedError')) {
        return '복사 권한 또는 창 포커스가 없어 복사하지 못했습니다. 리스 창으로 돌아와 복사 버튼을 다시 눌러 주세요.'
    }
    return `채팅을 복사하지 못했습니다: ${message}`
}

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

function preservePortableLayout(source: HTMLElement, clone: HTMLElement, computed: CSSStyleDeclaration, hasText: boolean, hasPseudo: boolean): void {
    const isMedia = /^(IMG|VIDEO|CANVAS|SVG)$/.test(source.tagName)
    const isOutOfFlow = computed.position === 'absolute' || computed.position === 'fixed'
    const mediaFrame = !hasText && (hasPseudo || !!source.querySelector('img,video,canvas,svg') || !!computed.backgroundImage && computed.backgroundImage !== 'none')
    const childStyles = Array.from(source.children).filter(child => !/^(STYLE|SCRIPT|LINK)$/.test(child.tagName))
        .map(child => getComputedStyle(child)).filter(style => style.display !== 'none')
    const positionedChildren = childStyles.filter(style => style.position === 'absolute' || style.position === 'fixed')
    const directText = Array.from(source.childNodes).some(child => child.nodeType === Node.TEXT_NODE && !!child.textContent?.trim())
    // A notebook cover/canvas may consist entirely of absolutely positioned
    // panels. Its measured height is the ONLY thing keeping it in the flow.
    const positionedCanvas = !directText && positionedChildren.length > 0 && positionedChildren.length === childStyles.length
    // A table cell's computed height includes its image. Keeping that old
    // pixel height while the destination narrows the image creates an empty
    // strip inside the author's frame.
    if (/^(TABLE|THEAD|TBODY|TFOOT|TR|TD|TH)$/.test(source.tagName) && !positionedCanvas) {
        clone.style.height = 'auto'
        clone.style.minHeight = '0'
    }
    // getComputedStyle resolves auto heights/widths to the CURRENT pixel box.
    // Freezing those pixels makes details opening overlap following paragraphs,
    // and forces short labels to wrap letter-by-letter in a narrower editor.
    if (!isMedia && !isOutOfFlow && !mediaFrame && !positionedCanvas) {
        clone.style.height = 'auto'
        if (hasText || source instanceof HTMLDetailsElement) {
            clone.style.width = 'auto'
            clone.style.minWidth = '0'
            clone.style.minHeight = '0'
            clone.style.maxHeight = 'none'
            clone.style.wordBreak = 'normal'
            clone.style.overflowWrap = 'break-word'
        }
    }
    if (computed.display === 'flex' || computed.display === 'inline-flex') {
        clone.style.flexWrap = 'wrap'
    }
    if (computed.display === 'grid') {
        // Resolved pixel tracks describe the old chat width, not the narrower
        // article width. Preserve their proportions without freezing pixels.
        const tracks = computed.gridTemplateColumns.trim().split(/\s+/)
        if (tracks.length > 1 && tracks.every(track => /^\d+(?:\.\d+)?px$/.test(track))) {
            clone.style.gridTemplateColumns = tracks.map(track => `minmax(0, ${parseFloat(track)}fr)`).join(' ')
        }
        clone.style.gridTemplateRows = 'auto'
    }
    if (source instanceof HTMLDetailsElement || !positionedCanvas && source.querySelector('details')) {
        clone.style.height = 'auto'
        clone.style.maxHeight = 'none'
        clone.style.overflow = 'visible'
    }
    if (isMedia || mediaFrame) {
        clone.style.maxWidth = '100%'
    }
    // Inline dimensions and aspect-ratio retain the collapsed image even if a
    // paste target overrides a plain height declaration with its own img rule.
    if (source instanceof HTMLImageElement && computed.aspectRatio && computed.aspectRatio !== 'auto') {
        clone.style.setProperty('aspect-ratio', computed.aspectRatio, 'important')
        clone.style.setProperty('height', 'auto', 'important')
        clone.style.setProperty('object-fit', computed.objectFit, 'important')
        clone.style.setProperty('object-position', computed.objectPosition, 'important')
    }
}

function objectPositionFraction(token: string, axis: 'x' | 'y'): number {
    if (token === 'center') return 0.5
    if (token === 'left' || token === 'top') return 0
    if (token === 'right' || token === 'bottom') return 1
    if (token.endsWith('%')) {
        const value = Number.parseFloat(token)
        if (Number.isFinite(value)) return value / 100
    }
    return axis === 'x' ? 0.5 : 0.5
}

export function coverImagePlacement(sourceWidth: number, sourceHeight: number, boxWidth: number, boxHeight: number, objectPosition: string): { x: number; y: number; width: number; height: number } {
    const scale = Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight)
    const width = sourceWidth * scale
    const height = sourceHeight * scale
    const tokens = objectPosition.trim().toLowerCase().split(/\s+/)
    const verticalFirst = tokens[0] === 'top' || tokens[0] === 'bottom'
    const horizontal = verticalFirst ? tokens[1] || 'center' : tokens[0] || 'center'
    const vertical = verticalFirst ? tokens[0] : tokens[1] || (horizontal === 'top' || horizontal === 'bottom' ? horizontal : 'center')
    return {
        x: (boxWidth - width) * objectPositionFraction(horizontal, 'x') || 0,
        y: (boxHeight - height) * objectPositionFraction(vertical, 'y') || 0,
        width,
        height,
    }
}

function loadClipboardImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('Clipboard image could not be decoded'))
        image.src = url
    })
}

function clipboardCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const canvas = document.createElement('canvas')
    const scale = Math.min(2, 2048 / Math.max(width, height))
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Clipboard canvas is unavailable')
    context.scale(canvas.width / width, canvas.height / height)
    return [canvas, context]
}

async function rasterizeCoverImage(url: string, width: number, height: number, position: string): Promise<string> {
    const image = await loadClipboardImage(url)
    const [canvas, context] = clipboardCanvas(width, height)
    const placement = coverImagePlacement(image.naturalWidth, image.naturalHeight, width, height, position)
    context.drawImage(image, placement.x, placement.y, placement.width, placement.height)
    return canvas.toDataURL('image/png')
}

async function rasterizeSvg(svg: SVGSVGElement, width: number, height: number): Promise<string> {
    const snapshot = svg.cloneNode(true) as SVGSVGElement
    snapshot.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    snapshot.setAttribute('width', String(width))
    snapshot.setAttribute('height', String(height))
    const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(snapshot))}`
    const image = await loadClipboardImage(source)
    const [canvas, context] = clipboardCanvas(width, height)
    context.drawImage(image, 0, 0, width, height)
    return canvas.toDataURL('image/png')
}

/** Decode resolved quoted CSS content only; never interpret it as HTML. */
export function decodeClipboardCssContent(content: string): string | null {
    const tokens = content.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)
    if (!tokens?.length) return null
    // Counters, attr(), URLs and alternative text need their own semantics.
    // Do not accidentally copy their arguments as visible strings.
    if (content.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '').trim()) return null
    return tokens.map(token => token.slice(1, -1).replace(/\\([0-9a-f]{1,6})(?:\r\n|\s)?|\\(?:\r\n|\n|\r)|\\(.)/gi,
        (_match, hex: string | undefined, escaped: string | undefined) => {
            if (!hex) return escaped ?? ''
            const code = parseInt(hex, 16)
            return code === 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff ? '\uFFFD' : String.fromCodePoint(code)
        })).join('')
}

function snapshotPseudoElement(style: CSSStyleDeclaration): HTMLElement | null {
    if (!style.content || style.content === 'none' || style.content === 'normal' || style.display === 'none') return null
    const text = decodeClipboardCssContent(style.content)
    const contentUrls = extractCssUrls(style.content)
    if (text === null && contentUrls.length !== 1) return null
    const element = document.createElement(contentUrls.length ? 'img' : 'span')
    element.setAttribute('style', portableStyle(style))
    if (element instanceof HTMLImageElement) {
        element.src = contentUrls[0]
        element.alt = ''
    } else {
        element.textContent = text
    }
    return element
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
    options: {
        fetchFn?: FetchLike
        getPseudoStyle?: (element: Element, pseudo: '::before' | '::after') => CSSStyleDeclaration
        rasterizeSvg?: (svg: SVGSVGElement, width: number, height: number) => Promise<string>
        rasterizeCover?: (url: string, width: number, height: number, position: string) => Promise<string>
    } = {},
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

    const assetTasks: Array<() => Promise<void>> = []
    const readPseudo = options.getPseudoStyle ?? ((element: Element, pseudo: string) => getComputedStyle(element, pseudo))
    const textContentFlags = new Map<Node, boolean>()
    // Bottom-up flags avoid cloning/scanning every descendant subtree. Style
    // rules are not visible text and must not turn an image frame into a label.
    for (let index = sources.length - 1; index >= 0; index--) {
        const element = sources[index]
        textContentFlags.set(element, !/^(STYLE|SCRIPT)$/.test(element.tagName) && Array.from(element.childNodes).some(
            child => child.nodeType === Node.TEXT_NODE ? !!child.textContent?.trim() : !!textContentFlags.get(child),
        ))
    }
    // Snapshot all styles in one synchronous pass. Awaiting an image midway
    // used to capture different hover/layout states within the same message.
    for (let index = 0; index < Math.min(sources.length, clones.length); index++) {
        const source = sources[index]
        const clone = clones[index]
        if (!(source instanceof HTMLElement || source instanceof SVGElement) || !(clone instanceof HTMLElement || clone instanceof SVGElement)) continue

        const computed = getComputedStyle(source)
        const flattened = portableStyle(computed)
        if (flattened) clone.setAttribute('style', flattened)

        const background = computed.backgroundImage
        if (background && background !== 'none') {
            assetTasks.push(async () => { clone.style.backgroundImage = await inlineCssUrls(background, toDataUrl) })
        }

        let hasPseudo = false
        if (source instanceof HTMLElement && !/^(IMG|INPUT|BR|HR|META|LINK|SCRIPT|STYLE|VIDEO|CANVAS)$/.test(source.tagName)) {
            for (const pseudo of ['::before', '::after'] as const) {
                try {
                    const style = readPseudo(source, pseudo)
                    const decoration = snapshotPseudoElement(style)
                    if (!decoration) continue
                    hasPseudo = true
                    if (pseudo === '::before') clone.prepend(decoration)
                    else clone.append(decoration)
                    const pseudoBackground = style.backgroundImage
                    const pseudoSource = decoration.getAttribute('src')
                    assetTasks.push(async () => {
                        if (pseudoBackground && pseudoBackground !== 'none') decoration.style.backgroundImage = await inlineCssUrls(pseudoBackground, toDataUrl)
                        if (pseudoSource && decoration instanceof HTMLImageElement) {
                            try { decoration.src = await toDataUrl(pseudoSource) } catch { /* keep link */ }
                        }
                    })
                } catch { /* DOM adapters or older engines may not expose pseudo styles. */ }
            }
        }
        if (source instanceof HTMLElement && clone instanceof HTMLElement) {
            preservePortableLayout(source, clone, computed, !!textContentFlags.get(source), hasPseudo)
        }

        if (source instanceof HTMLDetailsElement && clone instanceof HTMLDetailsElement) {
            clone.open = source.open
        }

        // Capture the URL before a concurrent viewport update can release it.
        const imageUrl = source instanceof HTMLImageElement ? source.currentSrc || source.getAttribute('src') : null
        const imageBox = source instanceof HTMLImageElement ? source.getBoundingClientRect() : null
        assetTasks.push(async () => {
            if (imageUrl && clone instanceof HTMLImageElement) {
                try {
                    const embedded = await toDataUrl(imageUrl)
                    clone.src = embedded
                    if (computed.objectFit === 'cover' && imageBox && imageBox.width > 0 && imageBox.height > 0 && !/^data:image\/(?:gif|svg\+xml)/i.test(embedded)) {
                        try {
                            clone.src = await (options.rasterizeCover ?? rasterizeCoverImage)(embedded, imageBox.width, imageBox.height, computed.objectPosition)
                            clone.style.setProperty('aspect-ratio', 'auto', 'important')
                            clone.style.setProperty('height', 'auto', 'important')
                            clone.style.setProperty('width', '100%', 'important')
                            clone.style.setProperty('object-fit', 'fill', 'important')
                        } catch { /* keep the original embedded image */ }
                    }
                } catch { clone.src = imageUrl }
                clone.removeAttribute('srcset')
                clone.removeAttribute('loading')
            } else {
                await embedElementAssets(source, clone, toDataUrl)
            }
        })
    }

    for (const task of assetTasks) await task()
    // Rich status widgets often draw their icons as inline SVG. Third-party
    // editors sanitize SVG markup, so paste a bitmap of each visible icon.
    for (let index = 0; index < sources.length; index++) {
        const source = sources[index]
        const clone = clones[index]
        if (!(source instanceof SVGSVGElement) || !(clone instanceof SVGSVGElement) || !cloneRoot.contains(clone)) continue
        const box = source.getBoundingClientRect()
        if (box.width <= 0 || box.height <= 0) continue
        try {
            const url = await (options.rasterizeSvg ?? rasterizeSvg)(clone, box.width, box.height)
            const image = document.createElement('img')
            image.src = url
            image.alt = source.getAttribute('aria-label') || ''
            image.style.cssText = clone.getAttribute('style') ?? ''
            image.style.width = `${box.width}px`
            image.style.height = `${box.height}px`
            image.style.maxWidth = '100%'
            clone.replaceWith(image)
        } catch { /* preserve SVG markup if the browser cannot rasterize it */ }
    }
    cloneRoot.querySelectorAll('script, style, link, [data-risu-copy-ignore]').forEach((node) => node.remove())
    for (const element of [cloneRoot, ...cloneRoot.querySelectorAll('*')]) {
        // Retained class rules on the destination must not re-enable hover or
        // override the snapshot. The portable copy needs no executable hooks.
        element.removeAttribute('class')
        // SVG clip-path/use references may depend on IDs inside the fragment.
        if (!(element instanceof SVGElement)) element.removeAttribute('id')
        for (const attr of Array.from(element.attributes)) {
            if (/^on/i.test(attr.name)) element.removeAttribute(attr.name)
        }
    }
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
