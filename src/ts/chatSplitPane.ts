import { writable } from 'svelte/store'

const OPEN_KEY = 'pocketrisu:split-chat:open'
const WIDTH_KEY = 'pocketrisu:split-chat:width'
const EMBEDDED_PANE_PARAM = 'pocketrisuPane'

export const isEmbeddedRisuPane = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get(EMBEDDED_PANE_PARAM) === 'secondary'

export function getSecondaryRisuPaneUrl(): string {
    if (typeof window === 'undefined') return '/?pocketrisuPane=secondary'
    const url = new URL(window.location.href)
    url.searchParams.set(EMBEDDED_PANE_PARAM, 'secondary')
    url.hash = ''
    return url.toString()
}

function readBoolean(key: string, fallback: boolean): boolean {
    if (typeof localStorage === 'undefined') return fallback
    try {
        const value = localStorage.getItem(key)
        return value === null ? fallback : value === 'true'
    } catch {
        return fallback
    }
}

function readNumber(key: string, fallback: number): number {
    if (typeof localStorage === 'undefined') return fallback
    try {
        const value = Number(localStorage.getItem(key))
        return Number.isFinite(value) ? value : fallback
    } catch {
        return fallback
    }
}

function persist(key: string, value: string) {
    if (typeof localStorage === 'undefined') return
    try {
        localStorage.setItem(key, value)
    } catch {
        // A denied/private localStorage must not break chat rendering.
    }
}

export interface SplitWidthBounds {
    min: number
    max: number
}

export function getSplitWidthBounds(viewportWidth: number): SplitWidthBounds {
    const safeViewportWidth = Math.max(0, viewportWidth)
    const preferredMinimum = Math.min(280, Math.max(160, safeViewportWidth * 0.18))
    const min = Math.min(preferredMinimum, safeViewportWidth / 2)
    return {
        min: Math.round(min),
        max: Math.round(Math.max(min, safeViewportWidth - min)),
    }
}

export function clampSplitWidth(width: number, viewportWidth: number): number {
    const bounds = getSplitWidthBounds(viewportWidth)
    return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)))
}

export const splitChatOpen = writable(readBoolean(OPEN_KEY, false))
export const splitChatWidth = writable(readNumber(WIDTH_KEY, 520))

splitChatOpen.subscribe((value) => persist(OPEN_KEY, String(value)))
splitChatWidth.subscribe((value) => persist(WIDTH_KEY, String(Math.round(value))))

export function toggleSplitChat() {
    splitChatOpen.update((value) => !value)
}
