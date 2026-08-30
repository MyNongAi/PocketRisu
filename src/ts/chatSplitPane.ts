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

export function clampSplitWidth(width: number, viewportWidth: number): number {
    const minWidth = Math.min(320, Math.max(240, viewportWidth * 0.32))
    const maxWidth = Math.max(minWidth, viewportWidth - 360)
    return Math.round(Math.min(maxWidth, Math.max(minWidth, width)))
}

export const splitChatOpen = writable(readBoolean(OPEN_KEY, false))
export const splitChatWidth = writable(readNumber(WIDTH_KEY, 520))

splitChatOpen.subscribe((value) => persist(OPEN_KEY, String(value)))
splitChatWidth.subscribe((value) => persist(WIDTH_KEY, String(Math.round(value))))

export function toggleSplitChat() {
    splitChatOpen.update((value) => !value)
}
