<script lang="ts">
    // Branch graph view, ported from HaejeokRisu's BranchGraphModal (pan, zoom,
    // pinch, tree / timeline / git layouts, current-path highlight) onto the
    // read-only projection in src/ts/gui/branches.ts. Only nodes near the
    // viewport are rendered, so an unfolded chat of thousands of messages stays
    // responsive.
    import { onDestroy, onMount, tick } from 'svelte'
    import { Ellipsis, GitBranch, LoaderCircle, LocateFixed, Maximize, Repeat, TriangleAlert, XIcon, ZoomIn, ZoomOut } from '@lucide/svelte'

    import { language } from 'src/lang'
    import { DBState, selIdState } from 'src/ts/stores.svelte'
    import {
        branchGraphTarget,
        buildBranchForest,
        buildBranchGraphGitRows,
        buildBranchGraphLanes,
        projectBranchGraph,
        type BranchGraphDensity,
        type BranchGraphEdge,
        type BranchGraphNode,
        type BranchGraphScope,
        type BranchIssue,
        type GraphChat,
    } from 'src/ts/gui/branches'
    import { BranchGraphSource } from 'src/ts/gui/branchGraphSource'
    import { openBranchGraphTarget } from 'src/ts/gui/branchGraphActions'

    interface Props {
        onclose: () => void
    }

    let { onclose }: Props = $props()

    type GraphLayout = 'tree' | 'timeline' | 'git'

    // The graph belongs to the character that was open; switching away closes it.
    const selectedAtOpen = selIdState.selId
    const openedCharacter = DBState.db.characters?.[selectedAtOpen]
    const source = openedCharacter ? new BranchGraphSource(openedCharacter) : null
    const initial = source?.snapshot() ?? { chats: [], activeChatIndex: 0 }

    let chats = $state.raw<GraphChat[]>(initial.chats)
    let activeChatIndex = $state(initial.activeChatIndex)
    let loading = $state(false)
    let unloadedCount = $state(source?.unloadedCount(initial) ?? 0)
    let failedCount = $state(0)
    let readBudgetLeft = $state(source?.readBudgetLeft ?? 0)
    let disposed = false

    let layout = $state<GraphLayout>('tree')
    let density = $state<BranchGraphDensity>('smart')
    let scope = $state<BranchGraphScope>('family')
    let expanded = $state.raw<ReadonlySet<string>>(new Set())
    let focusCurrentPath = $state(false)

    const forest = $derived(buildBranchForest(chats, activeChatIndex))
    const graph = $derived(projectBranchGraph(forest, { density, scope, expanded }))

    const padding = 48
    // Safety guard only: keeps the scale positive and finite.
    const minScale = 0.05
    const maxScale = 4
    const cardWidth = $derived(layout === 'git' ? 248 : 272)
    const cardHeight = $derived(layout === 'git' ? 100 : 108)
    const gapX = $derived(layout === 'git' ? 18 : layout === 'timeline' ? 36 : 28)
    const gapY = $derived(layout === 'git' ? 18 : layout === 'timeline' ? 22 : 32)

    const gitRows = $derived(layout === 'git' ? buildBranchGraphGitRows(graph) : null)
    // Lanes are packed along the layout's flow axis so branches that do not
    // overlap reuse a lane instead of stretching the canvas.
    const lanes = $derived(layout === 'tree' ? null : buildBranchGraphLanes(graph, (node) => layout === 'timeline' ? node.y : (gitRows?.rowByNodeId.get(node.id) ?? 0)))
    const columns = $derived(layout === 'tree' ? graph.columns : layout === 'timeline' ? graph.rows : (lanes?.columns ?? 1))
    const rows = $derived(layout === 'tree' ? graph.rows : layout === 'timeline' ? (lanes?.columns ?? 1) : (gitRows?.rows ?? 0))
    const graphWidth = $derived(padding * 2 + columns * cardWidth + Math.max(0, columns - 1) * gapX)
    const graphHeight = $derived(padding * 2 + rows * cardHeight + Math.max(0, rows - 1) * gapY)

    const positions = $derived.by(() => {
        const map = new Map<string, { left: number, top: number }>()
        for (const node of graph.nodes) {
            if (layout === 'timeline') {
                const lane = lanes?.laneByNodeId.get(node.id) ?? 0
                map.set(node.id, { left: padding + node.y * (cardWidth + gapX), top: padding + lane * (cardHeight + gapY) })
            } else if (layout === 'git') {
                const lane = lanes?.laneByNodeId.get(node.id) ?? 0
                const row = gitRows?.rowByNodeId.get(node.id) ?? 0
                map.set(node.id, { left: padding + lane * (cardWidth + gapX), top: padding + row * (cardHeight + gapY) })
            } else {
                map.set(node.id, { left: padding + node.x * (cardWidth + gapX), top: padding + node.y * (cardHeight + gapY) })
            }
        }
        return map
    })
    const activeNode = $derived(graph.nodes.find((node) => node.activeTerminal)
        ?? [...graph.nodes].reverse().find((node) => node.activePath && node.kind !== 'swipe'))

    let viewport: HTMLDivElement | undefined = $state()
    let viewportWidth = $state(0)
    let viewportHeight = $state(0)
    let panX = $state(0)
    let panY = $state(0)
    let scale = $state(1)
    let isPanning = $state(false)
    let panPointerId: number | null = null
    let panStart = { x: 0, y: 0, panX: 0, panY: 0 }
    const touchPointers = new Map<number, { x: number, y: number }>()
    let lastPinchCenter: { x: number, y: number } | null = null
    let lastPinchDistance: number | null = null
    let cachedViewportBounds: DOMRect | null = null
    let hasInteracted = false
    let canvasAnimating = $state(false)
    let canvasAnimatingTimer: ReturnType<typeof setTimeout> | undefined
    // Zoomed out, heavy paint (shadows) is invisible anyway; below the LOD
    // threshold text is unreadable and nodes become plain blocks.
    const zoomedOut = $derived(scale < 0.45)
    const lod = $derived(scale < 0.3)

    // Viewport culling. The visible area (plus one screen of margin) is
    // snapped to a coarse grid, so panning re-filters only when it crosses a
    // cell, not on every frame.
    const CULL_CELL = 600
    const cullBounds = $derived.by(() => {
        if (viewportWidth === 0 || viewportHeight === 0) return ''
        const marginX = viewportWidth / scale
        const marginY = viewportHeight / scale
        const left = Math.floor((-panX / scale - marginX) / CULL_CELL) * CULL_CELL
        const top = Math.floor((-panY / scale - marginY) / CULL_CELL) * CULL_CELL
        const right = Math.ceil(((viewportWidth - panX) / scale + marginX) / CULL_CELL) * CULL_CELL
        const bottom = Math.ceil(((viewportHeight - panY) / scale + marginY) / CULL_CELL) * CULL_CELL
        return `${left},${top},${right},${bottom}`
    })
    const visibleNodes = $derived.by(() => {
        if (!cullBounds) return graph.nodes
        const [left, top, right, bottom] = cullBounds.split(',').map(Number)
        return graph.nodes.filter((node) => {
            const position = positions.get(node.id)
            return !!position && position.left + cardWidth >= left && position.left <= right && position.top + cardHeight >= top && position.top <= bottom
        })
    })
    const visibleEdges = $derived.by(() => {
        const [left, top, right, bottom] = cullBounds ? cullBounds.split(',').map(Number) : [-Infinity, -Infinity, Infinity, Infinity]
        const result: Array<{ edge: BranchGraphEdge, path: string, x2: number, y2: number }> = []
        for (const edge of graph.edges) {
            const from = positions.get(edge.from)
            const to = positions.get(edge.to)
            if (!from || !to) continue
            const minX = Math.min(from.left, to.left)
            const maxX = Math.max(from.left, to.left) + cardWidth
            const minY = Math.min(from.top, to.top)
            const maxY = Math.max(from.top, to.top) + cardHeight
            if (maxX < left || minX > right || maxY < top || minY > bottom) continue
            result.push({ edge, ...edgeGeometry(from, to) })
        }
        return result
    })

    function edgeGeometry(fromPos: { left: number, top: number }, toPos: { left: number, top: number }) {
        if(layout === 'git') {
            const x1 = fromPos.left + cardWidth / 2
            const y1 = fromPos.top + cardHeight
            const x2 = toPos.left + cardWidth / 2
            const y2 = toPos.top
            if(Math.abs(x2 - x1) < 0.5) {
                return { path: `M ${x1} ${y1} L ${x1} ${y2}`, x2, y2 }
            }
            const yTurn = y2 - gapY / 2
            const radius = Math.max(2, Math.min(12, Math.abs(x2 - x1) / 2, (yTurn - y1) / 2, (y2 - yTurn) / 2))
            const sweep = x2 > x1 ? 0 : 1
            const turnX1 = x1 + (x2 > x1 ? radius : -radius)
            const turnX2 = x2 + (x2 > x1 ? -radius : radius)
            return {
                path: `M ${x1} ${y1} L ${x1} ${yTurn - radius} A ${radius} ${radius} 0 0 ${sweep} ${turnX1} ${yTurn} L ${turnX2} ${yTurn} A ${radius} ${radius} 0 0 ${1 - sweep} ${x2} ${yTurn + radius} L ${x2} ${y2}`,
                x2, y2,
            }
        }
        if(layout === 'timeline') {
            const x1 = fromPos.left + cardWidth
            const y1 = fromPos.top + cardHeight / 2
            const x2 = toPos.left
            const y2 = toPos.top + cardHeight / 2
            const midX = (x1 + x2) / 2
            return { path: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`, x2, y2 }
        }
        const x1 = fromPos.left + cardWidth / 2
        const y1 = fromPos.top + cardHeight
        const x2 = toPos.left + cardWidth / 2
        const y2 = toPos.top
        const midY = (y1 + y2) / 2
        return { path: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`, x2, y2 }
    }

    const clampScale = (value: number) => Math.min(maxScale, Math.max(minScale, value))

    function triggerCanvasAnimation(duration = 200) {
        if(canvasAnimatingTimer) clearTimeout(canvasAnimatingTimer)
        canvasAnimating = true
        canvasAnimatingTimer = setTimeout(() => {
            canvasAnimating = false
        }, duration)
    }

    function fitScale() {
        if(!viewport) return 1
        const inset = viewport.clientWidth < 640 ? 20 : 64
        return clampScale(Math.min(
            1,
            (viewport.clientWidth - inset * 2) / graphWidth,
            (viewport.clientHeight - inset * 2) / graphHeight,
        ))
    }

    function fitGraph(animate = true) {
        if(!viewport) return
        const nextScale = fitScale()
        scale = nextScale
        panX = (viewport.clientWidth - graphWidth * nextScale) / 2
        panY = (viewport.clientHeight - graphHeight * nextScale) / 2
        if(animate) triggerCanvasAnimation(200)
    }

    function focusNode(node: BranchGraphNode, nextScale: number, animate = true) {
        if(!viewport) return
        const position = positions.get(node.id)
        if(!position) return
        scale = clampScale(nextScale)
        panX = viewport.clientWidth / 2 - (position.left + cardWidth / 2) * scale
        panY = viewport.clientHeight / 2 - (position.top + cardHeight / 2) * scale
        if(animate) triggerCanvasAnimation(200)
    }

    function focusActive() {
        if(!activeNode) return
        hasInteracted = true
        focusNode(activeNode, Math.max(scale, 0.9))
    }

    // A graph that only fits at an unreadable size (a long chat on a phone)
    // opens on the current message instead of the whole picture.
    function initialView() {
        if(!viewport) return
        if(fitScale() < 0.4 && activeNode) focusNode(activeNode, 0.8, false)
        else fitGraph(false)
    }

    function refitAfterDisplayChange() {
        hasInteracted = false
        void tick().then(() => initialView())
    }

    function setLayout(next: GraphLayout) {
        if(layout === next) return
        layout = next
        refitAfterDisplayChange()
    }

    function setDensity(next: BranchGraphDensity) {
        if(density === next) return
        density = next
        refitAfterDisplayChange()
    }

    function setScope(next: BranchGraphScope) {
        if(scope === next) return
        scope = next
        refitAfterDisplayChange()
    }

    let isDraggingNode = false
    let dragThresholdPassed = false
    let navigating = false

    function selectNode(node: BranchGraphNode) {
        if(isDraggingNode || dragThresholdPassed || navigating) return
        if(node.kind === 'summary') {
            unfold(node)
            return
        }
        const target = branchGraphTarget(forest, node)
        if(!target) return
        navigating = true
        onclose()
        void openBranchGraphTarget(target)
    }

    function unfold(node: BranchGraphNode) {
        const next = new Set(expanded)
        for (const id of node.foldedIds) next.add(id)
        expanded = next
        hasInteracted = true
        const firstId = node.foldedIds[0]
        void tick().then(() => {
            const first = graph.nodes.find((item) => item.id === firstId)
            if(first) focusNode(first, Math.max(scale, 0.6))
        })
    }

    function zoomAt(clientX: number, clientY: number, nextScale: number) {
        if(!viewport) return
        const bounds = viewport.getBoundingClientRect()
        const cursorX = clientX - bounds.left
        const cursorY = clientY - bounds.top
        const graphX = (cursorX - panX) / scale
        const graphY = (cursorY - panY) / scale
        const clamped = clampScale(nextScale)
        panX = cursorX - graphX * clamped
        panY = cursorY - graphY * clamped
        scale = clamped
        hasInteracted = true
    }

    function zoomFromCenter(factor: number) {
        if(!viewport) return
        const bounds = viewport.getBoundingClientRect()
        triggerCanvasAnimation(200)
        zoomAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, scale * factor)
    }

    function handleDblClick(event: MouseEvent) {
        if(!viewport) return
        triggerCanvasAnimation(200)
        if(scale < 0.6) {
            zoomAt(event.clientX, event.clientY, 1)
        } else {
            hasInteracted = true
            fitGraph(true)
        }
    }

    let pendingWheel: WheelEvent | null = null
    let wheelRafId: number | null = null

    function handleWheel(event: WheelEvent) {
        event.preventDefault()
        // Trackpads fire many wheel events per frame; zoom once per frame.
        pendingWheel = event
        if(wheelRafId !== null) return
        wheelRafId = requestAnimationFrame(() => {
            wheelRafId = null
            const wheel = pendingWheel
            pendingWheel = null
            if(!wheel) return
            zoomAt(wheel.clientX, wheel.clientY, scale * Math.exp(-wheel.deltaY * 0.0015))
        })
    }

    function safeSetPointerCapture(pointerId: number) {
        if(!viewport) return
        try {
            viewport.setPointerCapture(pointerId)
        } catch {
            // The pointer may already be inactive or captured elsewhere.
        }
    }

    function safeReleasePointerCapture(pointerId: number) {
        if(!viewport) return
        try {
            if(viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId)
        } catch {
            // Already released by the browser on pointerup/cancel (common on touch).
        }
    }

    function startPinch() {
        if(!viewport || touchPointers.size < 2) return
        const [first, second] = [...touchPointers.values()]
        const distance = Math.hypot(second.x - first.x, second.y - first.y)
        if(distance === 0) return
        lastPinchDistance = distance
        lastPinchCenter = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
        cachedViewportBounds = viewport.getBoundingClientRect()
        panPointerId = null
        isPanning = true
        isDraggingNode = true
        dragThresholdPassed = true
        hasInteracted = true
        for(const pointerId of touchPointers.keys()) safeSetPointerCapture(pointerId)
    }

    function startPan(event: PointerEvent) {
        if(event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1) return
        const target = event.target as HTMLElement | null
        if(target?.closest('.graph-tool')) return

        if(event.pointerType === 'touch') {
            touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
            if(touchPointers.size >= 2) {
                event.preventDefault()
                startPinch()
                return
            }
        }

        const selectableNode = target?.closest('.branch-node--selectable')
        panPointerId = event.pointerId
        panStart = { x: event.clientX, y: event.clientY, panX, panY }

        if(selectableNode && event.button !== 1) {
            // Maybe a tap on the node: pan only once the pointer really moves.
            dragThresholdPassed = false
            isDraggingNode = false
        } else {
            event.preventDefault()
            dragThresholdPassed = true
            isDraggingNode = false
            hasInteracted = true
            isPanning = true
            safeSetPointerCapture(event.pointerId)
        }
    }

    function movePan(event: PointerEvent) {
        if(event.pointerType === 'touch' && touchPointers.has(event.pointerId)) {
            touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
            if(touchPointers.size >= 2) {
                event.preventDefault()
                if(!lastPinchCenter || !lastPinchDistance) startPinch()
                if(!viewport || !lastPinchCenter || !lastPinchDistance) return
                const [first, second] = [...touchPointers.values()]
                const distance = Math.hypot(second.x - first.x, second.y - first.y)
                const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
                // Move with the midpoint, then zoom around it.
                panX += center.x - lastPinchCenter.x
                panY += center.y - lastPinchCenter.y
                if(distance > 5 && lastPinchDistance > 5) {
                    const ratio = distance / lastPinchDistance
                    if(Math.abs(ratio - 1) > 0.001) {
                        if(!cachedViewportBounds) cachedViewportBounds = viewport.getBoundingClientRect()
                        const relX = center.x - cachedViewportBounds.left
                        const relY = center.y - cachedViewportBounds.top
                        const graphX = (relX - panX) / scale
                        const graphY = (relY - panY) / scale
                        const nextScale = clampScale(scale * ratio)
                        panX = relX - graphX * nextScale
                        panY = relY - graphY * nextScale
                        scale = nextScale
                    }
                }
                lastPinchCenter = center
                lastPinchDistance = distance
                isDraggingNode = true
                hasInteracted = true
                return
            }
        }

        if(panPointerId !== event.pointerId) return
        const dx = event.clientX - panStart.x
        const dy = event.clientY - panStart.y
        if(!dragThresholdPassed && Math.hypot(dx, dy) > 8) {
            dragThresholdPassed = true
            isDraggingNode = true
            hasInteracted = true
            isPanning = true
            safeSetPointerCapture(event.pointerId)
            panStart = { x: event.clientX, y: event.clientY, panX, panY }
        }
        if(dragThresholdPassed) {
            panX = panStart.panX + (event.clientX - panStart.x)
            panY = panStart.panY + (event.clientY - panStart.y)
        }
    }

    function endDrag() {
        if(isDraggingNode) {
            // Swallow the click that follows a drag.
            setTimeout(() => {
                isDraggingNode = false
                dragThresholdPassed = false
            }, 120)
        } else {
            dragThresholdPassed = false
        }
    }

    function finishPan(event: PointerEvent) {
        if(event.pointerType === 'touch' && touchPointers.delete(event.pointerId)) {
            safeReleasePointerCapture(event.pointerId)
            const wasPinching = lastPinchCenter !== null || lastPinchDistance !== null
            if(touchPointers.size >= 2) {
                startPinch()
                return
            }
            lastPinchCenter = null
            lastPinchDistance = null
            cachedViewportBounds = null
            if(touchPointers.size === 1) {
                // One finger left after a pinch keeps panning.
                const remaining = touchPointers.entries().next().value
                if(remaining) {
                    const [pointerId, pointer] = remaining
                    panPointerId = pointerId
                    panStart = { x: pointer.x, y: pointer.y, panX, panY }
                    dragThresholdPassed = wasPinching
                    isPanning = wasPinching
                    isDraggingNode = wasPinching
                    safeSetPointerCapture(pointerId)
                }
                return
            }
            panPointerId = null
            isPanning = false
            endDrag()
            return
        }

        if(panPointerId !== event.pointerId) return
        safeReleasePointerCapture(event.pointerId)
        panPointerId = null
        isPanning = false
        endDrag()
    }

    function handleKeydown(event: KeyboardEvent) {
        if(event.key === 'Escape') onclose()
        if(event.metaKey || event.ctrlKey || event.altKey) return
        const tag = (event.target as HTMLElement | null)?.tagName
        if(tag === 'INPUT' || tag === 'TEXTAREA') return
        if(event.key === '+' || event.key === '=') zoomFromCenter(1.16)
        if(event.key === '-') zoomFromCenter(1 / 1.16)
        if(event.key === '0') {
            hasInteracted = true
            fitGraph()
        }
    }

    function refresh() {
        if(!source || disposed) return
        const snapshot = source.snapshot()
        chats = snapshot.chats
        activeChatIndex = snapshot.activeChatIndex
        unloadedCount = source.unloadedCount(snapshot)
        failedCount = source.failedCount
        readBudgetLeft = source.readBudgetLeft
    }

    async function loadMore() {
        if(!source || loading) return
        loading = true
        try {
            await source.loadMore()
        } finally {
            loading = false
            refresh()
        }
    }

    function issueLabel(issue: BranchIssue): string {
        if(issue === 'missing-parent') return language.branchGraphIssueMissingParent
        if(issue === 'unloaded-parent') return language.branchGraphIssueUnloadedParent
        if(issue === 'cycle') return language.branchGraphIssueCycle
        return language.branchGraphIssueForkMoved
    }

    function roleLabel(node: BranchGraphNode): string {
        if(node.isComment) return language.branchGraphComment
        return node.role === 'user' ? language.branchGraphUser : language.branchGraphAssistant
    }

    $effect(() => {
        if(selIdState.selId !== selectedAtOpen) onclose()
    })

    $effect(() => {
        void graph
        void layout
        if(!viewport || hasInteracted) return
        void tick().then(() => {
            if(viewport && !hasInteracted) initialView()
        })
    })

    onMount(() => {
        let observer: ResizeObserver | undefined
        if(viewport) {
            viewportWidth = viewport.clientWidth
            viewportHeight = viewport.clientHeight
            observer = new ResizeObserver(() => {
                if(!viewport) return
                viewportWidth = viewport.clientWidth
                viewportHeight = viewport.clientHeight
                if(!hasInteracted) initialView()
            })
            observer.observe(viewport)
        }
        void tick().then(() => initialView())
        if(source) {
            loading = true
            void source.autoLoad(refresh).finally(() => {
                if(disposed) return
                loading = false
                refresh()
            })
        }
        return () => {
            observer?.disconnect()
            if(wheelRafId !== null) cancelAnimationFrame(wheelRafId)
            if(canvasAnimatingTimer) clearTimeout(canvasAnimatingTimer)
        }
    })

    onDestroy(() => {
        disposed = true
        source?.dispose()
    })
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="fixed inset-0 z-50 flex flex-col overflow-hidden bg-black/85">
    <header class="relative z-30 flex shrink-0 items-center gap-3 border-b border-darkborderc/70 bg-darkbg px-3.5 py-2.5 shadow-xl sm:px-5 sm:py-4" style="padding-top: max(env(safe-area-inset-top), 0.625rem)">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-xl border border-selected/60 bg-selected/20 text-textcolor shadow-inner sm:size-10">
            <GitBranch size={18} />
        </div>
        <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
                <h2 class="m-0 truncate text-base font-bold text-textcolor sm:text-lg">{language.branchGraphTitle}</h2>
                <span class="shrink-0 rounded-full border border-darkborderc/60 bg-bgcolor/60 px-2 py-0.5 text-[10px] text-textcolor2 sm:hidden">
                    {language.branchGraphMessageCount.replace('{}', graph.messageCount.toString())}
                </span>
            </div>
            <div class="mt-0.5 hidden truncate text-xs text-textcolor2 sm:block">{language.branchGraphDescription}</div>
        </div>
        <div class="hidden items-center gap-1.5 rounded-full border border-darkborderc/70 bg-bgcolor/70 px-3 py-1.5 text-xs text-textcolor2 sm:flex">
            {language.branchGraphMessageCount.replace('{}', graph.messageCount.toString())}
            {#if graph.collapsedMessageCount > 0}
                <span class="text-textcolor2/40">·</span>
                {language.branchGraphCollapsedMessages.replace('{}', graph.collapsedMessageCount.toString())}
            {/if}
            <span class="text-textcolor2/40">·</span>
            {language.branchGraphChatCount.replace('{}', graph.chatCount.toString())}
        </div>
        <button class="shrink-0 rounded-xl border border-darkborderc bg-bgcolor p-2 text-textcolor2 transition-colors hover:border-selected hover:text-textcolor" onclick={onclose} title={language.branchGraphClose} aria-label={language.branchGraphClose}>
            <XIcon size={20} />
        </button>
    </header>

    <div class="graph-display-bar relative z-20 flex shrink-0 items-center gap-2 overflow-x-auto border-b border-darkborderc/60 bg-darkbg px-3 py-1.5 text-xs text-textcolor2 sm:px-5 sm:py-2">
        <span class="shrink-0 text-[11px] font-semibold text-textcolor sm:text-xs">{language.branchGraphLayout}</span>
        <div class="flex shrink-0 items-center rounded-xl border border-darkborderc/70 bg-bgcolor/70 p-0.5 sm:p-1">
            <button class="graph-mode" class:graph-mode--active={layout === 'tree'} aria-pressed={layout === 'tree'} onclick={() => setLayout('tree')}>{language.branchGraphLayoutTree}</button>
            <button class="graph-mode" class:graph-mode--active={layout === 'timeline'} aria-pressed={layout === 'timeline'} onclick={() => setLayout('timeline')}>{language.branchGraphLayoutTimeline}</button>
            <button class="graph-mode" class:graph-mode--active={layout === 'git'} aria-pressed={layout === 'git'} onclick={() => setLayout('git')}>{language.branchGraphLayoutGit}</button>
        </div>
        <span class="ml-1 shrink-0 text-[11px] font-semibold text-textcolor sm:text-xs">{language.branchGraphDensity}</span>
        <div class="flex shrink-0 items-center rounded-xl border border-darkborderc/70 bg-bgcolor/70 p-0.5 sm:p-1">
            <button class="graph-mode" class:graph-mode--active={density === 'smart'} aria-pressed={density === 'smart'} onclick={() => setDensity('smart')}>{language.branchGraphDensitySmart}</button>
            <button class="graph-mode" class:graph-mode--active={density === 'all'} aria-pressed={density === 'all'} onclick={() => setDensity('all')}>{language.branchGraphDensityAll}</button>
            <button class="graph-mode" class:graph-mode--active={density === 'branches'} aria-pressed={density === 'branches'} onclick={() => setDensity('branches')}>{language.branchGraphDensityBranches}</button>
        </div>
        <span class="ml-1 shrink-0 text-[11px] font-semibold text-textcolor sm:text-xs">{language.branchGraphScope}</span>
        <div class="flex shrink-0 items-center rounded-xl border border-darkborderc/70 bg-bgcolor/70 p-0.5 sm:p-1">
            <button class="graph-mode" class:graph-mode--active={scope === 'family'} aria-pressed={scope === 'family'} onclick={() => setScope('family')}>{language.branchGraphScopeFamily}</button>
            <button class="graph-mode" class:graph-mode--active={scope === 'all'} aria-pressed={scope === 'all'} onclick={() => setScope('all')}>{language.branchGraphScopeAll}</button>
        </div>
        <button
            class="graph-mode ml-1 shrink-0 border border-darkborderc/70 bg-bgcolor/70"
            class:graph-mode--active={focusCurrentPath}
            aria-pressed={focusCurrentPath}
            onclick={() => focusCurrentPath = !focusCurrentPath}
        >
            {language.branchGraphFocusPath}
        </button>
    </div>

    {#if loading || unloadedCount > 0 || failedCount > 0 || graph.issues.length > 0}
        <div class="relative z-20 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-darkborderc/60 bg-darkbg px-3 py-1.5 text-[11px] text-textcolor2 sm:px-5">
            {#if loading}
                <span class="flex items-center gap-1.5 text-textcolor"><LoaderCircle size={13} class="animate-spin" />{language.branchGraphLoading}</span>
            {/if}
            {#if unloadedCount > 0}
                <span>{language.branchGraphUnloaded.replace('{}', unloadedCount.toString())}</span>
                {#if readBudgetLeft > 0}
                    <button class="rounded-lg border border-darkborderc bg-bgcolor px-2 py-0.5 text-textcolor transition-colors hover:border-selected disabled:opacity-50" disabled={loading} onclick={() => void loadMore()}>
                        {language.branchGraphLoadMore}
                    </button>
                {:else}
                    <span>{language.branchGraphLoadLimit}</span>
                {/if}
            {/if}
            {#if failedCount > 0}
                <span class="text-draculared">{language.branchGraphLoadFailed.replace('{}', failedCount.toString())}</span>
            {/if}
            {#if graph.issues.length > 0}
                <span class="flex items-center gap-1 text-yellow-500" title={graph.issues.map((entry) => `${entry.chatName}: ${issueLabel(entry.issue)}`).join('\n')}>
                    <TriangleAlert size={12} />
                    {language.branchGraphIssues.replace('{}', graph.issues.length.toString())}
                </span>
            {/if}
        </div>
    {/if}

    <div
        bind:this={viewport}
        class="graph-viewport relative flex-1 overflow-hidden touch-none select-none"
        class:is-panning={isPanning}
        onwheel={handleWheel}
        onpointerdown={startPan}
        onpointermove={movePan}
        onpointerup={finishPan}
        onpointercancel={finishPan}
        ondblclick={handleDblClick}
        role="application"
        aria-label={language.branchGraphTitle}
    >
        {#if graph.nodes.length === 0}
            <div class="absolute inset-0 flex items-center justify-center text-sm text-textcolor2">
                {loading ? language.branchGraphLoading : language.branchGraphEmpty}
            </div>
        {/if}
        <div
            class="graph-canvas absolute left-0 top-0 touch-none select-none"
            class:graph-canvas--zoomed-out={zoomedOut}
            class:graph-canvas--animated={canvasAnimating}
            style={`width:${graphWidth}px;height:${graphHeight}px;transform:translate3d(${panX}px,${panY}px,0) scale(${scale});`}
        >
            <svg class="pointer-events-none absolute inset-0 overflow-visible" width={graphWidth} height={graphHeight} aria-hidden="true">
                {#each visibleEdges as item (item.edge.from + '>' + item.edge.to)}
                    <path
                        class="branch-edge"
                        class:active-edge={item.edge.active}
                        class:branch-edge--branch={item.edge.kind === 'branch' && !item.edge.active}
                        class:branch-edge--muted={focusCurrentPath && !item.edge.active}
                        d={item.path}
                        fill="none"
                        stroke-width={item.edge.active ? 3 : 2}
                        stroke-dasharray={item.edge.kind === 'swipe' ? '4 6' : undefined}
                    />
                    {#if !zoomedOut && item.edge.kind !== 'swipe'}
                        <circle
                            class="branch-junction"
                            class:active-junction={item.edge.active}
                            class:branch-junction--muted={focusCurrentPath && !item.edge.active}
                            cx={item.x2}
                            cy={item.y2}
                            r={item.edge.active ? 5 : 4}
                        />
                    {/if}
                {/each}
            </svg>

            {#each visibleNodes as node (node.id)}
                {@const position = positions.get(node.id) ?? { left: 0, top: 0 }}
                {#if lod}
                    <div
                        class="branch-node branch-node--lod absolute z-10"
                        class:branch-node--active={node.activeTerminal}
                        class:branch-node--path={!node.activeTerminal && node.activePath}
                        class:branch-node--summary={node.kind === 'summary'}
                        class:branch-node--swipe={node.kind === 'swipe'}
                        class:branch-node--muted={focusCurrentPath && !node.activePath}
                        style={`left:${position.left}px;top:${position.top}px;width:${cardWidth}px;height:${cardHeight}px;`}
                    ></div>
                {:else}
                    <button
                        class="branch-node branch-node--selectable absolute z-10 flex flex-col overflow-hidden rounded-2xl border px-3.5 py-2.5 text-left touch-none select-none"
                        class:branch-node--active={node.activeTerminal}
                        class:branch-node--path={!node.activeTerminal && node.activePath}
                        class:branch-node--summary={node.kind === 'summary'}
                        class:branch-node--swipe={node.kind === 'swipe'}
                        class:branch-node--branch={node.kind === 'branch'}
                        class:branch-node--git={layout === 'git'}
                        class:branch-node--muted={focusCurrentPath && !node.activePath}
                        style={`left:${position.left}px;top:${position.top}px;width:${cardWidth}px;height:${cardHeight}px;`}
                        aria-current={node.activeTerminal ? 'true' : undefined}
                        onclick={() => selectNode(node)}
                    >
                        {#if node.kind === 'summary'}
                            <div class="flex w-full items-center gap-2">
                                <span class="flex size-6 shrink-0 items-center justify-center rounded-lg border border-dashed border-textcolor2/40 bg-textcolor/5 text-textcolor2">
                                    <Ellipsis size={15} />
                                </span>
                                <span class="text-xs font-bold text-textcolor">
                                    {language.branchGraphCollapsedMessages.replace('{}', node.foldedIds.length.toString())}
                                </span>
                                {#if node.rerolledCount > 0}
                                    <span class="flex items-center gap-0.5 text-[10px] text-textcolor2"><Repeat size={10} />{language.branchGraphRerolledCount.replace('{}', node.rerolledCount.toString())}</span>
                                {/if}
                                <span class="ml-auto shrink-0 text-[10px] tabular-nums text-textcolor2">
                                    {language.branchGraphCollapsedRange.replace('{}', (node.messageIndex + 1).toString()).replace('{}', (node.endMessageIndex + 1).toString())}
                                </span>
                            </div>
                            <div class="mt-1.5 flex min-h-0 w-full flex-1 flex-col justify-center gap-0.5 text-[10px] leading-4 text-textcolor2">
                                <div class="truncate">{node.preview || language.branchGraphNoText}</div>
                                <div class="flex items-center gap-2 text-textcolor2/45"><span class="h-px flex-1 bg-textcolor2/20"></span>{language.branchGraphExpand}<span class="h-px flex-1 bg-textcolor2/20"></span></div>
                                <div class="truncate">{node.endPreview || language.branchGraphNoText}</div>
                            </div>
                        {:else if node.kind === 'root' || node.kind === 'branch'}
                            <div class="flex w-full min-w-0 items-center gap-2">
                                <span class="flex shrink-0 items-center gap-1 rounded-full border border-selected/70 bg-selected/20 px-2 py-0.5 text-[10px] font-bold text-textcolor">
                                    {#if node.kind === 'branch'}<GitBranch size={11} />{/if}
                                    {node.kind === 'root' ? language.branchGraphGreeting : language.branch}
                                </span>
                                <span class="min-w-0 truncate text-xs font-semibold text-textcolor" title={node.chatName}>{node.chatName}</span>
                                {#if node.activeTerminal}
                                    <span class="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-bold text-green-500">
                                        <span class="size-1.5 rounded-full bg-green-500"></span>{language.branchGraphActive}
                                    </span>
                                {/if}
                            </div>
                            <div class="mt-1.5 line-clamp-2 w-full text-xs leading-4 text-textcolor2">
                                {#if node.kind === 'branch'}
                                    {language.branchGraphBranchedFrom.replace('{}', node.preview)}
                                {:else}
                                    {node.preview || language.branchGraphNoText}
                                {/if}
                            </div>
                            {#if node.issue}
                                <div class="mt-auto flex w-full items-center gap-1 truncate text-[10px] text-yellow-500">
                                    <TriangleAlert size={11} class="shrink-0" /><span class="truncate">{issueLabel(node.issue)}</span>
                                </div>
                            {/if}
                        {:else}
                            <div class="flex w-full min-w-0 items-center gap-1.5">
                                {#if node.kind === 'swipe'}
                                    <span class="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-textcolor2/50 px-2 py-0.5 text-[10px] font-bold text-textcolor2">
                                        <Repeat size={10} />{language.branchGraphSwipe.replace('{}', (node.swipeIndex + 1).toString()).replace('{}', node.swipeCount.toString())}
                                    </span>
                                {:else}
                                    <span class="flex shrink-0 items-center gap-1 rounded-full border border-selected/70 bg-selected/20 px-2 py-0.5 text-[10px] font-bold text-textcolor2">
                                        <span class="size-1.5 rounded-full" class:bg-green-500={node.role === 'char' && !node.isComment} class:bg-textcolor2={node.role === 'user' || node.isComment}></span>
                                        {roleLabel(node)}
                                    </span>
                                {/if}
                                <span class="shrink-0 text-[10px] tabular-nums text-textcolor2">#{node.messageIndex + 1}</span>
                                {#if node.kind === 'message' && node.swipeCount > 1}
                                    <span class="flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-textcolor2" title={node.hiddenSwipes > 0 ? language.branchGraphHiddenSwipes.replace('{}', node.hiddenSwipes.toString()) : undefined}>
                                        <Repeat size={10} />{node.swipeIndex + 1}/{node.swipeCount}
                                    </span>
                                {/if}
                                {#if node.forkCount > 1}
                                    <span class="flex shrink-0 items-center gap-0.5 rounded-full border border-selected bg-selected/30 px-1.5 py-0.5 text-[10px] font-bold text-textcolor">
                                        <GitBranch size={10} />{language.branchGraphForkCount.replace('{}', node.forkCount.toString())}
                                    </span>
                                {/if}
                                {#if node.activeTerminal}
                                    <span class="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-bold text-green-500">
                                        <span class="size-1.5 rounded-full bg-green-500"></span>{language.branchGraphActive}
                                    </span>
                                {/if}
                            </div>
                            <div class="mt-1.5 line-clamp-2 w-full text-xs leading-4 text-textcolor" class:italic={node.isComment}>
                                {#if node.isLink}
                                    {language.branchGraphBranchedFrom.replace('{}', node.preview)}
                                {:else}
                                    {node.preview || language.branchGraphNoText}
                                {/if}
                            </div>
                            <div class="mt-auto flex min-h-4 w-full items-end gap-2 text-[10px] text-textcolor2">
                                {#if node.model}<span class="truncate" title={node.model}>{node.model}</span>{/if}
                                {#if node.terminalCount > 0}
                                    <span class="ml-auto max-w-[60%] shrink-0 truncate font-semibold" class:text-green-500={node.activeTerminal} title={node.chatName}>{node.chatName}</span>
                                {/if}
                            </div>
                        {/if}
                    </button>
                {/if}
            {/each}
        </div>

        <div class="pointer-events-none absolute left-1/2 z-30 -translate-x-1/2" style="bottom: max(env(safe-area-inset-bottom), 1rem)">
            <div class="pointer-events-auto flex items-center gap-1 rounded-2xl border border-darkborderc/80 bg-darkbg/90 p-1.5 text-textcolor2 shadow-2xl backdrop-blur-sm">
                <button class="graph-tool" onclick={() => zoomFromCenter(1 / 1.16)} title={language.branchGraphZoomOut} aria-label={language.branchGraphZoomOut}>
                    <ZoomOut size={17} />
                </button>
                <span class="min-w-12 px-1 text-center text-[11px] font-bold tabular-nums text-textcolor">{Math.round(scale * 100)}%</span>
                <button class="graph-tool" onclick={() => zoomFromCenter(1.16)} title={language.branchGraphZoomIn} aria-label={language.branchGraphZoomIn}>
                    <ZoomIn size={17} />
                </button>
                <span class="mx-1 h-5 w-px bg-darkborderc/70"></span>
                <button class="graph-tool" onclick={() => { hasInteracted = true; fitGraph() }} title={language.branchGraphFit} aria-label={language.branchGraphFit}>
                    <Maximize size={17} />
                </button>
                {#if activeNode}
                    <button class="graph-tool" onclick={focusActive} title={language.branchGraphFocusActive} aria-label={language.branchGraphFocusActive}>
                        <LocateFixed size={17} />
                    </button>
                {/if}
            </div>
        </div>

        <div class="pointer-events-none absolute bottom-5 right-5 hidden rounded-full border border-darkborderc/60 bg-darkbg/70 px-3 py-1.5 text-[11px] text-textcolor2 lg:block">
            {language.branchGraphHint}
        </div>
    </div>
</div>

<style>
    .graph-display-bar {
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
    }

    .graph-display-bar::-webkit-scrollbar {
        display: none;
    }

    .graph-mode {
        white-space: nowrap;
        border-radius: 0.6rem;
        padding: 0.35rem 0.65rem;
        color: var(--risu-theme-textcolor2);
        transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
    }

    @media (max-width: 640px) {
        .graph-mode {
            padding: 0.28rem 0.55rem;
            font-size: 0.72rem;
        }
    }

    .graph-mode:hover {
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-selected) 42%, transparent);
    }

    .graph-mode--active {
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-selected) 72%, transparent);
        border-color: color-mix(in srgb, var(--risu-theme-selected) 72%, var(--risu-theme-darkborderc));
    }

    .graph-viewport {
        cursor: grab;
        background-color: var(--risu-theme-bgcolor);
        background-image:
            radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--risu-theme-selected) 25%, transparent) 0, transparent 42%),
            radial-gradient(color-mix(in srgb, var(--risu-theme-textcolor2) 18%, transparent) 1px, transparent 1px);
        background-size: auto, 22px 22px;
    }

    .graph-viewport.is-panning {
        cursor: grabbing;
    }

    .graph-canvas {
        transform-origin: 0 0;
        will-change: transform;
    }

    .graph-canvas--animated {
        transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);
    }

    .graph-canvas--zoomed-out .branch-node {
        box-shadow: none;
    }

    .branch-edge {
        stroke: color-mix(in srgb, var(--risu-theme-textcolor2) 48%, transparent);
    }

    .branch-edge--branch {
        stroke: color-mix(in srgb, var(--risu-theme-selected) 80%, var(--risu-theme-textcolor2));
    }

    .branch-edge.active-edge {
        stroke: #22c55e;
    }

    .branch-junction {
        fill: var(--risu-theme-bgcolor);
        stroke: color-mix(in srgb, var(--risu-theme-textcolor2) 65%, transparent);
        stroke-width: 2px;
    }

    .branch-junction.active-junction {
        fill: #22c55e;
        stroke: color-mix(in srgb, #22c55e 35%, var(--risu-theme-bgcolor));
    }

    .branch-edge--muted,
    .branch-junction--muted {
        opacity: 0.16;
    }

    .branch-node {
        cursor: default;
        border-color: color-mix(in srgb, var(--risu-theme-darkborderc) 85%, transparent);
        background: linear-gradient(145deg,
            color-mix(in srgb, var(--risu-theme-darkbg) 94%, var(--risu-theme-textcolor) 6%),
            color-mix(in srgb, var(--risu-theme-bgcolor) 92%, var(--risu-theme-selected) 8%));
        box-shadow: 0 12px 28px rgb(0 0 0 / 0.2), inset 0 1px 0 color-mix(in srgb, var(--risu-theme-textcolor) 7%, transparent);
        transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease, opacity 160ms ease;
    }

    .branch-node--git {
        border-left-width: 3px;
        border-radius: 0.8rem;
    }

    .branch-node--muted {
        opacity: 0.2;
    }

    .branch-node--selectable {
        cursor: pointer;
    }

    .branch-node--selectable:hover {
        z-index: 20;
        transform: translateY(-2px);
        border-color: color-mix(in srgb, var(--risu-theme-textcolor2) 70%, var(--risu-theme-darkborderc));
    }

    .branch-node--summary {
        border-style: dashed;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 76%, transparent);
        box-shadow: none;
    }

    .branch-node--swipe {
        border-style: dashed;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 88%, transparent);
        box-shadow: none;
    }

    .branch-node--branch {
        border-color: color-mix(in srgb, var(--risu-theme-selected) 80%, var(--risu-theme-darkborderc));
    }

    .branch-node--path {
        border-color: color-mix(in srgb, #22c55e 38%, var(--risu-theme-darkborderc));
    }

    .branch-node--active {
        border-color: #22c55e;
        box-shadow: 0 14px 36px rgb(34 197 94 / 0.16), 0 0 0 2px rgb(34 197 94 / 0.3);
    }

    /* LOD blocks: one flat rect per node, no transitions. */
    .branch-node--lod {
        border: 1px solid color-mix(in srgb, var(--risu-theme-darkborderc) 85%, transparent);
        background: color-mix(in srgb, var(--risu-theme-bgcolor) 92%, var(--risu-theme-selected) 8%);
        border-radius: 6px;
        box-shadow: none;
        transition: none;
    }

    .branch-node--lod.branch-node--path {
        background: color-mix(in srgb, #22c55e 20%, var(--risu-theme-bgcolor));
    }

    .branch-node--lod.branch-node--active {
        background: #22c55e;
    }

    .branch-node--lod.branch-node--summary,
    .branch-node--lod.branch-node--swipe {
        border-style: dashed;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 76%, transparent);
    }

    .graph-tool {
        display: flex;
        width: 2.25rem;
        height: 2.25rem;
        align-items: center;
        justify-content: center;
        border-radius: 0.65rem;
        transition: color 140ms ease, background-color 140ms ease;
    }

    .graph-tool:hover {
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-selected) 65%, transparent);
    }
</style>
