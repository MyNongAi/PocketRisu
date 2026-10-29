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

// Writing every property above on every element made a copy about 2 KB of
// style per element, so a long reply ran to megabytes and a board refused the
// post ("request entity too large", the user's report, 2026-10-28). Now a
// property goes out only where it changes something:
// - those a child takes from its parent (CSS inheritance) only where they
//   differ from the parent's value (the copied root writes them all);
// - the rest only where they differ from the browser's default for the tag;
// - ALWAYS_STYLE_PROPERTIES on every element, since a board's own stylesheet
//   (Arca's editor view sets paragraph margins, size and line height) would
//   otherwise take their place.
const INHERITED_STYLE_PROPERTIES = new Set<string>([
    'visibility', 'color', 'font-family', 'font-size', 'font-style', 'font-weight', 'line-height',
    'letter-spacing', 'text-align', 'text-shadow', 'white-space', 'word-break', 'overflow-wrap',
    'border-collapse', 'border-spacing',
    'fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
])
const ALWAYS_STYLE_PROPERTIES = new Set<string>([
    'display', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'color', 'font-size', 'line-height', 'font-weight', 'text-align',
])

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Call directly in the click handler, before awaiting downloads. ClipboardItem
 * accepts a promised Blob, so the browser can authorize the write while the
 * click still has focus/user activation. Never silently downgrade image logs
 * to text or retry writeText after a focus failure. */
export function writeChatClipboard(text: string | Promise<string>, html: Promise<string>): Promise<void> {
    const content = html.then(value => new Blob([value], { type: 'text/html' }))
    // The text log's plain text comes with its HTML, after the click (logCaptureState.svelte.ts).
    const plain = typeof text === 'string' ? new Blob([text], { type: 'text/plain' }) : text.then(value => new Blob([value], { type: 'text/plain' }))
    // The browser may reject before it ever consumes the promised HTML.
    void content.catch(() => {})
    if (plain instanceof Promise) void plain.catch(() => {})
    if (!document.hasFocus()) {
        return Promise.reject(new Error('리스 창으로 돌아온 뒤 복사 버튼을 다시 눌러 주세요. 클립보드에는 아직 복사되지 않았습니다.'))
    }
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        return Promise.reject(new Error('이 브라우저에서는 이미지가 포함된 HTML 복사를 사용할 수 없습니다. localhost 또는 HTTPS에서 열어 주세요.'))
    }
    try {
        return navigator.clipboard.write([new ClipboardItem({
            'text/plain': plain,
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

// Images go into a copy no larger than they are shown (twice that, for
// sharp screens; CLIPBOARD_IMAGE_MAX_EDGE on the long side at most) and as
// WebP. A board keeps the pasted images inline in the post it sends, and
// full-size originals (a portrait drawn at 80 px, a large background on every
// box that uses it) made a single reply too large for Arca: "413 request
// entity too large" (the user's report, 2026-10-17).
export const CLIPBOARD_IMAGE_MAX_EDGE = 1600
const CLIPBOARD_IMAGE_DENSITY = 2
const CLIPBOARD_WEBP_QUALITY = 0.85

/**
 * The max-width an image of a copy carries: no wider than it was shown.
 * Arca drops a pasted image's width (style and attribute) and shows it at
 * its pixel width, twice the shown size here, but keeps max-width, min()
 * included (tested on a post, 2026-10-26). The user wants a log to look as
 * it does in the app.
 */
export function boardMaxWidth(shownWidth: number): string {
    return `min(100%, ${Math.round(shownWidth)}px)`
}

/** Pixel size an image of `naturalWidth`×`naturalHeight` goes into a copy at, shown in a box of `boxWidth`×`boxHeight` CSS px (unknown: only the edge cap). */
export function clipboardImageSize(naturalWidth: number, naturalHeight: number, boxWidth = 0, boxHeight = 0): { width: number; height: number } {
    let scale = 1
    // Enough to cover the box at twice its size whatever the fit (cover, contain, fill).
    if (boxWidth > 0 && boxHeight > 0) scale = Math.min(1, Math.max(boxWidth * CLIPBOARD_IMAGE_DENSITY / naturalWidth, boxHeight * CLIPBOARD_IMAGE_DENSITY / naturalHeight))
    scale = Math.min(scale, CLIPBOARD_IMAGE_MAX_EDGE / Math.max(naturalWidth, naturalHeight))
    return { width: Math.max(1, Math.round(naturalWidth * scale)), height: Math.max(1, Math.round(naturalHeight * scale)) }
}

/** An animated PNG (acTL) or WebP (ANIM) would lose its motion when redrawn. */
export function isAnimatedImageDataUrl(dataUrl: string): boolean {
    const match = /^data:image\/(png|webp);base64,/i.exec(dataUrl)
    if (!match) return false
    try {
        // 8192 base64 characters (a multiple of 4) decode on their own.
        const head = atob(dataUrl.slice(match[0].length, match[0].length + 8192))
        return match[1].toLowerCase() === 'png' ? head.includes('acTL') : head.includes('ANIM')
    } catch {
        return false
    }
}

/** A canvas as WebP, or PNG where the browser does not write WebP (it keeps transparency either way). */
function encodeClipboardCanvas(canvas: HTMLCanvasElement): string {
    const webp = canvas.toDataURL('image/webp', CLIPBOARD_WEBP_QUALITY)
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png')
}

/**
 * The embedded image `dataUrl` redrawn at clipboardImageSize as WebP, when
 * that is smaller. GIF, SVG and animated PNG/WebP stay as they are. Without
 * createImageBitmap (or on any failure) the image is left as it is.
 */
export async function shrinkClipboardImage(dataUrl: string, boxWidth = 0, boxHeight = 0): Promise<string> {
    if (!/^data:image\/(?:png|jpe?g|webp|bmp|avif)[;,]/i.test(dataUrl) || isAnimatedImageDataUrl(dataUrl)) return dataUrl
    if (typeof createImageBitmap !== 'function') return dataUrl
    try {
        const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
        try {
            const { width, height } = clipboardImageSize(bitmap.width, bitmap.height, boxWidth, boxHeight)
            const canvas = document.createElement('canvas')
            canvas.width = width
            canvas.height = height
            const context = canvas.getContext('2d')
            if (!context) return dataUrl
            context.imageSmoothingEnabled = true
            context.imageSmoothingQuality = 'high'
            context.drawImage(bitmap, 0, 0, width, height)
            const encoded = encodeClipboardCanvas(canvas)
            return encoded.length < dataUrl.length ? encoded : dataUrl
        } finally {
            bitmap.close()
        }
    } catch {
        return dataUrl
    }
}

/** A copy's size for the "copied" notice: KB under 1 MB, else MB with one decimal. */
/**
 * The post budget a copy is held to, and how much of it counts. Arca refuses
 * a post past its request limit with "request entity too large": measured
 * 2026-10-28 on a private channel with synthetic text, 512 KB of editor HTML
 * posted and 768 KB, 1 MB and 4 MB did not. A pasted data-URI <img> is
 * uploaded and replaced by an Arca address (about 150 bytes), and a CSS
 * background data URI is dropped at posting, so their bytes do not count.
 */
export const BOARD_POST_SAFE_BYTES = 450 * 1024
const BOARD_IMAGE_URL_BYTES = 150

/** Bytes of `html` that count toward a board's post size (images as their board address). */
export function boardPostBytes(html: string): number {
    const counted = html.replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, 'x'.repeat(BOARD_IMAGE_URL_BYTES))
    return new Blob([counted]).size
}

export function clipboardSizeLabel(bytes: number): string {
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`
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

/**
 * Whether two computed values draw the same. A border, outline or text
 * decoration that is not drawn (style none, or zero width as the app's
 * stylesheet leaves every border) still names a style and a color, which
 * differ from the browser default.
 */
function sameStyleValue(property: string, value: string, baseline: string): boolean {
    if (value === baseline) return true
    if (!/^(border-(top|right|bottom|left)|outline|text-decoration)$/.test(property)) return false
    const undrawn = (text: string) => /\bnone\b/.test(text) || /(^|\s)0px(\s|$)/.test(text)
    return undrawn(value) && undrawn(baseline)
}

/**
 * The style an element carries into the copy. `parent` is its parent's
 * computed style (null for the copied root) and `defaults` the browser's
 * default for its tag; without them every property goes out (pseudo-elements).
 */
export function portableStyle(style: CSSStyleDeclaration, parent?: CSSStyleDeclaration | null, defaults?: CSSStyleDeclaration | null): string {
    const result: string[] = []
    for (const property of PORTABLE_STYLE_PROPERTIES) {
        const value = style.getPropertyValue(property)
        if (!value) continue
        const important = style.getPropertyPriority(property)
        if (!important && !ALWAYS_STYLE_PROPERTIES.has(property)) {
            const baseline = INHERITED_STYLE_PROPERTIES.has(property) ? parent : defaults
            if (baseline && sameStyleValue(property, value, baseline.getPropertyValue(property))) continue
            // An origin is the element's own box in pixels and only matters
            // with a transform or perspective to apply it to.
            if (baseline && property === 'transform-origin' && style.getPropertyValue('transform') === 'none') continue
            if (baseline && property === 'perspective-origin' && style.getPropertyValue('perspective') === 'none') continue
            // Box sizing does nothing to a run of text.
            if (baseline && property === 'box-sizing' && style.getPropertyValue('display') === 'inline') continue
        }
        result.push(`${property}:${value}${important ? ' !important' : ''}`)
    }
    return result.join(';')
}

/**
 * Whether an element shows in the reply: displayed, not fixed to the screen,
 * and visible (a hidden box with something visible inside still counts).
 */
function shownInCopy(element: Element, computed: CSSStyleDeclaration): boolean {
    if (computed.display === 'none' || computed.position === 'fixed') return false
    if (computed.visibility === 'hidden' || computed.visibility === 'collapse') {
        return Array.from(element.querySelectorAll('*')).some((inner) => getComputedStyle(inner).visibility === 'visible')
    }
    return true
}

/**
 * The browser's own style for each tag, read in a blank frame so the app's
 * stylesheets (which reset margins, borders and box sizing) do not count as
 * defaults. Null where no frame can be made; then nothing is left out.
 */
function createDefaultStyles(doc: Document): { of: (element: Element) => CSSStyleDeclaration | null, dispose: () => void } {
    const none = { of: () => null, dispose: () => {} }
    const body = doc.body ?? doc.documentElement
    if (!body) return none
    let frame: HTMLIFrameElement
    try {
        frame = doc.createElement('iframe')
        frame.setAttribute('aria-hidden', 'true')
        frame.tabIndex = -1
        frame.style.cssText = 'position:absolute;left:-10000px;top:0;width:600px;height:200px;border:0;visibility:hidden;pointer-events:none'
        body.appendChild(frame)
    } catch {
        return none
    }
    const blank = frame.contentDocument
    const view = frame.contentWindow
    if (!blank || !view || !blank.body) {
        frame.remove()
        return none
    }
    const byTag = new Map<string, CSSStyleDeclaration | null>()
    return {
        of(element) {
            const key = `${element.namespaceURI ?? ''} ${element.localName}`
            if (byTag.has(key)) return byTag.get(key) ?? null
            let style: CSSStyleDeclaration | null = null
            try {
                const probe = element.namespaceURI ? blank.createElementNS(element.namespaceURI, element.localName) : blank.createElement(element.localName)
                const host = element.namespaceURI === 'http://www.w3.org/2000/svg' && element.localName !== 'svg'
                    ? blank.body.appendChild(blank.createElementNS('http://www.w3.org/2000/svg', 'svg'))
                    : blank.body
                host.appendChild(probe)
                style = view.getComputedStyle(probe)
                // An empty answer (no layout here) would leave everything out.
                if (!style.getPropertyValue('display')) style = null
            } catch {
                style = null
            }
            byTag.set(key, style)
            return style
        },
        dispose() { frame.remove() },
    }
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
    // A run of text (display: inline) takes no size of its own and wraps as
    // its block does, so it needs none of this (and the copy stays smaller).
    if (!isMedia && !isOutOfFlow && !mediaFrame && !positionedCanvas && computed.display !== 'inline') {
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

export function coverImagePlacement(sourceWidth: number, sourceHeight: number, boxWidth: number, boxHeight: number, objectPosition: string, fit: 'cover' | 'contain' = 'cover'): { x: number; y: number; width: number; height: number } {
    const scale = (fit === 'cover' ? Math.max : Math.min)(boxWidth / sourceWidth, boxHeight / sourceHeight)
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

export async function rasterizeCoverImage(url: string, width: number, height: number, position: string): Promise<string> {
    const image = await loadClipboardImage(url)
    const [canvas, context] = clipboardCanvas(width, height)
    const placement = coverImagePlacement(image.naturalWidth, image.naturalHeight, width, height, position)
    context.drawImage(image, placement.x, placement.y, placement.width, placement.height)
    return encodeClipboardCanvas(canvas)
}

async function rasterizeBackgroundPicture(url: string, width: number, height: number, fit: 'cover' | 'contain', position: string): Promise<string> {
    const image = await loadClipboardImage(url)
    const [canvas, context] = clipboardCanvas(width, height)
    const placement = coverImagePlacement(image.naturalWidth, image.naturalHeight, width, height, position, fit)
    context.drawImage(image, placement.x, placement.y, placement.width, placement.height)
    return encodeClipboardCanvas(canvas)
}

// A board like Arca drops CSS background images when a post is saved, while
// it keeps an <img> and uploads it on paste. A reply's scene pictures drawn
// as the cover background of an empty box were gone from the post, the
// portrait (an <img>) was not (the user's Arca test, 2026-10-24). Such a box
// goes out as an <img> of the picture as it is shown: one url() layer, sized
// cover (or contain without repeat), on a box with no text or children.
const BACKGROUND_STYLE_PROPERTIES = [
    'background-image', 'background-size', 'background-position', 'background-repeat', 'background-clip',
] as const

export function backgroundPictureOf(source: Element, computed: CSSStyleDeclaration, hasText: boolean, hasPseudo: boolean): { url: string; fit: 'cover' | 'contain'; position: string } | null {
    if (hasText || hasPseudo || Array.from(source.children).some(child => child.tagName !== 'BR')) return null
    const urls = extractCssUrls(computed.backgroundImage)
    if (urls.length !== 1 || !/^\s*url\([^)]*\)\s*$/i.test(computed.backgroundImage)) return null
    const size = computed.backgroundSize.trim()
    if (size !== 'cover' && !(size === 'contain' && computed.backgroundRepeat.trim() === 'no-repeat')) return null
    return { url: urls[0], fit: size, position: computed.backgroundPosition || 'center' }
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
    return encodeClipboardCanvas(canvas)
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
 * Post editors drop form controls on paste, so the buttons a character card
 * draws (risu-btn menus, status-window tabs) vanished from pasted logs. Each
 * becomes a span with the same snapshot style and its visible text.
 */
export function replaceFormControls(root: HTMLElement): void {
    for (const control of Array.from(root.querySelectorAll<HTMLElement>('button, input, select, textarea'))) {
        if (control instanceof HTMLInputElement && /^(hidden|checkbox|radio|file|range|color)$/i.test(control.type)) {
            if (control.type.toLowerCase() === 'hidden') control.remove()
            continue
        }
        const span = control.ownerDocument.createElement('span')
        span.setAttribute('style', control.getAttribute('style') ?? '')
        if (!span.style.display || span.style.display === 'inline') span.style.display = 'inline-block'
        if (control instanceof HTMLButtonElement) {
            while (control.firstChild) span.appendChild(control.firstChild)
        } else if (control instanceof HTMLSelectElement) {
            span.textContent = control.selectedOptions[0]?.textContent ?? ''
        } else if (control instanceof HTMLTextAreaElement) {
            span.textContent = control.value
            span.style.whiteSpace = 'pre-wrap'
        } else if (control instanceof HTMLInputElement) {
            span.textContent = control.value || control.placeholder || ''
        }
        control.replaceWith(span)
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
        rasterizeBackground?: (url: string, width: number, height: number, fit: 'cover' | 'contain', position: string) => Promise<string>
        shrinkImage?: (dataUrl: string, boxWidth: number, boxHeight: number) => Promise<string>
        /** The browser's default style for an element's tag (createDefaultStyles). */
        getDefaultStyle?: (element: Element) => CSSStyleDeclaration | null
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
    // One shrunk copy per image and shown size (to 8 px), shared by every
    // element that draws it at that size.
    const shrink = options.shrinkImage ?? shrinkClipboardImage
    const shrunk = new Map<string, Promise<string>>()
    const toShownDataUrl = (url: string, width: number, height: number) => {
        const key = `${url}\u0000${Math.ceil(width / 8)}x${Math.ceil(height / 8)}`
        let pending = shrunk.get(key)
        if (!pending) {
            pending = toDataUrl(url).then((embedded) => shrink(embedded, width, height))
            shrunk.set(key, pending)
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
    const defaultStyles = options.getDefaultStyle ? { of: options.getDefaultStyle, dispose: () => {} } : createDefaultStyles(sourceRoot.ownerDocument)
    const computedOf = new Map<Element, CSSStyleDeclaration>()
    const styleOf = (element: Element) => {
        let style = computedOf.get(element)
        if (!style) {
            style = getComputedStyle(element)
            computedOf.set(element, style)
        }
        return style
    }
    // Only what the reply shows goes into the copy (the user's report,
    // 2026-10-28): a bot's closed button panels and its fixed 도감 popup and
    // launcher came into the log broken, since a board drops display:none and
    // position. Left out: what is not displayed or not visible, the body of a
    // closed <details> or a content-visibility: hidden box, and anything fixed
    // to the screen (floating launchers and overlays, open or not, are not
    // part of the reply).
    const hidden = new Set<Element>()
    const hiddenClones: Element[] = []
    for (let index = 0; index < Math.min(sources.length, clones.length); index++) {
        const source = sources[index]
        const clone = clones[index]
        if (!(source instanceof HTMLElement || source instanceof SVGElement) || !(clone instanceof HTMLElement || clone instanceof SVGElement)) continue

        if (index > 0 && (hidden.has(source) || (!!source.parentElement && hidden.has(source.parentElement)))) {
            hidden.add(source)
            hiddenClones.push(clone)
            continue
        }
        const computed = styleOf(source)
        if (index > 0 && !shownInCopy(source, computed)) {
            hidden.add(source)
            hiddenClones.push(clone)
            continue
        }
        const closedDetails = source instanceof HTMLDetailsElement && !source.open
        if (closedDetails || computed.getPropertyValue('content-visibility') === 'hidden') {
            const summary = closedDetails ? source.querySelector(':scope > summary') : null
            for (const child of Array.from(source.children)) if (child !== summary) hidden.add(child)
            for (const node of Array.from(clone.childNodes)) if (node.nodeType === Node.TEXT_NODE) node.remove()
        }
        const parent = index > 0 && source.parentElement ? styleOf(source.parentElement) : null
        const flattened = portableStyle(computed, parent, defaultStyles.of(source))
        if (flattened) clone.setAttribute('style', flattened)

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
                        if (pseudoBackground && pseudoBackground !== 'none') decoration.style.backgroundImage = await inlineCssUrls(pseudoBackground, (url) => toShownDataUrl(url, 0, 0))
                        if (pseudoSource && decoration instanceof HTMLImageElement) {
                            try { decoration.src = await toShownDataUrl(pseudoSource, 0, 0) } catch { /* keep link */ }
                        }
                    })
                } catch { /* DOM adapters or older engines may not expose pseudo styles. */ }
            }
        }
        if (source instanceof HTMLElement && clone instanceof HTMLElement) {
            preservePortableLayout(source, clone, computed, !!textContentFlags.get(source), hasPseudo)
        }

        const background = computed.backgroundImage
        if (background && background !== 'none') {
            const box = source.getBoundingClientRect()
            const picture = clone !== cloneRoot && clone instanceof HTMLElement && box.width > 0 && box.height > 0
                ? backgroundPictureOf(source, computed, !!textContentFlags.get(source), hasPseudo)
                : null
            assetTasks.push(async () => {
                if (picture) {
                    try {
                        const embedded = await toDataUrl(picture.url)
                        if (!/^data:image\/(?:gif|svg\+xml)/i.test(embedded) && !isAnimatedImageDataUrl(embedded)) {
                            const image = clone.ownerDocument.createElement('img')
                            image.src = await (options.rasterizeBackground ?? rasterizeBackgroundPicture)(embedded, box.width, box.height, picture.fit, picture.position)
                            image.setAttribute('style', clone.getAttribute('style') ?? '')
                            for (const property of BACKGROUND_STYLE_PROPERTIES) image.style.removeProperty(property)
                            image.style.width = `${box.width}px`
                            image.style.maxWidth = boardMaxWidth(box.width)
                            image.style.setProperty('height', 'auto', 'important')
                            image.style.setProperty('aspect-ratio', `${box.width} / ${box.height}`, 'important')
                            // The box's overflow: visible would let the picture spill past its rounded corners.
                            image.style.overflow = 'hidden'
                            // A centered box's auto margins resolve to the old chat width's pixels.
                            if (computed.marginLeft === computed.marginRight && parseFloat(computed.marginLeft) > 0) {
                                image.style.marginLeft = 'auto'
                                image.style.marginRight = 'auto'
                            }
                            clone.replaceWith(image)
                            return
                        }
                    } catch { /* falls back to the background below */ }
                }
                clone.style.backgroundImage = await inlineCssUrls(background, (url) => toShownDataUrl(url, box.width, box.height))
            })
        }

        if (source instanceof HTMLDetailsElement && clone instanceof HTMLDetailsElement) {
            clone.open = source.open
        }

        // Capture the URL before a concurrent viewport update can release it.
        const imageUrl = source instanceof HTMLImageElement ? source.currentSrc || source.getAttribute('src') : null
        const imageBox = source instanceof HTMLImageElement ? source.getBoundingClientRect() : null
        // An asset name no module has (an empty src) or a picture that failed
        // to load: nothing in the chat, and on a board a broken link back to
        // this app.
        const brokenImage = source instanceof HTMLImageElement && source.complete && source.naturalWidth === 0 && source.naturalHeight === 0
            && !/\.svg(?:[?#]|$)|^data:image\/svg/i.test(imageUrl ?? '')
        assetTasks.push(async () => {
            if (brokenImage) {
                clone.remove()
                return
            }
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
                        } catch { clone.src = await toShownDataUrl(imageUrl, imageBox.width, imageBox.height) }
                    } else {
                        clone.src = await toShownDataUrl(imageUrl, imageBox?.width ?? 0, imageBox?.height ?? 0)
                    }
                } catch { clone.src = imageUrl }
                if (imageBox && imageBox.width > 0) clone.style.maxWidth = boardMaxWidth(imageBox.width)
                clone.removeAttribute('srcset')
                clone.removeAttribute('loading')
            } else {
                await embedElementAssets(source, clone, toDataUrl)
            }
        })
    }
    // Every style is read; the default probes are no longer needed.
    defaultStyles.dispose()
    for (const clone of hiddenClones) clone.remove()

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
            image.style.maxWidth = boardMaxWidth(box.width)
            clone.replaceWith(image)
        } catch { /* preserve SVG markup if the browser cannot rasterize it */ }
    }
    cloneRoot.querySelectorAll('script, style, link, [data-risu-copy-ignore]').forEach((node) => node.remove())
    replaceFormControls(cloneRoot)
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
    const holder = cloneRoot.ownerDocument.createElement('div')
    holder.append(cloneRoot)
    boardSafeTags(holder)
    return holder.innerHTML
}

// Tags a board like Arca keeps: every tag found in 45 of its stored chat-log
// posts (2026-10-10). Any other tag is unwrapped there and its style goes
// with it: a dialogue quote (<mark risu-mark="quote2">) lost its color and
// showed in the paragraph's white. Such an element goes out as a span or a
// div carrying the same inline style.
const BOARD_SAFE_TAGS = new Set([
    'A', 'B', 'BR', 'DETAILS', 'DIV', 'EM', 'FIGCAPTION', 'FIGURE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'IFRAME', 'IMG', 'LI', 'OL', 'P', 'PRE',
    'S', 'SPAN', 'STRONG', 'SUMMARY', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TD', 'TH', 'TR', 'UL',
    'VIDEO', 'SOURCE',
])
const BLOCK_TAGS = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|CENTER|DD|DL|DT|FIELDSET|FOOTER|FORM|HEADER|MAIN|NAV|SECTION)$/

/**
 * Renames, inside `root`, every element a board would unwrap (see
 * BOARD_SAFE_TAGS) to a span, or a div when it lays out as a block, keeping
 * its inline style and children. SVG is left alone (rasterized elsewhere).
 */
export function boardSafeTags(root: Element): void {
    for (const element of Array.from(root.querySelectorAll('*'))) {
        if (BOARD_SAFE_TAGS.has(element.tagName) || element.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue
        const display = (element as HTMLElement).style?.display ?? ''
        const block = display ? /^(block|flex|grid|list-item|table|flow-root)/.test(display) : BLOCK_TAGS.test(element.tagName)
        const replacement = element.ownerDocument.createElement(block ? 'div' : 'span')
        const style = element.getAttribute('style')
        if (style) replacement.setAttribute('style', style)
        replacement.append(...Array.from(element.childNodes))
        element.replaceWith(replacement)
    }
}

// Arca keeps an inline declaration only when its property is on a list:
// flex-direction, flex-wrap, justify-content, align-items, align-content,
// align-self, order and gap stay, but the shorthands the CSSOM writes them
// as (flex-flow, place-content, place-items, place-self) are dropped whole
// (probed on a post, 2026-10-27). A column of assets then pasted as one row
// that does not wrap, and the pictures ran over each other (the user's
// report). So the copy carries the longhands.
const BOARD_PLACE_LONGHANDS: Record<string, readonly [string, string]> = {
    'place-content': ['align-content', 'justify-content'],
    'place-items': ['align-items', 'justify-items'],
    'place-self': ['align-self', 'justify-self'],
}

/** The longhands of a flex or alignment shorthand a board drops, or null for any other property. */
export function boardLonghands(property: string, value: string): Array<[string, string]> | null {
    const important = /!important\s*$/i.test(value) ? ' !important' : ''
    const tokens = value.replace(/\s*!important\s*$/i, '').trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return null
    const wide = tokens.length === 1 && /^(inherit|initial|unset|revert|revert-layer)$/i.test(tokens[0]) ? tokens[0] : ''
    if (property === 'flex-flow') {
        const direction = wide || tokens.find((token) => /^(row|row-reverse|column|column-reverse)$/i.test(token)) || 'row'
        const wrap = wide || tokens.find((token) => /^(nowrap|wrap|wrap-reverse)$/i.test(token)) || 'nowrap'
        return [['flex-direction', direction + important], ['flex-wrap', wrap + important]]
    }
    const pair = BOARD_PLACE_LONGHANDS[property]
    if (!pair) return null
    // A keyword prefix belongs to its value: "safe center", "first baseline".
    const values: string[] = []
    for (let index = 0; index < tokens.length; index++) {
        const prefixed = /^(safe|unsafe|first|last|legacy)$/i.test(tokens[index]) && index + 1 < tokens.length
        values.push(prefixed ? `${tokens[index]} ${tokens[++index]}` : tokens[index])
    }
    return [[pair[0], values[0] + important], [pair[1], (values[1] ?? values[0]) + important]]
}

/** Declarations of a style attribute, split on the semicolons outside url(), quotes and brackets. */
function styleDeclarations(text: string): string[] {
    const declarations: string[] = []
    let depth = 0
    let quote = ''
    let start = 0
    for (let index = 0; index < text.length; index++) {
        const char = text[index]
        if (quote) {
            if (char === quote && text[index - 1] !== '\\') quote = ''
        } else if (char === '"' || char === "'") {
            quote = char
        } else if (char === '(') {
            depth++
        } else if (char === ')') {
            depth = Math.max(0, depth - 1)
        } else if (char === ';' && depth === 0) {
            declarations.push(text.slice(start, index))
            start = index + 1
        }
    }
    declarations.push(text.slice(start))
    return declarations.map((declaration) => declaration.trim()).filter(Boolean)
}

/**
 * Rewrites, inside `root`, each style attribute in the declarations a board
 * keeps: the flex and alignment shorthands as their longhands, and
 * text-align start/end as left/right (Arca drops "start", and the element
 * then took its parent's center). Run it last: any later write through
 * element.style folds the longhands back into shorthands.
 */
export function boardSafeStyles(root: Element): void {
    for (const element of [root, ...Array.from(root.querySelectorAll('[style]'))]) {
        const text = element.getAttribute('style')
        if (!text) continue
        let changed = false
        const declarations: string[] = []
        for (const declaration of styleDeclarations(text)) {
            const colon = declaration.indexOf(':')
            const property = colon > 0 ? declaration.slice(0, colon).trim().toLowerCase() : ''
            const value = declaration.slice(colon + 1).trim()
            const longhands = boardLonghands(property, value)
            if (longhands) {
                changed = true
                for (const [longhand, longhandValue] of longhands) declarations.push(`${longhand}:${longhandValue}`)
                continue
            }
            if (property === 'text-align') {
                const mapped = value.replace(/^(start|end)\b/i, (side) => side.toLowerCase() === 'start' ? 'left' : 'right')
                if (mapped !== value) {
                    changed = true
                    declarations.push(`text-align:${mapped}`)
                    continue
                }
            }
            declarations.push(declaration)
        }
        if (changed) element.setAttribute('style', declarations.join(';'))
    }
}

/**
 * Opaque rgb() colors as #rrggbb, the form stock copies carry and boards like
 * Arca are known to keep (the CSSOM writes every color it sets as rgb()).
 */
export function hexColors(html: string): string {
    const hex = (n: string) => Math.min(255, Number(n)).toString(16).padStart(2, '0')
    // Inside style attributes only: the message text itself stays as written.
    return html.replace(/style="[^"]*"/g, (attribute) => attribute.replace(
        /rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/g,
        (_, r, g, b) => `#${hex(r)}${hex(g)}${hex(b)}`,
    ))
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

    // Not laid out: only the edge cap applies (see shrinkClipboardImage).
    const shrunk = new Map<string, Promise<string>>()
    const toSmallDataUrl = (url: string) => {
        let pending = shrunk.get(url)
        if (!pending) {
            pending = toDataUrl(url).then((embedded) => shrinkClipboardImage(embedded))
            shrunk.set(url, pending)
        }
        return pending
    }
    for (const image of Array.from(root.querySelectorAll('img'))) {
        const url = image.getAttribute('src') ?? ''
        if (!url) continue
        try {
            image.src = await toSmallDataUrl(url)
            image.removeAttribute('srcset')
        } catch { /* preserve source URL */ }
    }
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('[style*="background"]'))) {
        if (!element.style.backgroundImage) continue
        element.style.backgroundImage = await inlineCssUrls(element.style.backgroundImage, toSmallDataUrl)
    }
}
