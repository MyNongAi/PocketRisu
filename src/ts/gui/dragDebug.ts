// On-screen diagnostics for a list drag (the user's choice, 2026-11-07: on the
// phone a module cannot leave its folder, nor enter one, while a mouse can; the
// phone runs Sortable's touch fallback, which finds the list under the finger
// with elementFromPoint, and the PC its native drag). Off unless this device has
// localStorage `risu-debug-drag` = `1` (opening the app once with
// `?risu-debug-drag=1` in the address sets it, `=0` clears it: a phone's app
// window has no console); then a small box shows, while a row is
// dragged and after it is let go: the list it came from, what is under the
// finger and which list that is, the lists Sortable offered the move to and
// whether they took it, the last onMove answer, where the row sits now, the
// floating copy's pointer-events, and where it was dropped. Temporary: removed
// once the cause is found.

import Sortable from 'sortablejs'

export const DRAG_DEBUG_KEY = 'risu-debug-drag'

export function dragDebugOn(): boolean {
    try {
        return localStorage.getItem(DRAG_DEBUG_KEY) === '1'
    } catch {
        return false
    }
}

type Over = { list: string, valid: boolean, insertion: boolean | null }

type DragReport = {
    from: string
    row: string
    finger: string
    under: string
    now: string
    overs: Over[]
    move: string
    ghost: string
    drop: string
    counts: { touch: number, pointer: number, cancel: number, over: number, valid: number, inserted: number, onMove: number, refused: number }
}

let report: DragReport | null = null
let box: HTMLDivElement | null = null
let drawQueued = false
let installed = false

function emptyReport(): DragReport {
    return {
        from: '-', row: '-', finger: '-', under: '-', now: '-', overs: [], move: '-', ghost: '-', drop: '-',
        counts: { touch: 0, pointer: 0, cancel: 0, over: 0, valid: 0, inserted: 0, onMove: 0, refused: 0 },
    }
}

/** A list as `items#3 f-1a2b3c` / `items#5 root` / `folders#0`: group, index on the page, folder. */
export function listLabel(list: Element | null | undefined): string {
    if (!list) return '-'
    const element = list.closest('[data-risu-sortable-list]') ?? list
    const instance = Sortable.get(element as HTMLElement)
    const group = instance?.options.group as { name?: string } | string | undefined
    const name = typeof group === 'string' ? group : group?.name ?? '?'
    const short = name === 'foldered-list-items' ? 'items' : name === 'foldered-list-folders' ? 'folders' : name
    const index = Array.from(document.querySelectorAll('[data-risu-sortable-list]')).indexOf(element)
    const folder = element.closest('[data-folder-container]')?.getAttribute('data-folder-container')
    const place = folder === '' ? ' root' : folder ? ` f-${folder.slice(0, 6)}` : ''
    return `${short}#${index}${place}${instance?.options.disabled ? ' (off)' : ''}${instance ? '' : ' (no sortable)'}`
}

function rowLabel(element: Element | null | undefined): string {
    const row = element?.closest?.('[data-sortable-key], [data-folder-key]')
    if (!row) return ''
    const key = row.getAttribute('data-sortable-key')
    return key !== null ? `row ${key}` : `folder ${String(row.getAttribute('data-folder-key')).slice(0, 6)}`
}

function elementLabel(element: Element | null): string {
    if (!element) return 'nothing'
    const classes = typeof element.className === 'string' ? element.className.split(/\s+/).filter(Boolean).slice(0, 2) : []
    const noSort = element.closest('.no-sort') ? ' [no-sort]' : ''
    return `${element.tagName.toLowerCase()}${classes.length ? '.' + classes.join('.') : ''}${noSort}`
}

function ghostLabel(): string {
    const ghost = document.querySelector<HTMLElement>('.sortable-fallback')
    if (!ghost) return 'none (native drag)'
    return `pe=${getComputedStyle(ghost).pointerEvents} in ${ghost.parentElement?.tagName.toLowerCase() ?? '?'}`
}

function draw(): void {
    drawQueued = false
    if (!report) return
    if (!box) {
        box = document.createElement('div')
        box.setAttribute('data-drag-debug', '')
        box.setAttribute('aria-hidden', 'true')
        Object.assign(box.style, {
            position: 'fixed', left: '4px', top: 'calc(env(safe-area-inset-top, 0px) + 4px)', zIndex: '2147483647',
            maxWidth: 'calc(100vw - 8px)', maxHeight: '45vh', overflow: 'hidden', pointerEvents: 'none',
            background: 'rgba(0,0,0,0.82)', color: '#7CFC8A', font: '11px/1.35 ui-monospace, monospace',
            padding: '4px 6px', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        })
        document.body.appendChild(box)
    }
    const r = report
    const c = r.counts
    box.textContent = [
        'drag debug (risu-debug-drag)',
        `from   ${r.from}  ${r.row}`,
        `finger ${r.finger}`,
        `under  ${r.under}`,
        `over   ${r.overs.map((o) => `${o.list}${o.valid ? ' ok' : ' no'}${o.insertion === null ? '' : o.insertion ? ' +ins' : ' -ins'}`).join('  >  ') || '-'}`,
        `onMove ${r.move}`,
        `now in ${r.now}`,
        `ghost  ${r.ghost}`,
        `moves  touch ${c.touch} pointer ${c.pointer} cancel ${c.cancel}`,
        `count  over ${c.over} valid ${c.valid} ins ${c.inserted} onMove ${c.onMove} refused ${c.refused}`,
        `drop   ${r.drop}`,
    ].join('\n')
}

function redraw(): void {
    if (drawQueued) return
    drawQueued = true
    requestAnimationFrame(draw)
}

function onFingerMove(event: TouchEvent | PointerEvent): void {
    if (!report) return
    const point = 'touches' in event ? event.touches[0] : event
    if (!point) return
    const hit = document.elementFromPoint(point.clientX, point.clientY)
    if ('touches' in event) report.counts.touch++
    else report.counts.pointer++
    report.finger = `${Math.round(point.clientX)},${Math.round(point.clientY)} -> ${elementLabel(hit)} ${rowLabel(hit)}`
    report.under = listLabel(hit?.closest('[data-risu-sortable-list]'))
    report.ghost = ghostLabel()
    const dragged = Sortable.dragged
    report.now = dragged ? `${listLabel(dragged.parentElement)} at ${Array.from(dragged.parentElement?.children ?? []).indexOf(dragged)}` : '-'
    redraw()
}

function onCancel(): void {
    if (!report) return
    report.counts.cancel++
    redraw()
}

function stopListening(): void {
    document.removeEventListener('touchmove', onFingerMove, true)
    document.removeEventListener('pointermove', onFingerMove, true)
    document.removeEventListener('pointercancel', onCancel, true)
    document.removeEventListener('touchcancel', onCancel, true)
}

type PluginEvent = { sortable: Sortable, insertion?: boolean, oldIndex?: number, newIndex?: number }

function DragDebug(this: unknown) {}
DragDebug.prototype = {
    dragStartedGlobal({ sortable }: PluginEvent) {
        report = emptyReport()
        report.from = listLabel(sortable.el)
        report.row = rowLabel(Sortable.dragged)
        report.ghost = ghostLabel()
        document.addEventListener('touchmove', onFingerMove, { capture: true, passive: true })
        document.addEventListener('pointermove', onFingerMove, { capture: true, passive: true })
        document.addEventListener('pointercancel', onCancel, true)
        document.addEventListener('touchcancel', onCancel, true)
        redraw()
    },
    dragOverGlobal({ sortable }: PluginEvent) {
        if (!report) return
        report.counts.over++
        report.overs = [...report.overs.slice(-3), { list: listLabel(sortable.el), valid: false, insertion: null }]
        redraw()
    },
    dragOverValidGlobal() {
        if (!report) return
        report.counts.valid++
        const last = report.overs[report.overs.length - 1]
        if (last) last.valid = true
    },
    dragOverCompletedGlobal({ insertion }: PluginEvent) {
        if (!report) return
        if (insertion) report.counts.inserted++
        const last = report.overs[report.overs.length - 1]
        if (last) last.insertion = !!insertion
        redraw()
    },
    dropGlobal({ sortable }: PluginEvent) {
        if (!report) return
        stopListening()
        const dragged = Sortable.dragged
        report.drop = `${report.from} -> ${listLabel(dragged?.parentElement ?? sortable.el)} at ${dragged ? Array.from(dragged.parentElement?.children ?? []).indexOf(dragged) : '?'}`
        redraw()
    },
    nullingGlobal() {
        stopListening()
    },
}

/** ShSortableList's options, with onMove's answers recorded while the flag is on. */
export function withDragDebug<T extends { onMove?: (...args: never[]) => unknown }>(options: T): T {
    if (!installed) return options
    const onMove = options.onMove as ((event: { related: Element, to: Element, willInsertAfter?: boolean }, original: Event) => unknown) | undefined
    if (!onMove) return options
    return {
        ...options,
        onMove: (event: { related: Element, to: Element, willInsertAfter?: boolean }, original: Event) => {
            const answer = onMove(event, original)
            if (report) {
                report.counts.onMove++
                if (answer === false) report.counts.refused++
                report.move = `${listLabel(event.to)} ${rowLabel(event.related) || elementLabel(event.related)}${event.willInsertAfter ? ' after' : ''} -> ${String(answer)}`
                redraw()
            }
            return answer
        },
    } as T
}

/** `?risu-debug-drag=1` (or `0`) in the address turns the flag on (off) on this device, then leaves the address. */
export function takeDragDebugSwitch(): void {
    try {
        const url = new URL(location.href)
        const value = url.searchParams.get(DRAG_DEBUG_KEY)
        if (value === null) return
        if (value === '1') localStorage.setItem(DRAG_DEBUG_KEY, '1')
        else localStorage.removeItem(DRAG_DEBUG_KEY)
        url.searchParams.delete(DRAG_DEBUG_KEY)
        history.replaceState(history.state, '', url.toString())
    } catch {
        // storage or history off
    }
}

/** Before the app mounts (plugins reach only the lists made after), and only with the flag. */
export function initDragDebug(): void {
    takeDragDebugSwitch()
    if (installed || !dragDebugOn()) return
    installed = true
    Sortable.mount(Object.assign(DragDebug, { pluginName: 'dragDebug', initializeByDefault: true }) as never)
}
