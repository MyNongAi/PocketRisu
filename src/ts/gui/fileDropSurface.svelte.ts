// A region that takes files dragged in from outside the app: the module
// catalog imports them as modules, the persona page as personas. While such
// a drag is over the region it shows a dashed frame (FileDropIndicator).
// Files dropped anywhere else fall through to App.svelte's <main> handler,
// which imports them as characters.
import { RISU_APP_INTERNAL_DRAG_TYPE, RISU_SIDEBAR_DRAG_TYPE } from '../dragTypes'

/** Files from outside the app, not an in-app drag the browser reports as Files. */
export function isExternalFileDrag(event: DragEvent): boolean {
    const types = Array.from(event.dataTransfer?.types ?? [])
    return types.includes('Files')
        && !types.includes(RISU_APP_INTERNAL_DRAG_TYPE)
        && !types.includes(RISU_SIDEBAR_DRAG_TYPE)
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

    constructor(options: {
        accepts?: (event: DragEvent) => boolean
        onDrop: (files: File[]) => unknown
    }) {
        this.#accepts = options.accepts ?? (() => true)
        this.#onDrop = options.onDrop
    }

    #takes(event: DragEvent): boolean {
        return isExternalFileDrag(event) && this.#accepts(event)
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
        if (!this.#takes(event) || !event.dataTransfer?.files.length) return
        event.preventDefault()
        event.stopPropagation()
        void this.#onDrop(Array.from(event.dataTransfer.files))
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
