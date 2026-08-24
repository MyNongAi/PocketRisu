<script lang="ts" generics="T">
    import type { Snippet } from 'svelte'
    import { virtualWindow } from './virtualWindow'

    interface Props {
        items: T[]
        itemHeight: number
        overscan?: number
        className?: string
        key?: (item: T, index: number) => string | number
        children: Snippet<[T, number]>
    }

    let {
        items,
        itemHeight,
        overscan = 4,
        className = '',
        key = (_item: T, index: number) => index,
        children,
    }: Props = $props()
    let viewport: HTMLDivElement | null = $state(null)
    let scrollTop = $state(0)
    let viewportHeight = $state(0)
    const range = $derived(virtualWindow(items.length, itemHeight, scrollTop, viewportHeight, overscan))
    const visible = $derived(items.slice(range.start, range.end))

    $effect(() => {
        const element = viewport
        if (!element) return
        const update = () => { viewportHeight = element.clientHeight }
        update()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(update)
        observer.observe(element)
        return () => observer.disconnect()
    })

    $effect(() => {
        if (!viewport) return
        const maxScroll = Math.max(0, range.total - viewportHeight)
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
    <div class="relative w-full" style={`height:${range.total}px`}>
        <div class="absolute inset-x-0 top-0" style={`transform:translateY(${range.offset}px)`}>
            {#each visible as item, offset (key(item, range.start + offset))}
                <div style={`height:${itemHeight}px;overflow:hidden`}>
                    {@render children(item, range.start + offset)}
                </div>
            {/each}
        </div>
    </div>
</div>
