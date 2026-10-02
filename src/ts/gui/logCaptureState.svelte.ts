// ✂️ log capture: the first ✂️ marks where the log starts, the second (on
// any other message of the same chat) where it ends; the messages between
// them are rendered as images (logCaptureRender.ts) and copied to the
// clipboard when the browser allows it, with copy, save and share buttons
// in the result window (LogCaptureOverlay.svelte).

import { DBState, selIdState } from '../stores.svelte'
import { language } from 'src/lang'
import { logCaptureRange, logImageFileName } from './logCapture'
import type { LogCaptureStage } from './logCaptureRender'

export type LogCapturePhase = 'idle' | 'picking' | 'rendering' | 'done' | 'error'
export type LogCaptureCopyState = 'none' | 'pending' | 'copied' | 'failed'

export interface LogCaptureImage {
    blob: Blob
    url: string
    width: number
    height: number
    name: string
}

interface ChatIdentity {
    chaId: string
    chatId: string
}

export const logCapture = $state({
    phase: 'idle' as LogCapturePhase,
    start: null as (ChatIdentity & { index: number }) | null,
    range: null as { from: number; to: number } | null,
    stage: 'render' as LogCaptureStage,
    done: 0,
    total: 0,
    images: [] as LogCaptureImage[],
    copy: 'none' as LogCaptureCopyState,
    error: '',
})

let controller: AbortController | null = null
let runId = 0

function currentChatIdentity(): ChatIdentity | null {
    const character = DBState.db.characters?.[selIdState.selId]
    const chat = character?.chats?.[character.chatPage]
    if (!character?.chaId || !chat?.id) return null
    return { chaId: character.chaId, chatId: chat.id }
}

function sameChat(a: ChatIdentity | null, b: ChatIdentity | null): boolean {
    return !!a && !!b && a.chaId === b.chaId && a.chatId === b.chatId
}

/** The message marked as the start, in the chat now open. */
export function isLogCaptureStart(index: number): boolean {
    const start = logCapture.start
    if (logCapture.phase !== 'picking' || !start || start.index !== index) return false
    return sameChat(start, currentChatIdentity())
}

/** The start mark belongs to the chat now open. */
export function isLogCapturePickingHere(): boolean {
    return logCapture.phase === 'picking' && sameChat(logCapture.start, currentChatIdentity())
}

function releaseImages() {
    for (const image of logCapture.images) URL.revokeObjectURL(image.url)
    logCapture.images = []
}

function reset() {
    releaseImages()
    logCapture.phase = 'idle'
    logCapture.start = null
    logCapture.range = null
    logCapture.done = 0
    logCapture.total = 0
    logCapture.copy = 'none'
    logCapture.error = ''
}

/** Closes the result, cancels a selection or stops a capture in progress. */
export function cancelLogCapture() {
    runId++
    controller?.abort()
    controller = null
    reset()
}

/**
 * A ✂️ press. Must run inside the click: the clipboard write that delivers
 * the image later is started here, while the press still counts as one.
 */
export function markLogCapture(index: number) {
    if (logCapture.phase === 'rendering') return
    const here = currentChatIdentity()
    if (!here) return
    const start = logCapture.start
    if (logCapture.phase !== 'picking' || !start || !sameChat(start, here)) {
        reset()
        logCapture.start = { ...here, index }
        logCapture.phase = 'picking'
        return
    }
    if (start.index === index) {
        cancelLogCapture()
        return
    }
    void runCapture(logCaptureRange(start.index, index))
}

function startClipboardWrite(image: Promise<Blob>): Promise<void> | null {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return null
    try {
        return navigator.clipboard.write([new ClipboardItem({ 'image/png': image })])
    } catch {
        return null
    }
}

async function runCapture(range: { from: number; to: number }) {
    const run = ++runId
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    releaseImages()
    logCapture.phase = 'rendering'
    logCapture.start = null
    logCapture.range = range
    logCapture.stage = 'render'
    logCapture.done = 0
    logCapture.total = 0
    logCapture.error = ''

    // One image goes to the clipboard as soon as it exists; several cannot.
    let deliver: (blob: Blob) => void = () => {}
    let refuse: (reason: unknown) => void = () => {}
    const single = new Promise<Blob>((resolve, reject) => { deliver = resolve; refuse = reject })
    single.catch(() => {})
    const write = startClipboardWrite(single)
    logCapture.copy = write ? 'pending' : 'none'
    write?.then(
        () => { if (run === runId) logCapture.copy = 'copied' },
        () => { if (run === runId) logCapture.copy = logCapture.images.length > 1 ? 'none' : 'failed' },
    )

    try {
        const { renderLogImages } = await import('./logCaptureRender')
        const rendered = await renderLogImages({
            from: range.from,
            to: range.to,
            signal,
            onProgress: (stage, done, total) => {
                if (run !== runId) return
                logCapture.stage = stage
                logCapture.done = done
                logCapture.total = total
            },
        })
        if (run !== runId) return
        const character = DBState.db.characters?.[selIdState.selId]
        logCapture.images = rendered.map((image, part) => ({
            ...image,
            url: URL.createObjectURL(image.blob),
            name: logImageFileName(character?.name ?? '', range.from, range.to, part, rendered.length),
        }))
        logCapture.phase = 'done'
        if (rendered.length === 1) deliver(rendered[0].blob)
        else refuse(new Error('several images'))
    } catch (error) {
        refuse(error)
        if (run !== runId) return
        if ((error as DOMException)?.name === 'AbortError') {
            reset()
            return
        }
        console.error('[LogCapture]', error)
        logCapture.phase = 'error'
        logCapture.error = (error as Error)?.message || String(error)
    }
}

export async function copyLogImage(image: LogCaptureImage): Promise<boolean> {
    try {
        if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('no clipboard')
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.blob })])
        logCapture.copy = 'copied'
        return true
    } catch {
        logCapture.copy = 'failed'
        return false
    }
}

export function saveLogImage(image: LogCaptureImage) {
    const a = document.createElement('a')
    a.href = image.url
    a.download = image.name
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
}

export function canShareLogImages(): boolean {
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false
    try {
        return navigator.canShare({ files: [new File([new Uint8Array(1)], 'probe.png', { type: 'image/png' })] })
    } catch {
        return false
    }
}

export async function shareLogImages(images: LogCaptureImage[]) {
    const files = images.map((image) => new File([image.blob], image.name, { type: 'image/png' }))
    try {
        await navigator.share({ files, title: language.logCapture.title })
    } catch (error) {
        if ((error as DOMException)?.name !== 'AbortError') console.warn('[LogCapture] share failed', error)
    }
}
