<script lang="ts" generics="T">
    import type { Snippet } from 'svelte'
    import { virtualGridLayout, virtualWindow } from './virtualWindow'

    interface Props {
        items: T[]
        minItemWidth?: number
        gap?: number
        aspectRatio?: number
        overscanRows?: number
        className?: string
        key?: (item: T, index: number) => string | number
        children: Snippet<[T, number]>
    }

    let {
        items,
        minItemWidth = 140,
        gap = 12,
        aspectRatio = 1,
        overscanRows = 2,
        className = '',
        key = (_item: T, index: number) => index,
        children,
    }: Props = $props()
    let viewport: HTMLDivElement | null = $state(null)
    let width = $state(1)
    let height = $state(0)
    let scrollTop = $state(0)
    const layout = $derived(virtualGridLayout(width, minItemWidth, gap, aspectRatio))
    const rowCount = $derived(Math.ceil(items.length / layout.columns))
    const rows = $derived(virtualWindow(rowCount, layout.rowExtent, scrollTop, height, overscanRows))
    const startIndex = $derived(rows.start * layout.columns)
    const endIndex = $derived(Math.min(items.length, rows.end * layout.columns))
    const visible = $derived(items.slice(startIndex, endIndex))

    $effect(() => {
        const element = viewport
        if (!element) return
        const update = () => {
            width = Math.max(1, element.clientWidth)
            height = element.clientHeight
        }
        update()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(update)
        observer.observe(element)
        return () => observer.disconnect()
    })

    $effect(() => {
        if (!viewport) return
        const totalHeight = Math.max(0, rowCount * layout.rowExtent - gap)
        const maxScroll = Math.max(0, totalHeight - height)
        if (viewport.scrollTop > maxScroll) {
            viewport.scrollTop = maxScroll
            scrollTop = maxScroll
        }
    })
</script>

<div
    bind:this={viewport}
    class={`overflow-y-auto overflow-x-hidden ${className}`}
    onscroll={() => { if (viewport) scrollTop = viewport.scrollTop }}
>
    <div class="relative w-full" style={`height:${Math.max(0, rowCount * layout.rowExtent - gap)}px`}>
        {#each visible as item, offset (key(item, startIndex + offset))}
            {@const index = startIndex + offset}
            {@const column = index % layout.columns}
            {@const row = Math.floor(index / layout.columns)}
            <div
                class="absolute"
                style={`left:${column * (layout.itemWidth + gap)}px;top:${row * layout.rowExtent}px;width:${layout.itemWidth}px;height:${layout.itemHeight}px`}
            >
                {@render children(item, index)}
            </div>
        {/each}
    </div>
</div>
