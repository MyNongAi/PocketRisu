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
    }

    let { loader, props = {} }: Props = $props()
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
{:else}
    <div class="flex min-h-16 w-full items-center justify-center text-sm text-textcolor2" aria-live="polite">
        Loading…
    </div>
{/if}
