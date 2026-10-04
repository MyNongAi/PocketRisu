// Renders a range of the open chat as PNG images for sharing (the ✂️ log
// capture, logCaptureState.svelte.ts). The messages are mounted again in a
// hidden box at the chosen width, with every asset resolved: the live list
// leaves images of messages far from the screen unloaded, and its width is
// the phone's. Buttons, the input echo and other controls are hidden; each
// block is drawn with html-to-image (in tiles of LOG_IMAGE_MAX_HEIGHT) and
// the blocks are stacked into images as tall as this browser lets a canvas
// be (tallestLogImageHeight), cut between messages where possible.

import { mount, unmount } from 'svelte'
import type { Message } from '../storage/database.svelte'
import Chat from 'src/lib/ChatScreens/Chat.svelte'
import { getCharImage } from '../characters'
import { createSimpleCharacter, DBState, selIdState } from '../stores.svelte'
import { getFirstMessageAtIndex } from '../firstMessage'
import { resolveAllInlayPlaceholders } from '../parser/parser.svelte'
import { language } from 'src/lang'
import {
    blockSliceInPart,
    clampLogImageScale,
    clampLogImageWidth,
    findLogCutRow,
    formatLogRange,
    LOG_IMAGE_MAX_HEIGHT,
    nextLogPartEnd,
    pickLogImageHeight,
    type LogBlock,
} from './logCapture'

// Measured once per width: a canvas that size really holds pixels (one over
// the browser's limit gets no context, or reads back blank).
const imageHeightByWidth = new Map<number, number>()
function tallestLogImageHeight(width: number): number {
    const known = imageHeightByWidth.get(width)
    if (known) return known
    const height = pickLogImageHeight(width, (w, h) => {
        const canvas = document.createElement('canvas')
        try {
            canvas.width = w
            canvas.height = h
            const context = canvas.getContext('2d')
            if (!context) return false
            context.fillStyle = '#fff'
            context.fillRect(w - 1, h - 1, 1, 1)
            return context.getImageData(w - 1, h - 1, 1, 1).data[3] === 255
        } catch {
            return false
        } finally {
            canvas.width = 0
            canvas.height = 0
        }
    })
    imageHeightByWidth.set(width, height)
    return height
}

export type LogCaptureStage = 'render' | 'images' | 'draw'

export interface RenderedLogImage {
    blob: Blob
    width: number
    height: number
}

export interface RenderLogOptions {
    from: number
    to: number
    signal: AbortSignal
    onProgress?: (stage: LogCaptureStage, done: number, total: number) => void
}

const STYLE_ID = 'log-capture-style'
const BODY_RENDER_TIMEOUT_MS = 15000
const IMAGE_LOAD_TIMEOUT_MS = 20000
// How far up a cut through a message may move to find a blank row.
const CUT_SEARCH_ROWS = 400
// 1x1 transparent PNG for images that cannot be fetched (cross-origin, gone).
const TRANSPARENT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

// Inside the capture box only: controls hidden, the dashed range box off, and
// the message cards stretched edge to edge (no centred column, small padding)
// so the text fills the image.
const CAPTURE_CSS = `
.log-capture-root { --no-chat-max-width: 100%; }
.log-capture-root .risu-chat[data-log-mark]::after { display: none !important; }
.log-capture-root .risu-chat { margin: 0 !important; }
.log-capture-root .risu-chat > div {
    margin-left: 0 !important; margin-right: 0 !important;
    padding: 5px 8px !important;
}
.log-capture-root .risu-chat > div > div.mx-auto {
    max-width: none !important;
    margin-left: 0 !important; margin-right: 0 !important;
    padding: 14px 14px 10px !important;
    border-radius: 8px !important;
}
.log-capture-root [data-log-skip],
.log-capture-root .input-echo,
.log-capture-root button[class*="button-icon-"] { display: none !important; }
.log-capture-root.log-capture-no-avatar [data-log-avatar] { display: none !important; }
.log-capture-root *, .log-capture-root *::before, .log-capture-root *::after {
    animation: none !important;
    transition: none !important;
}
`

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function isTransparent(color: string): boolean {
    return !color || color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color.replace(/\s+/g, ' '))
}

/** The colour behind the live chat: the first painted background from the chat screen up. */
function chatBackgroundColor(screen: Element | null): string {
    for (let el: Element | null = screen; el; el = el.parentElement) {
        const color = getComputedStyle(el).backgroundColor
        if (!isTransparent(color)) return color
    }
    const body = getComputedStyle(document.body).backgroundColor
    return isTransparent(body) ? '#1e1e1e' : body
}

function ensureCaptureStyle() {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CAPTURE_CSS
    document.head.appendChild(style)
}

function personaFor(chatBindedPersona: string | undefined) {
    const db = DBState.db
    if (chatBindedPersona) {
        const persona = db.personas.find((p) => p.id === chatBindedPersona)
        if (persona) return { name: persona.name, icon: persona.icon, largePortrait: persona.largePortrait }
    }
    const persona = db.personas[db.selectedPersona]
    return { name: db.username, icon: persona?.icon ?? '', largePortrait: persona?.largePortrait }
}

function rangeLabel(from: number, to: number): string {
    return formatLogRange(from, to, { greeting: language.logCapture.greeting, range: language.logCapture.rangeLabel, single: language.logCapture.singleLabel })
}

async function buildHeader(characterName: string, image: string, chatName: string, from: number, to: number): Promise<HTMLElement> {
    const header = document.createElement('div')
    header.className = 'log-capture-block'
    header.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;padding:22px 12px 16px;margin:0 8px 4px;border-bottom:1px solid var(--risu-theme-darkborderc);text-align:center;'
    const src = image ? await getCharImage(image, 'plain') : null
    if (src && src !== '/none.webp') {
        const avatar = document.createElement('img')
        avatar.src = src
        avatar.alt = ''
        avatar.setAttribute('data-log-avatar', '')
        avatar.style.cssText = 'width:88px;height:88px;border-radius:9999px;object-fit:cover;'
        header.appendChild(avatar)
    }
    const name = document.createElement('div')
    name.textContent = characterName
    name.style.cssText = 'font-size:22px;font-weight:700;color:var(--risu-theme-textcolor);'
    header.appendChild(name)
    const sub = document.createElement('div')
    sub.textContent = `${chatName} (${rangeLabel(from, to)})`
    sub.style.cssText = 'font-size:15px;color:var(--risu-theme-textcolor2);'
    header.appendChild(sub)
    return header
}

async function waitForImages(root: HTMLElement, signal: AbortSignal) {
    const deadline = Date.now() + IMAGE_LOAD_TIMEOUT_MS
    while (Date.now() < deadline) {
        throwIfAborted(signal)
        let pending = 0
        for (const img of Array.from(root.querySelectorAll('img'))) {
            // Off-screen lazy images never load on their own.
            if (img.loading === 'lazy') img.loading = 'eager'
            if (!img.complete) pending++
        }
        if (pending === 0 && root.querySelectorAll('[data-inlay-id]').length === 0) return
        await wait(120)
    }
}

/**
 * Renders messages `from`..`to` of the open chat (-1 is the greeting) and
 * returns them as PNG images, top to bottom.
 */
export async function renderLogImages(options: RenderLogOptions): Promise<RenderedLogImage[]> {
    const { from, to, signal, onProgress } = options
    const db = DBState.db
    const character = db.characters[selIdState.selId]
    const chat = character?.chats?.[character.chatPage]
    if (!character || !chat) throw new Error(language.logCapture.noChat)
    const messages: Message[] = chat.message ?? []
    // Laid out at width / scale and drawn at scale: text larger in the same image width.
    const scale = clampLogImageScale(db.nodeOnlyLogImageTextScale) / 100
    const layoutWidth = Math.round(clampLogImageWidth(db.nodeOnlyLogImageWidth) / scale)
    const width = Math.round(layoutWidth * scale)
    const tileHeight = Math.floor(LOG_IMAGE_MAX_HEIGHT / scale)
    const persona = personaFor(chat.bindedPersona)
    const simpleChar = createSimpleCharacter(character)
    const liveScreen = document.querySelector('.default-chat-screen')
    const background = chatBackgroundColor(liveScreen)

    ensureCaptureStyle()
    const root = document.createElement('div')
    // The live screen's theme classes (not the class itself, which code looks up).
    for (const cls of Array.from(liveScreen?.classList ?? [])) {
        if (cls !== 'default-chat-screen') root.classList.add(cls)
    }
    root.classList.add('log-capture-root')
    if (db.nodeOnlyLogImageAvatars === false) root.classList.add('log-capture-no-avatar')
    root.setAttribute('aria-hidden', 'true')
    root.style.cssText = `position:fixed;left:-100000px;top:0;width:${layoutWidth}px;height:auto;max-height:none;overflow:visible;display:block;transform:none;margin:0;padding:0 0 8px;pointer-events:none;z-index:-1;background-color:${background};color:var(--risu-theme-textcolor);`
    document.body.appendChild(root)

    const instances: Record<string, unknown>[] = []
    try {
        if (db.nodeOnlyLogImageHeader !== false) {
            root.appendChild(await buildHeader(character.name, character.image ?? '', chat.name ?? '', from, to))
        }

        const indices: number[] = []
        for (let i = Math.max(-1, from); i <= Math.min(to, messages.length - 1); i++) {
            if (i < 0) {
                if (getFirstMessageAtIndex(character, chat.fmIndex ?? -1)) indices.push(i)
                continue
            }
            if (!messages[i] || messages[i].isComment) continue
            indices.push(i)
        }
        if (indices.length === 0) throw new Error(language.logCapture.empty)

        let rendered = 0
        let resolveAll: () => void = () => {}
        const allRendered = new Promise<void>((resolve) => { resolveAll = resolve })
        const seen = new Set<number>()
        const markRendered = (index: number) => {
            if (seen.has(index)) return
            seen.add(index)
            rendered++
            onProgress?.('render', rendered, indices.length)
            if (rendered >= indices.length) resolveAll()
        }
        onProgress?.('render', 0, indices.length)

        for (const index of indices) {
            const block = document.createElement('div')
            block.className = 'log-capture-block'
            const container = document.createElement('div')
            container.className = 'chat-message-container'
            block.appendChild(container)
            root.appendChild(block)
            const onBodyRendered = () => markRendered(index)
            if (index < 0) {
                instances.push(mount(Chat, {
                    target: container,
                    props: {
                        character: simpleChar,
                        name: character.name,
                        message: getFirstMessageAtIndex(character, chat.fmIndex ?? -1),
                        role: 'char',
                        img: getCharImage(character.image, 'css'),
                        resolveChatAssets: true,
                        resolveSenderIcon: true,
                        allowViewportAssetActivation: false,
                        idx: -1,
                        altGreeting: true,
                        largePortrait: character.largePortrait,
                        firstMessage: true,
                        isLastMemory: false,
                        onBodyRendered,
                    },
                }))
                continue
            }
            const message = messages[index]
            const isUser = message.role === 'user'
            instances.push(mount(Chat, {
                target: container,
                props: {
                    message: message.data,
                    isLastMemory: false,
                    idx: index,
                    totalLength: messages.length,
                    img: getCharImage(isUser ? persona.icon : character.image, 'css'),
                    character: simpleChar,
                    largePortrait: isUser ? (persona.largePortrait ?? false) : (character.largePortrait ?? false),
                    messageGenerationInfo: message.generationInfo,
                    role: message.role,
                    name: isUser ? persona.name : character.name,
                    resolveChatAssets: true,
                    resolveSenderIcon: true,
                    allowViewportAssetActivation: false,
                    onBodyRendered,
                },
            }))
        }

        const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        await Promise.race([allRendered, wait(BODY_RENDER_TIMEOUT_MS), aborted])
        throwIfAborted(signal)

        onProgress?.('images', 0, 1)
        resolveAllInlayPlaceholders(root)
        await waitForImages(root, signal)
        await nextFrame()
        await nextFrame()
        throwIfAborted(signal)

        const blockElements = Array.from(root.querySelectorAll<HTMLElement>(':scope > .log-capture-block'))
        const rootRect = root.getBoundingClientRect()
        const blocks = blockElements.map((el) => {
            const rect = el.getBoundingClientRect()
            return { el, left: Math.round(rect.left - rootRect.left), width: Math.ceil(rect.width), top: Math.round(rect.top - rootRect.top), height: Math.ceil(rect.height) }
        }).filter((block) => block.height > 0)
        const totalHeight = Math.ceil(root.scrollHeight)

        const htmlToImage = await import('html-to-image')
        let fontEmbedCSS: string | undefined
        try {
            fontEmbedCSS = await htmlToImage.getFontEmbedCSS(root)
        } catch {
            fontEmbedCSS = undefined
        }
        throwIfAborted(signal)

        // A block is drawn in tiles no taller than html-to-image draws unsqueezed.
        const tileCache = new Map<string, HTMLCanvasElement>()
        const drawTile = async (block: typeof blocks[number], offset: number) => {
            const key = `${block.top}:${offset}`
            const cached = tileCache.get(key)
            if (cached) return cached
            const height = Math.min(tileHeight, block.height - offset)
            const canvas = await htmlToImage.toCanvas(block.el, {
                width: block.width,
                height,
                canvasWidth: block.width,
                canvasHeight: height,
                pixelRatio: scale,
                skipAutoScale: true,
                backgroundColor: background,
                fontEmbedCSS,
                skipFonts: fontEmbedCSS === undefined,
                imagePlaceholder: TRANSPARENT_PNG,
                style: offset > 0 ? { transform: `translateY(-${offset}px)`, margin: '0' } : { margin: '0' },
            })
            tileCache.set(key, canvas)
            return canvas
        }

        const drawTotal = blocks.reduce((sum, block) => sum + Math.ceil(block.height / tileHeight), 0)
        // Images up to `maxPartHeight` CSS px tall. Null when an image taller
        // than a tile could not be made after all (the browser ran out of
        // canvas memory); the caller then draws again at the tile height.
        const drawImages = async (maxPartHeight: number): Promise<RenderedLogImage[] | null> => {
            const canRetry = maxPartHeight > tileHeight
            const images: RenderedLogImage[] = []
            let drawn = 0
            const drawnTiles = new Set<string>()
            onProgress?.('draw', 0, drawTotal)
            let start = 0
            while (start < totalHeight) {
                throwIfAborted(signal)
                const { end, atBoundary } = nextLogPartEnd(blocks as LogBlock[], start, totalHeight, maxPartHeight)
                const part = { top: start, height: end - start }
                const partPixels = Math.round(part.height * scale)
                let canvas = document.createElement('canvas')
                canvas.width = width
                canvas.height = partPixels
                let context = canvas.getContext('2d')
                if (!context) {
                    if (canRetry) return null
                    throw new Error(language.logCapture.canvasFailed)
                }
                context.fillStyle = background
                context.fillRect(0, 0, canvas.width, canvas.height)
                for (const block of blocks) {
                    const slice = blockSliceInPart(block, part)
                    if (!slice) continue
                    // Tiles of this block that the slice touches.
                    for (let offset = Math.floor(slice.sourceY / tileHeight) * tileHeight; offset < slice.sourceY + slice.height; offset += tileHeight) {
                        const tile = await drawTile(block, offset)
                        throwIfAborted(signal)
                        const key = `${block.top}:${offset}`
                        if (!drawnTiles.has(key)) {
                            drawnTiles.add(key)
                            drawn++
                            onProgress?.('draw', drawn, drawTotal)
                        }
                        // CSS px; the tile and the image are `scale` times larger.
                        const top = Math.max(slice.sourceY, offset)
                        const bottom = Math.min(slice.sourceY + slice.height, offset + tile.height / scale)
                        if (bottom <= top) continue
                        context.drawImage(
                            tile,
                            0, (top - offset) * scale, tile.width, (bottom - top) * scale,
                            block.left * scale, (slice.targetY + (top - slice.sourceY)) * scale, tile.width, (bottom - top) * scale,
                        )
                    }
                }
                // A cut through a message moves up to a blank row between lines.
                let keep = part.height
                if (!atBoundary) {
                    const span = Math.min(Math.round(CUT_SEARCH_ROWS * scale), Math.floor(partPixels * 0.25))
                    if (span > 2) {
                        const data = context.getImageData(0, partPixels - span, canvas.width, span)
                        const row = findLogCutRow(new Uint32Array(data.data.buffer), canvas.width, span)
                        if (row !== null) keep = Math.max(1, Math.floor((partPixels - span + row) / scale))
                    }
                }
                if (keep < part.height) {
                    const trimmed = document.createElement('canvas')
                    trimmed.width = width
                    trimmed.height = Math.round(keep * scale)
                    const trimmedContext = trimmed.getContext('2d')
                    if (!trimmedContext) throw new Error(language.logCapture.canvasFailed)
                    trimmedContext.drawImage(canvas, 0, 0)
                    canvas.width = 0
                    canvas.height = 0
                    canvas = trimmed
                    context = trimmedContext
                }
                const partEnd = start + keep
                // Free tiles that end inside this image.
                for (const [key, tile] of tileCache) {
                    const [blockTop, offset] = key.split(':').map(Number)
                    if (blockTop + offset + tile.height / scale <= partEnd) {
                        tile.width = 0
                        tile.height = 0
                        tileCache.delete(key)
                    }
                }
                const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
                const size = { width: canvas.width, height: canvas.height }
                canvas.width = 0
                canvas.height = 0
                if (!blob) {
                    if (canRetry) return null
                    throw new Error(language.logCapture.canvasFailed)
                }
                images.push({ blob, ...size })
                start = partEnd
            }
            return images
        }

        // One image holds as much as this browser lets a canvas be, so a log
        // that fits is one copy; only a longer one is cut into several.
        const images = await drawImages(Math.floor(tallestLogImageHeight(width) / scale)) ?? await drawImages(tileHeight)
        if (!images) throw new Error(language.logCapture.canvasFailed)
        for (const tile of tileCache.values()) {
            tile.width = 0
            tile.height = 0
        }
        return images
    } finally {
        for (const instance of instances) {
            try { unmount(instance) } catch { /* already gone */ }
        }
        root.remove()
    }
}
