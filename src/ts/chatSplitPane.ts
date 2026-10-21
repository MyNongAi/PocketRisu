import { writable } from 'svelte/store'

const OPEN_KEY = 'pocketrisu:split-chat:open'
const WIDTH_KEY = 'pocketrisu:split-chat:width'
const HEIGHT_KEY = 'pocketrisu:split-chat:height'
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
        const raw = localStorage.getItem(key)
        // Never saved: the fallback, not Number(null)'s 0.
        if (raw === null || raw.trim() === '') return fallback
        const value = Number(raw)
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

export interface ChatRoomDragPayload {
    characterId: string
    chatId: string
}

export function serializeChatRoomDragPayload(payload: ChatRoomDragPayload): string {
    return JSON.stringify(payload)
}

export function parseChatRoomDragPayload(value: string): ChatRoomDragPayload | null {
    try {
        const parsed: unknown = JSON.parse(value)
        if (!parsed || typeof parsed !== 'object') return null
        const candidate = parsed as Partial<ChatRoomDragPayload>
        if (typeof candidate.characterId !== 'string' || !candidate.characterId.trim()) return null
        if (typeof candidate.chatId !== 'string' || !candidate.chatId.trim()) return null
        return { characterId: candidate.characterId, chatId: candidate.chatId }
    } catch {
        return null
    }
}

/**
 * The second chat's width range within `viewportWidth`, the room the two
 * chats share. `mainMinimum`: what the main chat keeps at the wide end
 * (SPLIT_MAIN_CHAT_MIN_PX docked); otherwise both keep the narrow end.
 */
export function getSplitWidthBounds(viewportWidth: number, mainMinimum = 0): SplitWidthBounds {
    const safeViewportWidth = Math.max(0, viewportWidth)
    const preferredMinimum = Math.min(280, Math.max(160, safeViewportWidth * 0.18))
    const min = Math.min(preferredMinimum, safeViewportWidth / 2)
    return {
        min: Math.round(min),
        max: Math.round(Math.max(min, safeViewportWidth - Math.max(min, mainMinimum))),
    }
}

export function clampSplitWidth(width: number, viewportWidth: number, mainMinimum = 0): number {
    const bounds = getSplitWidthBounds(viewportWidth, mainMinimum)
    return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)))
}

export const splitChatOpen = writable(readBoolean(OPEN_KEY, false))
export const splitChatWidth = writable(readNumber(WIDTH_KEY, 520))
/** The lower pane's height when the panes are stacked (splitLayout.svelte.ts orientation 'column'). */
export const splitChatHeight = writable(readNumber(HEIGHT_KEY, 360))

splitChatOpen.subscribe((value) => persist(OPEN_KEY, String(value)))
splitChatWidth.subscribe((value) => persist(WIDTH_KEY, String(Math.round(value))))
splitChatHeight.subscribe((value) => persist(HEIGHT_KEY, String(Math.round(value))))

/** The lower pane's height within `viewportHeight`, each pane keeping at least 160px. */
export function clampSplitHeight(height: number, viewportHeight: number): number {
    const min = Math.min(160, Math.max(0, viewportHeight) / 2)
    return Math.round(Math.min(Math.max(min, viewportHeight - min), Math.max(min, height)))
}

/** Divider width between the two workspaces (SplitWorkspace). */
export const SPLIT_DIVIDER_PX = 6

/** A pane's character panel in the docked row (Sidebar part="panel", w-80). */
export const SPLIT_PANEL_PX = 320
/** How narrow the panels get when the window has no room for them beside two chats. */
export const SPLIT_PANEL_MIN_PX = 200
/** What the main chat keeps beside the second pane in the docked row. */
export const SPLIT_MAIN_CHAT_MIN_PX = 320
/** Narrower than this, a split outside the docked layout stacks its two chats (both keep SPLIT_MAIN_CHAT_MIN_PX side by side). */
export const NARROW_SPLIT_PX = SPLIT_MAIN_CHAT_MIN_PX * 2 + SPLIT_DIVIDER_PX

/**
 * The second chat's width side by side outside the docked layout: the saved
 * width, with both chats keeping SPLIT_MAIN_CHAT_MIN_PX of `span`.
 */
export function looseSplitSideWidth(span: number, saved: number): number {
    const max = Math.max(SPLIT_MAIN_CHAT_MIN_PX, span - SPLIT_DIVIDER_PX - SPLIT_MAIN_CHAT_MIN_PX)
    return Math.round(Math.min(max, Math.max(SPLIT_MAIN_CHAT_MIN_PX, saved)))
}

/** The docked split side by side (SplitWorkspace). */
export interface DockedSplitRow {
    /** Both panes, the divider, and the bot list when it sits between them. */
    span: number
    /** The bot list's width when it sits between the panes, else 0. */
    rail: number
    mainPanel: boolean
    sidePanel: boolean
}

export interface DockedSplitWidths {
    mainPanel: number
    mainChat: number
    sideChat: number
    sidePanel: number
}

/** The room the two chats share in the docked row: no divider, no bot list, open panels at full width. */
export function dockedSplitChatRoom(row: DockedSplitRow): number {
    const panels = Number(row.mainPanel) + Number(row.sidePanel)
    return Math.max(0, Math.round(row.span - SPLIT_DIVIDER_PX - row.rail - panels * SPLIT_PANEL_PX))
}

/**
 * The docked row's widths with the second chat set to `sideChat`
 * (splitChatWidth). The main chat takes the rest and keeps
 * SPLIT_MAIN_CHAT_MIN_PX: the second chat gives way first, down to the
 * divider's narrow end, then the panels down to SPLIT_PANEL_MIN_PX, then the
 * second chat again (review, 2026-10-21).
 */
export function dockedSplitWidths(row: DockedSplitRow, sideChat: number): DockedSplitWidths {
    const room = Math.max(0, Math.round(row.span - SPLIT_DIVIDER_PX - row.rail))
    const panels = Number(row.mainPanel) + Number(row.sidePanel)
    let side = clampSplitWidth(sideChat, dockedSplitChatRoom(row), SPLIT_MAIN_CHAT_MIN_PX)
    let panel = SPLIT_PANEL_PX
    let short = SPLIT_MAIN_CHAT_MIN_PX - (room - side - panels * panel)
    if (short > 0 && panels > 0) {
        const give = Math.min(Math.ceil(short / panels), SPLIT_PANEL_PX - SPLIT_PANEL_MIN_PX)
        panel -= give
        short -= give * panels
    }
    if (short > 0) side = Math.max(0, side - short)
    return {
        mainPanel: row.mainPanel ? panel : 0,
        mainChat: Math.max(0, room - side - panels * panel),
        sideChat: side,
        sidePanel: row.sidePanel ? panel : 0,
    }
}

/** What sits right of the main chat while the split is docked (SplitWorkspace). */
export interface DockedSplitRight {
    /** Side by side; stacked, only the bot list can sit right of the main chat. */
    row: boolean
    /** The bot list's width when it sits right of the main chat (between the panes or at the end), else 0. */
    rail: number
    sideChat: number
    sidePanel: number
}

/** Set by SplitWorkspace while docked; null otherwise. */
export const splitDockedRight = writable<DockedSplitRight | null>(null)

/**
 * Pixels the right pane (and its divider) covers at the right of the main
 * window, so floating UI of the left workspace (toasts, the request dock)
 * stays inside it instead of landing on the right pane (the user's report,
 * 2026-10-17). `mobileLayout`: MobileGUI, where the split is not shown.
 * `docked`: the docked layout, where the second pane's panel and the bot
 * list can sit right of the main chat too, and nothing but the bot list does
 * when the panes are stacked.
 */
export function splitRightInset(open: boolean, width: number, mobileLayout: boolean, docked: DockedSplitRight | null = null): number {
    if (!open || mobileLayout || isEmbeddedRisuPane) return 0
    if (docked) {
        const side = docked.row ? SPLIT_DIVIDER_PX + docked.sideChat + docked.sidePanel : 0
        return Math.max(0, Math.round(docked.rail + side))
    }
    return Math.max(0, Math.round(width)) + SPLIT_DIVIDER_PX
}

export function toggleSplitChat() {
    splitChatOpen.update((value) => !value)
}

// The right pane is this app again in an iframe; its own menu closes the
// split by asking the window around it (the user's request, 2026-10-17).
// Its splitChatOpen store is only its own copy of the saved flag.
const SPLIT_CLOSE_MESSAGE = 'pocketrisu:split-close'

/** The split button in either pane: the main window toggles, the right pane closes. */
export function pressSplitButton(): void {
    if (!isEmbeddedRisuPane) {
        toggleSplitChat()
        return
    }
    try {
        window.parent.postMessage({ type: SPLIT_CLOSE_MESSAGE }, window.location.origin)
    } catch {
        // No parent to ask.
    }
}

/** In the main window, while the right pane is shown: close the split when it asks. */
export function listenForSplitClose(pane: () => Window | null | undefined): () => void {
    const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin || event.data?.type !== SPLIT_CLOSE_MESSAGE) return
        if (event.source !== pane()) return
        splitChatOpen.set(false)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
}
