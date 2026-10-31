// A region that takes files dragged in from outside the app: the module
// catalog imports them as modules, the persona page as personas. While such
// a drag is over the region it shows a dashed frame (FileDropIndicator).
// Files dropped anywhere else fall through to App.svelte's <main> handler,
// which imports them as characters. A region given onLink takes links too;
// <main> takes the rest (linkDropImport.ts).
import { RISU_APP_INTERNAL_DRAG_TYPE, RISU_SIDEBAR_DRAG_TYPE } from '../dragTypes'

/** Files from outside the app, not an in-app drag the browser reports as Files. */
export function isExternalFileDrag(event: DragEvent): boolean {
    const types = Array.from(event.dataTransfer?.types ?? [])
    return types.includes('Files')
        && !types.includes(RISU_APP_INTERNAL_DRAG_TYPE)
        && !types.includes(RISU_SIDEBAR_DRAG_TYPE)
}

/**
 * Over a text box. Text or a link dragged in from outside goes into the box,
 * the browser's own drop, rather than being imported.
 */
export function isOverTextBox(event: DragEvent): boolean {
    const target = event.target
    return target instanceof Element
        && !!target.closest('textarea, input, [contenteditable]:not([contenteditable="false"])')
}

/** Text or a link from outside the app, over a text box (isOverTextBox). */
export function isExternalTextIntoTextBox(event: DragEvent): boolean {
    const types = Array.from(event.dataTransfer?.types ?? [])
    return (types.includes('text/uri-list') || types.includes('text/plain'))
        && !types.includes('Files')
        && !types.includes(RISU_APP_INTERNAL_DRAG_TYPE)
        && !types.includes(RISU_SIDEBAR_DRAG_TYPE)
        && isOverTextBox(event)
}

/**
 * A link dragged in from another page or app (a link or the address bar),
 * which imports the way the Proton box imports it (linkDropImport.ts).
 */
export function isExternalLinkDrag(event: DragEvent): boolean {
    const types = Array.from(event.dataTransfer?.types ?? [])
    return types.includes('text/uri-list')
        && !types.includes('Files')
        && !types.includes(RISU_APP_INTERNAL_DRAG_TYPE)
        && !types.includes(RISU_SIDEBAR_DRAG_TYPE)
        && !isOverTextBox(event)
}

/** The dropped link: the first one in text/uri-list, whose '#' lines are comments. Readable only on drop. */
export function droppedLink(event: DragEvent): string | null {
    const list = event.dataTransfer?.getData('text/uri-list') ?? ''
    return list.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#')) ?? null
}

/** Whether every dragged item is an image; MIME types are readable while dragging. */
export function draggedItemsAreImages(event: DragEvent): boolean {
    const items = Array.from(event.dataTransfer?.items ?? [])
    return items.length > 0 && items.every((item) => item.kind === 'file' && item.type.startsWith('image/'))
}

export class FileDropSurface {
    active = $state(false)
    #accepts: (event: DragEvent) => boolean
    #onDrop: (files: File[]) => unknown
    #onLink?: (url: string) => unknown

    constructor(options: {
        accepts?: (event: DragEvent) => boolean
        onDrop: (files: File[]) => unknown
        /** A link dragged in from outside (isExternalLinkDrag); without it, links fall through. */
        onLink?: (url: string) => unknown
    }) {
        this.#accepts = options.accepts ?? (() => true)
        this.#onDrop = options.onDrop
        this.#onLink = options.onLink
    }

    #takesLink(event: DragEvent): boolean {
        return !!this.#onLink && isExternalLinkDrag(event)
    }

    #takes(event: DragEvent): boolean {
        return (isExternalFileDrag(event) || this.#takesLink(event)) && this.#accepts(event)
    }

    /** dragenter and dragover. */
    over = (event: DragEvent) => {
        if (!this.#takes(event)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
        this.active = true
    }

    leave = (event: DragEvent) => {
        if (!this.active) return
        // dragleave also fires when moving between the region's own children.
        const next = event.relatedTarget
        if (next instanceof Node && (event.currentTarget as Node).contains(next)) return
        this.active = false
    }

    drop = (event: DragEvent) => {
        this.active = false
        if (!this.#takes(event) || !event.dataTransfer) return
        if (event.dataTransfer.files.length) {
            event.preventDefault()
            event.stopPropagation()
            void this.#onDrop(Array.from(event.dataTransfer.files))
            return
        }
        const link = this.#takesLink(event) ? droppedLink(event) : null
        if (!link) return
        event.preventDefault()
        event.stopPropagation()
        void this.#onLink?.(link)
    }

    /**
     * Ends the preview on any drop in the window, including one that never
     * reaches the region: a child target that stops it, or App.svelte's
     * capture-phase RISUM import. Returns the cleanup, for $effect.
     */
    attachWindowReset(): () => void {
        const reset = () => { this.active = false }
        window.addEventListener('drop', reset, true)
        window.addEventListener('dragend', reset, true)
        return () => {
            window.removeEventListener('drop', reset, true)
            window.removeEventListener('dragend', reset, true)
        }
    }
}
