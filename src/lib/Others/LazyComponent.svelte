<script lang="ts" module>
    import type { Component } from 'svelte'

    const moduleCache = new Map<() => Promise<any>, Component<any>>()

    export function preloadLazy(loader: () => Promise<{ default: Component<any> }>) {
        if(moduleCache.has(loader)) return
        loader().then((module) => {
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
    let Loaded = $state<Component<any> | null>(null)

    $effect(() => {
        let active = true
        const cached = moduleCache.get(loader)
        if(cached) {
            Loaded = cached
            return
        }
        loader().then((module) => {
            moduleCache.set(loader, module.default)
            if(active) Loaded = module.default
        }).catch((error) => {
            console.error('Failed to load component', error)
        })
        return () => { active = false }
    })
</script>

{#if Loaded}
    {@const CurrentComponent = Loaded}
    <CurrentComponent {...props} />
{/if}
