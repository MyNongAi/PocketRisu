import type { Component } from 'svelte'

type ComponentModule = { default: Component<any> }

export function createCachedLoader<T>(loader: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | undefined
    return () => {
        if(!pending) {
            pending = loader().catch((error) => {
                pending = undefined
                throw error
            })
        }
        return pending
    }
}

export const loadCharConfig = createCachedLoader<ComponentModule>(
    () => import('./CharConfig.svelte'),
)

export const loadSideChatList = createCachedLoader<ComponentModule>(
    () => import('./SideChatList.svelte'),
)

export const loadDevTool = createCachedLoader<ComponentModule>(
    () => import('./DevTool.svelte'),
)

export const loadQuickSettings = createCachedLoader<ComponentModule>(
    () => import('../Others/QuickSettingsGUI.svelte'),
)

export async function preloadChatSidebarPanel(): Promise<void> {
    await loadSideChatList().catch(() => undefined)
}

export async function preloadCharacterSidebarPanel(): Promise<void> {
    await loadCharConfig().catch(() => undefined)
}
