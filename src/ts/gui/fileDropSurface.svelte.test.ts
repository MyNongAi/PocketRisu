import { describe, expect, test, vi } from 'vitest'
import { FileDropSurface, draggedItemsAreImages, isExternalFileDrag } from './fileDropSurface.svelte'
import { RISU_APP_INTERNAL_DRAG_TYPE, RISU_SIDEBAR_DRAG_TYPE } from '../dragTypes'

type FakeItem = { kind: string, type: string }

function dragEvent(opts: {
    types?: string[]
    items?: FakeItem[]
    files?: File[]
    currentTarget?: Node
    relatedTarget?: Node | null
} = {}) {
    const files = opts.files ?? []
    const dataTransfer = {
        types: opts.types ?? ['Files'],
        items: opts.items ?? files.map((f) => ({ kind: 'file', type: f.type })),
        files,
        dropEffect: 'none',
    }
    return {
        dataTransfer,
        currentTarget: opts.currentTarget ?? null,
        relatedTarget: opts.relatedTarget ?? null,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    } as unknown as DragEvent & { preventDefault: ReturnType<typeof vi.fn>, stopPropagation: ReturnType<typeof vi.fn> }
}

const risum = new File([new Uint8Array([111, 0])], 'a.risum')
const png = new File([new Uint8Array([137, 80])], 'b.png', { type: 'image/png' })

describe('isExternalFileDrag', () => {
    test('files from outside the app', () => {
        expect(isExternalFileDrag(dragEvent())).toBe(true)
    })
    test('not in-app drags the browser also reports as Files', () => {
        expect(isExternalFileDrag(dragEvent({ types: ['Files', RISU_APP_INTERNAL_DRAG_TYPE] }))).toBe(false)
        expect(isExternalFileDrag(dragEvent({ types: ['Files', RISU_SIDEBAR_DRAG_TYPE] }))).toBe(false)
        expect(isExternalFileDrag(dragEvent({ types: ['text/plain'] }))).toBe(false)
    })
})

describe('draggedItemsAreImages', () => {
    test('every item must be an image file', () => {
        expect(draggedItemsAreImages(dragEvent({ items: [{ kind: 'file', type: 'image/png' }, { kind: 'file', type: 'image/webp' }] }))).toBe(true)
        expect(draggedItemsAreImages(dragEvent({ items: [{ kind: 'file', type: 'image/png' }, { kind: 'file', type: '' }] }))).toBe(false)
        expect(draggedItemsAreImages(dragEvent({ items: [] }))).toBe(false)
    })
})

describe('FileDropSurface', () => {
    test('shows the frame and asks for a copy while outside files are over it', () => {
        const surface = new FileDropSurface({ onDrop: () => {} })
        const event = dragEvent()
        surface.over(event)
        expect(surface.active).toBe(true)
        expect(event.preventDefault).toHaveBeenCalled()
        expect(event.dataTransfer!.dropEffect).toBe('copy')
    })

    test('ignores drags it does not accept, which then fall through to the app', () => {
        const surface = new FileDropSurface({ accepts: draggedItemsAreImages, onDrop: () => {} })
        const event = dragEvent({ files: [risum] })
        surface.over(event)
        expect(surface.active).toBe(false)
        expect(event.preventDefault).not.toHaveBeenCalled()

        const internal = dragEvent({ types: ['Files', RISU_APP_INTERNAL_DRAG_TYPE] })
        surface.over(internal)
        expect(surface.active).toBe(false)
    })

    test('stays on while the pointer moves between its own children', () => {
        const surface = new FileDropSurface({ onDrop: () => {} })
        const region = document.createElement('div')
        const child = document.createElement('span')
        region.appendChild(child)
        surface.over(dragEvent())
        surface.leave(dragEvent({ currentTarget: region, relatedTarget: child }))
        expect(surface.active).toBe(true)
        surface.leave(dragEvent({ currentTarget: region, relatedTarget: document.body }))
        expect(surface.active).toBe(false)
    })

    test('a drop hands the files over and keeps them from the app-wide import', () => {
        const onDrop = vi.fn()
        const surface = new FileDropSurface({ onDrop })
        surface.over(dragEvent())
        const event = dragEvent({ files: [risum, png] })
        surface.drop(event)
        expect(onDrop).toHaveBeenCalledWith([risum, png])
        expect(event.preventDefault).toHaveBeenCalled()
        expect(event.stopPropagation).toHaveBeenCalled()
        expect(surface.active).toBe(false)
    })

    test('a drop it does not accept is left alone', () => {
        const onDrop = vi.fn()
        const surface = new FileDropSurface({ accepts: draggedItemsAreImages, onDrop })
        const event = dragEvent({ files: [risum] })
        surface.drop(event)
        expect(onDrop).not.toHaveBeenCalled()
        expect(event.stopPropagation).not.toHaveBeenCalled()
    })

    test('any drop in the window ends the preview, and the listener can be removed', () => {
        const surface = new FileDropSurface({ onDrop: () => {} })
        const detach = surface.attachWindowReset()
        surface.over(dragEvent())
        window.dispatchEvent(new Event('drop'))
        expect(surface.active).toBe(false)

        detach()
        surface.over(dragEvent())
        window.dispatchEvent(new Event('drop'))
        expect(surface.active).toBe(true)
    })
})
