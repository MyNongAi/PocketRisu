// The bot list as one column, or two (its folders beside the bots outside
// them), kept per browser. Set from the bot list's + menu and from the split
// divider's menu (the user's request, 2026-10-22), so it is shared state.

const KEY = 'pocketrisu-sidebar-catalog-split-v1'

function read(): boolean {
    try {
        return localStorage.getItem(KEY) === 'split'
    } catch {
        return false
    }
}

export const sidebarCatalog = $state({ split: read() })

export function setSidebarCatalogSplit(split: boolean): void {
    sidebarCatalog.split = split
    try {
        localStorage.setItem(KEY, split ? 'split' : 'normal')
    } catch {
        // best effort
    }
}
