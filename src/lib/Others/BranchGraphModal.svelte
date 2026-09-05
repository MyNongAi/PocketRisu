<script lang="ts">
    import { onMount, tick } from 'svelte'
    import { GitBranch, Maximize, ZoomIn, ZoomOut, XIcon } from '@lucide/svelte'

    import { language } from 'src/lang'
    import { buildChatGraphGitLanes, getChatBranches, type ChatGraphDensity } from 'src/ts/gui/branches'

    interface Props {
        onselect: (chatIndex: number) => void | Promise<void>
        onclose: () => void
    }

    let { onselect, onclose }: Props = $props()

    type GraphLayout = 'tree' | 'timeline' | 'git'

    const padding = 64
    const minScale = 0.25
    const maxScale = 1.6
    let layout = $state<GraphLayout>('tree')
    let density = $state<ChatGraphDensity>('smart')
    let focusCurrentPath = $state(false)

    const cardWidth = $derived(layout === 'git' ? 260 : 292)
    const cardHeight = $derived(layout === 'git' ? 104 : 116)
    const gapX = $derived(layout === 'git' ? 34 : 56)
    const gapY = $derived(layout === 'git' ? 34 : 64)
    const graph = $derived(getChatBranches({ density }))
    const gitLanes = $derived(buildChatGraphGitLanes(graph))
    const standardColumns = $derived(layout === 'timeline' ? graph.rows : layout === 'git' ? gitLanes.columns : graph.columns)
    const standardRows = $derived(layout === 'timeline' ? graph.columns : graph.rows)
    const graphWidth = $derived(padding * 2 + standardColumns * cardWidth + Math.max(0, standardColumns - 1) * gapX)
    const graphHeight = $derived(padding * 2 + standardRows * cardHeight + Math.max(0, standardRows - 1) * gapY)
    const activeNode = $derived(graph.nodes.find(n => n.activeTerminal) ?? [...graph.nodes].reverse().find(n => n.activePath))

    let viewport: HTMLDivElement | undefined = $state()
    let panX = $state(0)
    let panY = $state(0)
    let scale = $state(1)
    let isPanning = $state(false)
    let panPointerId: number | null = null
    let panStart = { x: 0, y: 0, panX: 0, panY: 0 }
    const touchPointers = new Map<number, { x: number; y: number }>()
    let pinchStart: { distance: number; graphX: number; graphY: number; scale: number } | null = null
    let hasInteracted = false

    function nodePosition(node: typeof graph.nodes[number]) {
        if (layout === 'timeline') {
            return {
                left: padding + node.y * (cardWidth + gapX),
                top: padding + node.x * (cardHeight + gapY),
            }
        }
        if (layout === 'git') {
            const lane = gitLanes.laneByNodeId.get(node.id) ?? 0
            return {
                left: padding + lane * (cardWidth + gapX),
                top: padding + node.y * (cardHeight + gapY),
            }
        }
        return {
            left: padding + node.x * (cardWidth + gapX),
            top: padding + node.y * (cardHeight + gapY),
        }
    }

    function edgeGeometry(from: typeof graph.nodes[number], to: typeof graph.nodes[number]) {
        const fromPos = nodePosition(from)
        const toPos = nodePosition(to)
        if (layout === 'timeline') {
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

    const clampScale = (v: number) => Math.min(maxScale, Math.max(minScale, v))

    function reasonLabel(reason: 'root' | 'manual' | 'reroll'): string {
        if (reason === 'root') return language.branchGraphOriginal
        if (reason === 'reroll') return language.branchGraphReroll
        return language.branch
    }

    function fitGraph(animate = true) {
        if (!viewport) return
        const inset = viewport.clientWidth < 640 ? 28 : 72
        const next = clampScale(Math.min(
            1,
            (viewport.clientWidth - inset * 2) / graphWidth,
            (viewport.clientHeight - inset * 2) / graphHeight,
        ))
        scale = next
        panX = (viewport.clientWidth - graphWidth * next) / 2
        panY = (viewport.clientHeight - graphHeight * next) / 2
        isPanning = !animate
        if (!animate) requestAnimationFrame(() => isPanning = false)
    }

    function focusActive() {
        if (!viewport || !activeNode) return
        const next = clampScale(Math.max(scale, 0.9))
        const pos = nodePosition(activeNode)
        const cx = pos.left + cardWidth / 2
        const cy = pos.top + cardHeight / 2
        scale = next
        panX = viewport.clientWidth / 2 - cx * next
        panY = viewport.clientHeight / 2 - cy * next
        hasInteracted = true
    }

    function refitAfterDisplayChange() {
        hasInteracted = false
        void tick().then(() => fitGraph(false))
    }

    function setLayout(next: GraphLayout) {
        if (layout === next) return
        layout = next
        refitAfterDisplayChange()
    }

    function setDensity(next: ChatGraphDensity) {
        if (density === next) return
        density = next
        refitAfterDisplayChange()
    }

    function selectNode(node: typeof graph.nodes[number]) {
        const terminal = node.terminals.find(t => t.active) ?? node.terminals.at(-1)
        if (!terminal) return
        const chatIndex = parseInt(terminal.branchId.replace('chat:', ''), 10)
        if (!isNaN(chatIndex)) void onselect(chatIndex)
    }

    function zoomAt(clientX: number, clientY: number, nextScale: number) {
        if (!viewport) return
        const bounds = viewport.getBoundingClientRect()
        const cursorX = clientX - bounds.left
        const cursorY = clientY - bounds.top
        const graphXPos = (cursorX - panX) / scale
        const graphYPos = (cursorY - panY) / scale
        const clamped = clampScale(nextScale)
        panX = cursorX - graphXPos * clamped
        panY = cursorY - graphYPos * clamped
        scale = clamped
        hasInteracted = true
    }

    function zoomFromCenter(factor: number) {
        if (!viewport) return
        const bounds = viewport.getBoundingClientRect()
        zoomAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, scale * factor)
    }

    function handleWheel(e: WheelEvent) {
        e.preventDefault()
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
        zoomAt(e.clientX, e.clientY, scale * factor)
    }

    function handlePointerDown(e: PointerEvent) {
        if (e.button !== 0 && e.button !== undefined) return
        touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

        if (touchPointers.size === 2) {
            const [a, b] = [...touchPointers.values()]
            const dist = Math.hypot(a.x - b.x, a.y - b.y)
            const mx = (a.x + b.x) / 2
            const my = (a.y + b.y) / 2
            if (viewport) {
                const bounds = viewport.getBoundingClientRect()
                pinchStart = {
                    distance: dist,
                    graphX: (mx - bounds.left - panX) / scale,
                    graphY: (my - bounds.top - panY) / scale,
                    scale,
                }
            }
            return
        }

        panPointerId = e.pointerId
        panStart = { x: e.clientX, y: e.clientY, panX, panY }
        isPanning = true
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }

    function handlePointerMove(e: PointerEvent) {
        touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

        if (pinchStart && touchPointers.size === 2) {
            const [a, b] = [...touchPointers.values()]
            const dist = Math.hypot(a.x - b.x, a.y - b.y)
            const mx = (a.x + b.x) / 2
            const my = (a.y + b.y) / 2
            const next = clampScale(pinchStart.scale * (dist / pinchStart.distance))
            if (viewport) {
                const bounds = viewport.getBoundingClientRect()
                panX = mx - bounds.left - pinchStart.graphX * next
                panY = my - bounds.top - pinchStart.graphY * next
                scale = next
                hasInteracted = true
            }
            return
        }

        if (e.pointerId !== panPointerId) return
        panX = panStart.panX + (e.clientX - panStart.x)
        panY = panStart.panY + (e.clientY - panStart.y)
        hasInteracted = true
    }

    function handlePointerUp(e: PointerEvent) {
        touchPointers.delete(e.pointerId)
        if (touchPointers.size < 2) pinchStart = null
        if (e.pointerId === panPointerId) {
            panPointerId = null
            isPanning = false
        }
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault()
            onclose()
        }
    }

    const nodesById = $derived(new Map(graph.nodes.map(n => [n.id, n])))

    onMount(() => {
        void tick().then(() => fitGraph(false))
    })
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="fixed inset-0 z-50 bg-black/80 flex flex-col">
    <!-- Toolbar -->
    <div class="flex items-center gap-2 p-2 bg-darkbg border-b border-darkborderc select-none flex-wrap">
        <div class="flex items-center gap-1 mr-2">
            <GitBranch size={18} class="text-textcolor2" />
            <span class="text-textcolor font-semibold text-sm">{language.branchGraphTitle}</span>
        </div>

        <div class="flex items-center gap-1 bg-darkbg2 rounded-md p-0.5">
            <button class="px-2 py-1 text-xs rounded cursor-pointer" class:bg-selected={layout === 'tree'} class:text-textcolor={layout === 'tree'} class:text-textcolor2={layout !== 'tree'} onclick={() => setLayout('tree')}>{language.branchGraphTree}</button>
            <button class="px-2 py-1 text-xs rounded cursor-pointer" class:bg-selected={layout === 'timeline'} class:text-textcolor={layout === 'timeline'} class:text-textcolor2={layout !== 'timeline'} onclick={() => setLayout('timeline')}>{language.branchGraphTimeline}</button>
            <button class="px-2 py-1 text-xs rounded cursor-pointer" class:bg-selected={layout === 'git'} class:text-textcolor={layout === 'git'} class:text-textcolor2={layout !== 'git'} onclick={() => setLayout('git')}>Git</button>
        </div>

        <div class="flex items-center gap-1 bg-darkbg2 rounded-md p-0.5">
            <button class="px-2 py-1 text-xs rounded cursor-pointer" class:bg-selected={density === 'all'} class:text-textcolor={density === 'all'} class:text-textcolor2={density !== 'all'} onclick={() => setDensity('all')}>{language.branchGraphAll}</button>
            <button class="px-2 py-1 text-xs rounded cursor-pointer" class:bg-selected={density === 'smart'} class:text-textcolor={density === 'smart'} class:text-textcolor2={density !== 'smart'} onclick={() => setDensity('smart')}>{language.branchGraphSmart}</button>
            <button class="px-2 py-1 text-xs rounded cursor-pointer" class:bg-selected={density === 'branches'} class:text-textcolor={density === 'branches'} class:text-textcolor2={density !== 'branches'} onclick={() => setDensity('branches')}>{language.branchGraphBranches}</button>
        </div>

        <div class="flex items-center gap-1 ml-auto">
            {#if graph.collapsedMessageCount > 0}
                <span class="text-textcolor2 text-xs mr-2">{graph.collapsedMessageCount} {language.branchGraphCollapsed}</span>
            {/if}
            <button class="p-1.5 rounded hover:bg-darkbg2 text-textcolor2 hover:text-textcolor cursor-pointer" onclick={() => zoomFromCenter(1.3)} title="Zoom in">
                <ZoomIn size={16} />
            </button>
            <button class="p-1.5 rounded hover:bg-darkbg2 text-textcolor2 hover:text-textcolor cursor-pointer" onclick={() => zoomFromCenter(1 / 1.3)} title="Zoom out">
                <ZoomOut size={16} />
            </button>
            <button class="p-1.5 rounded hover:bg-darkbg2 text-textcolor2 hover:text-textcolor cursor-pointer" onclick={() => fitGraph()} title="Fit">
                <Maximize size={16} />
            </button>
            {#if activeNode}
                <button class="px-2 py-1 text-xs rounded hover:bg-darkbg2 text-textcolor2 hover:text-textcolor cursor-pointer" onclick={focusActive}>{language.branchGraphFocus}</button>
            {/if}
            <button class="p-1.5 rounded hover:bg-darkbg2 text-textcolor2 hover:text-textcolor cursor-pointer ml-2" onclick={onclose}>
                <XIcon size={16} />
            </button>
        </div>
    </div>

    <!-- Graph viewport -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="flex-1 overflow-hidden cursor-grab"
        class:cursor-grabbing={isPanning}
        bind:this={viewport}
        onwheel={handleWheel}
        onpointerdown={handlePointerDown}
        onpointermove={handlePointerMove}
        onpointerup={handlePointerUp}
        onpointercancel={handlePointerUp}
        style="touch-action: none"
    >
        <div
            class="origin-top-left"
            style="transform: translate({panX}px, {panY}px) scale({scale}); width: {graphWidth}px; height: {graphHeight}px;"
            style:transition={isPanning ? 'none' : 'transform 0.25s ease-out'}
        >
            <!-- Edges -->
            <svg class="absolute inset-0 pointer-events-none" width={graphWidth} height={graphHeight}>
                {#each graph.edges as edge}
                    {@const fromNode = nodesById.get(edge.from)}
                    {@const toNode = nodesById.get(edge.to)}
                    {#if fromNode && toNode}
                        {@const geo = edgeGeometry(fromNode, toNode)}
                        <path
                            d={geo.path}
                            fill="none"
                            stroke={edge.active ? (focusCurrentPath ? 'var(--risu-primary)' : 'rgba(99,160,255,0.7)') : 'rgba(128,128,128,0.35)'}
                            stroke-width={edge.active ? 3 : 1.5}
                        />
                    {/if}
                {/each}
            </svg>

            <!-- Nodes -->
            {#each graph.nodes as node}
                {@const pos = nodePosition(node)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="absolute rounded-lg border overflow-hidden select-none"
                    class:border-selected={node.activeTerminal}
                    class:border-darkborderc={!node.activeTerminal}
                    class:bg-darkbg={!node.activePath || focusCurrentPath}
                    class:bg-darkbg2={node.activePath && !focusCurrentPath}
                    class:opacity-30={focusCurrentPath && !node.activePath}
                    style="left: {pos.left}px; top: {pos.top}px; width: {cardWidth}px; height: {cardHeight}px;"
                    onclick={() => selectNode(node)}
                    style:cursor={node.terminals.length > 0 ? 'pointer' : 'default'}
                >
                    <!-- Header -->
                    <div class="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-darkborderc">
                        {#if node.kind === 'summary'}
                            <span class="text-xs text-textcolor2">#{node.messageIndex + 1}–{node.endMessageIndex + 1}</span>
                            <span class="text-xs text-textcolor2 ml-auto">{node.collapsedCount} msgs</span>
                        {:else}
                            <span class="w-2 h-2 rounded-full flex-shrink-0"
                                class:bg-blue-400={node.role === 'user'}
                                class:bg-green-400={node.role === 'char'}
                            ></span>
                            <span class="text-xs text-textcolor2">#{node.messageIndex + 1}</span>
                            <span class="text-xs text-textcolor font-medium truncate">{node.role === 'user' ? 'User' : 'Char'}</span>
                            {#if node.model}
                                <span class="text-xs text-textcolor2 truncate ml-auto max-w-[100px]">{node.model}</span>
                            {/if}
                            {#if node.branchPoint}
                                <GitBranch size={12} class="text-yellow-400 flex-shrink-0" />
                            {/if}
                        {/if}
                    </div>

                    <!-- Body -->
                    <div class="px-2.5 py-1.5 text-xs text-textcolor2 line-clamp-3 leading-relaxed">
                        {#if node.kind === 'summary'}
                            <span class="text-textcolor2 italic">{node.preview}</span>
                        {:else}
                            {node.preview}
                        {/if}
                    </div>

                    <!-- Terminal badges -->
                    {#if node.terminals.length > 0}
                        <div class="absolute bottom-1 right-2 flex gap-1">
                            {#each node.terminals as terminal}
                                <span class="text-[10px] px-1.5 py-0.5 rounded-full"
                                    class:bg-selected={terminal.active}
                                    class:text-textcolor={terminal.active}
                                    class:bg-darkbg2={!terminal.active}
                                    class:text-textcolor2={!terminal.active}
                                >{reasonLabel(terminal.reason)}</span>
                            {/each}
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    </div>

    <!-- Footer -->
    <div class="flex items-center justify-between px-3 py-1.5 bg-darkbg border-t border-darkborderc text-xs text-textcolor2 select-none">
        <span>{graph.timelineCount} {language.branchGraphChats} · {graph.messageCount} {language.branchGraphMessages}</span>
        <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" class="accent-[var(--risu-primary)]" bind:checked={focusCurrentPath} />
            {language.branchGraphHighlightActive}
        </label>
    </div>
</div>
