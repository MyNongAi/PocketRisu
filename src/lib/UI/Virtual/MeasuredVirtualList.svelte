<script lang="ts" generics="T">
    import { onDestroy, tick, untrack, type Snippet } from 'svelte'
    import {
        buildVariableVirtualLayout,
        captureVariableScrollAnchor,
        clampVariableScroll,
        restoreVariableScrollAnchor,
        variableVirtualWindow,
        type VariableVirtualLayout,
    } from './variableVirtualWindow'

    interface Props {
        items: T[]
        estimatedItemHeight?: number
        /** Overscan in estimated rows, converted to a bounded pixel margin. */
        overscan?: number
        /** Rendering every row is cheaper for small catalogs. */
        smallListThreshold?: number
        className?: string
        ariaLabel?: string
        /** Changing this value intentionally returns the catalog to its top. */
        resetKey?: string | number
        /** Optional imperative-style target driven by a changing request key. */
        scrollToIndex?: number | null
        scrollRequestKey?: string | number
        key: (item: T, index: number) => string | number
        children: Snippet<[T, number]>
    }

    interface VirtualRecord<T> {
        item: T
        index: number
        key: string
    }

    const DEFAULT_ESTIMATED_ITEM_HEIGHT = 84

    let {
        items,
        estimatedItemHeight = DEFAULT_ESTIMATED_ITEM_HEIGHT,
        overscan = 4,
        smallListThreshold = 30,
        className = '',
        ariaLabel = '',
        resetKey,
        scrollToIndex = null,
        scrollRequestKey,
        key,
        children,
    }: Props = $props()

    let viewport: HTMLDivElement | null = $state(null)
    let records: VirtualRecord<T>[] = $state([])
    let layout: VariableVirtualLayout = $state(buildVariableVirtualLayout([], new Map(), DEFAULT_ESTIMATED_ITEM_HEIGHT))
    let scrollTop = $state(0)
    let viewportHeight = $state(0)
    const measuredHeights = new Map<string, number>()
    const pendingMeasurements = new Map<string, number>()
    let measurementFlushQueued = false
    let scrollAdjustmentGeneration = 0
    let destroyed = false
    let resetKeyInitialized = false
    let previousResetKey: string | number | undefined
    let scrollRequestInitialized = false
    let previousScrollRequestKey: string | number | undefined

    const plainList = $derived(records.length <= Math.max(0, Math.floor(smallListThreshold)))
    const range = $derived(variableVirtualWindow(
        layout,
        scrollTop,
        viewportHeight,
        Math.max(0, overscan) * Math.max(1, estimatedItemHeight),
    ))
    const visibleRecords = $derived(records.slice(range.start, range.end))

    function uniqueRecords(source: T[]) {
        const duplicateCounts = new Map<string, number>()
        return source.map((item, index) => {
            const rawKey = key(item, index)
            const baseKey = `${typeof rawKey}:${String(rawKey)}`
            const duplicateIndex = duplicateCounts.get(baseKey) ?? 0
            duplicateCounts.set(baseKey, duplicateIndex + 1)
            return {
                item,
                index,
                // A caller should provide unique keys. This defensive suffix
                // prevents malformed legacy data from crashing a keyed each.
                key: duplicateIndex === 0 ? baseKey : `${baseKey}\u0000${duplicateIndex}`,
            }
        })
    }

    function scheduleScrollAdjustment(target: number) {
        const generation = ++scrollAdjustmentGeneration
        scrollTop = target
        void tick().then(() => {
            if(destroyed || generation !== scrollAdjustmentGeneration || !viewport) return
            if(Math.abs(viewport.scrollTop - target) > 0.5) viewport.scrollTop = target
            scrollTop = viewport.scrollTop
        })
    }

    function replaceRecords(nextRecords: VirtualRecord<T>[], resetScroll = false) {
        const oldLayout = layout
        const currentScroll = viewport?.scrollTop ?? scrollTop
        const sameKeys = records.length === nextRecords.length
            && records.every((record, index) => record.key === nextRecords[index].key)

        records = nextRecords
        if(sameKeys) return

        const anchor = resetScroll
            ? null
            : captureVariableScrollAnchor(oldLayout, currentScroll, oldLayout.keys.length)
        const nextLayout = buildVariableVirtualLayout(
            nextRecords.map((record) => record.key),
            measuredHeights,
            estimatedItemHeight,
        )
        layout = nextLayout
        scheduleScrollAdjustment(restoreVariableScrollAnchor(
            anchor,
            nextLayout,
            viewportHeight,
            0,
        ))
    }

    function rebuildMeasuredLayout() {
        const oldLayout = layout
        const currentScroll = viewport?.scrollTop ?? scrollTop
        const anchor = captureVariableScrollAnchor(oldLayout, currentScroll, 0)
        const nextLayout = buildVariableVirtualLayout(
            records.map((record) => record.key),
            measuredHeights,
            estimatedItemHeight,
        )
        layout = nextLayout
        scheduleScrollAdjustment(restoreVariableScrollAnchor(
            anchor,
            nextLayout,
            viewportHeight,
            currentScroll,
        ))
    }

    function flushMeasurements() {
        measurementFlushQueued = false
        if(destroyed || pendingMeasurements.size === 0) return

        let changed = false
        for(const [itemKey, height] of pendingMeasurements){
            if(!Number.isFinite(height) || height <= 0) continue
            const previous = measuredHeights.get(itemKey)
            if(previous === undefined || Math.abs(previous - height) > 0.5){
                measuredHeights.set(itemKey, height)
                changed = true
            }
        }
        pendingMeasurements.clear()
        if(changed) rebuildMeasuredLayout()
    }

    function queueMeasurement(itemKey: string, height: number) {
        if(!Number.isFinite(height) || height <= 0) return
        pendingMeasurements.set(itemKey, height)
        if(measurementFlushQueued) return
        measurementFlushQueued = true
        queueMicrotask(flushMeasurements)
    }

    function observedBlockSize(entry: ResizeObserverEntry, node: HTMLElement) {
        // Older Safari exposed a single ResizeObserverSize while the modern
        // DOM type is an array, so normalize both runtime shapes explicitly.
        const borderBox: unknown = entry.borderBoxSize
        if(Array.isArray(borderBox) && borderBox[0]?.blockSize) return Number(borderBox[0].blockSize)
        if(borderBox && typeof borderBox === 'object' && 'blockSize' in borderBox){
            return Number((borderBox as { blockSize: number }).blockSize)
        }
        return node.getBoundingClientRect().height
    }

    function measureRow(node: HTMLElement, initialKey: string) {
        let itemKey = initialKey
        const measureNow = () => queueMeasurement(itemKey, node.getBoundingClientRect().height)
        let observer: ResizeObserver | null = null

        measureNow()
        if(typeof ResizeObserver !== 'undefined'){
            observer = new ResizeObserver((entries) => {
                const entry = entries.find((candidate) => candidate.target === node) ?? entries[0]
                if(entry) queueMeasurement(itemKey, observedBlockSize(entry, node))
            })
            observer.observe(node)
        }

        return {
            update(nextKey: string) {
                itemKey = nextKey
                measureNow()
            },
            destroy() {
                observer?.disconnect()
            },
        }
    }

    function setScroll(nextScroll: number) {
        if(!viewport) return
        const target = plainList
            ? Math.max(0, Math.min(nextScroll, Math.max(0, viewport.scrollHeight - viewportHeight)))
            : clampVariableScroll(layout, nextScroll, viewportHeight)
        viewport.scrollTop = target
        scrollTop = viewport.scrollTop
    }

    function handleKeyboard(event: KeyboardEvent) {
        if(event.target !== viewport) return
        let target: number | null = null
        switch(event.key){
            case 'Home': target = 0; break
            case 'End': target = plainList && viewport ? viewport.scrollHeight : layout.total; break
            case 'PageUp': target = scrollTop - viewportHeight; break
            case 'PageDown': target = scrollTop + viewportHeight; break
            case 'ArrowUp': target = scrollTop - 40; break
            case 'ArrowDown': target = scrollTop + 40; break
        }
        if(target === null) return
        event.preventDefault()
        setScroll(target)
    }

    function revealIndex(index: number) {
        if(!viewport || records.length === 0) return
        const targetIndex = Math.max(0, Math.min(Math.floor(index), records.length - 1))
        if(plainList){
            void tick().then(() => {
                const target = viewport?.querySelector(`[data-virtual-index="${targetIndex}"]`) as HTMLElement | null
                target?.scrollIntoView({ block: 'nearest' })
                if(viewport) scrollTop = viewport.scrollTop
            })
            return
        }
        const start = layout.offsets[targetIndex] ?? 0
        const end = layout.offsets[targetIndex + 1] ?? start + estimatedItemHeight
        if(start < scrollTop) setScroll(start)
        else if(end > scrollTop + viewportHeight) setScroll(end - viewportHeight)
    }

    $effect(() => {
        const source = items
        const currentResetKey = resetKey
        const nextRecords = uniqueRecords(source)
        untrack(() => {
            const shouldReset = resetKeyInitialized && currentResetKey !== previousResetKey
            previousResetKey = currentResetKey
            resetKeyInitialized = true
            replaceRecords(nextRecords, shouldReset)
        })
    })

    $effect(() => {
        const requestKey = scrollRequestKey
        const targetIndex = scrollToIndex
        const ready = viewport && records.length > 0
        if(!ready || targetIndex === null || targetIndex === undefined) return
        untrack(() => {
            const changed = scrollRequestInitialized && requestKey !== previousScrollRequestKey
            const firstRequest = !scrollRequestInitialized
            previousScrollRequestKey = requestKey
            scrollRequestInitialized = true
            if(firstRequest || changed) revealIndex(targetIndex)
        })
    })

    $effect(() => {
        const element = viewport
        if(!element) return

        const update = () => {
            viewportHeight = Math.max(0, element.clientHeight)
            const nextScroll = plainList
                ? Math.max(0, Math.min(element.scrollTop, Math.max(0, element.scrollHeight - viewportHeight)))
                : clampVariableScroll(layout, element.scrollTop, viewportHeight)
            if(Math.abs(element.scrollTop - nextScroll) > 0.5) element.scrollTop = nextScroll
            scrollTop = element.scrollTop
        }
        update()
        if(typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(update)
        observer.observe(element)
        return () => observer.disconnect()
    })

    onDestroy(() => {
        destroyed = true
        scrollAdjustmentGeneration += 1
        pendingMeasurements.clear()
    })
</script>

<!-- The named scroll region is intentionally focusable so keyboard-only users
     can use Home/End/Page/Arrow navigation without entering a row control. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
    bind:this={viewport}
    class={`overflow-y-auto overflow-x-hidden ${className}`}
    role="region"
    aria-label={ariaLabel || undefined}
    tabindex="0"
    data-measured-virtual-list
    data-virtual-mode={plainList ? 'plain' : 'windowed'}
    onscroll={() => { if(viewport) scrollTop = viewport.scrollTop }}
    onkeydown={handleKeyboard}
>
    {#if plainList}
        <div role="list" class="w-full shrink-0">
            {#each records as record (record.key)}
                <div role="listitem" data-virtual-key={record.key} data-virtual-index={record.index}>
                    {@render children(record.item, record.index)}
                </div>
            {/each}
        </div>
    {:else}
        <div role="list" class="relative w-full shrink-0" style={`height:${range.total}px`} data-virtual-total={range.total}>
            <div class="absolute inset-x-0 top-0" style={`transform:translateY(${range.offset}px)`}>
                {#each visibleRecords as record (record.key)}
                    <div
                        use:measureRow={record.key}
                        role="listitem"
                        aria-setsize={records.length}
                        aria-posinset={record.index + 1}
                        data-virtual-key={record.key}
                        data-virtual-index={record.index}
                    >
                        {@render children(record.item, record.index)}
                    </div>
                {/each}
            </div>
        </div>
    {/if}
</div>
