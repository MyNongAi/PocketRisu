<script lang="ts" module>
    import type { Component } from 'svelte'

    const moduleCache = new Map<() => Promise<any>, Component<any>>()

    export function preloadLazy(loader: () => Promise<{ default: Component<any> }>) {
        if (moduleCache.has(loader)) return
        void loader().then((module) => {
            moduleCache.set(loader, module.default)
        }).catch((error) => {
            console.error('Failed to preload component', error)
        })
    }
</script>

<script lang="ts">
    interface Props {
        loader: () => Promise<{ default: Component<any> }>
        props?: Record<string, unknown>
        /** The component covers the screen once loaded (a manager, a picker):
         *  while its code loads, a small notice floats in the middle instead
         *  of a placeholder in the page layout. In App's row that placeholder
         *  took half the width beside the chat, then vanished (the user's
         *  report, 2026-10-09, character manager). */
        overlay?: boolean
    }

    let { loader, props = {}, overlay = false }: Props = $props()
    let cachedComponent = $derived(moduleCache.get(loader) ?? null)
    let Loaded = $state<Component<any> | null>(null)

    $effect(() => {
        let active = true
        if (cachedComponent) {
            Loaded = cachedComponent
            return
        }
        void loader().then((module) => {
            moduleCache.set(loader, module.default)
            if (active) Loaded = module.default
        }).catch((error) => {
            console.error('Failed to load component', error)
        })
        return () => { active = false }
    })
</script>

{#if Loaded || cachedComponent}
    {@const CurrentComponent = Loaded || cachedComponent}
    <CurrentComponent {...props} />
{:else if overlay}
    <div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center" aria-live="polite">
        <span class="rounded-full bg-darkbg/90 px-4 py-2 text-sm text-textcolor2 shadow-lg">Loading…</span>
    </div>
{:else}
    <div class="flex min-h-16 w-full items-center justify-center text-sm text-textcolor2" aria-live="polite">
        Loading…
    </div>
{/if}
