// A bot's floating buttons, hidden per bot (the user's request, 2026-10-19).
// Bots draw always-on-screen launchers in their background HTML or regex
// output: a fixed stack of labels/buttons at a screen edge that open a status
// window, a map or a menu (in the live DB, 170 bots and modules have fixed
// rules, mostly `.buttons-container`, FAB stacks and side-panel toggles). With
// the bot's switch on (Toggles.svelte), such a small fixed control is hidden.
// Open popups are larger than a launcher and stay, and so does anything that
// is not fixed to the screen (buttons in the message text).

/** Marks a hidden launcher; styles.css hides it. */
export const FLOATING_HIDDEN_ATTR = 'data-pr-float-hidden'
/** Marks the bot's background HTML layer (BackgroundDom.svelte). */
export const BOT_BACKGROUND_ATTR = 'data-pr-bot-background'
/** Where bot markup is drawn: message bodies and the background layer. */
export const BOT_CONTENT_ROOTS = `.chattext, [${BOT_BACKGROUND_ATTR}]`
/** A launcher covers at most this share of the screen; an open popup is larger. */
export const MAX_SCREEN_SHARE = 0.2

const CONTROL = 'button, label, summary, [risu-btn], [risu-trigger], input[type="checkbox"], input[type="radio"], input[type="button"], [onclick]'

/** Selectors of the page's style rules that set position: fixed. */
export function fixedSelectors(doc: Document): string[] {
    const found: string[] = []
    const walk = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
            const style = (rule as CSSStyleRule).style
            const selector = (rule as CSSStyleRule).selectorText
            if (style && typeof selector === 'string' && style.getPropertyValue('position').trim() === 'fixed') found.push(selector)
            if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules)
        }
    }
    for (const sheet of Array.from(doc.styleSheets)) {
        try { walk(sheet.cssRules) } catch { /* another origin's sheet */ }
    }
    return found
}

function screenArea(rect: DOMRect): number {
    return Math.max(0, rect.width) * Math.max(0, rect.height)
}

/** The area a fixed element shows: its own box, or its controls' when it has no size of its own. */
function shownArea(element: Element): number {
    const own = screenArea(element.getBoundingClientRect())
    if (own > 0) return own
    let total = 0
    for (const control of Array.from(element.querySelectorAll(CONTROL))) total += screenArea(control.getBoundingClientRect())
    return total
}

/** Whether `element` is a small control fixed to the screen. */
export function isFloatingLauncher(element: Element, view: Window): boolean {
    const style = view.getComputedStyle(element)
    if (style.position !== 'fixed' || style.display === 'none' || style.visibility === 'hidden') return false
    if (!(element.matches(CONTROL) || element.querySelector(CONTROL))) return false
    const area = shownArea(element)
    return area > 0 && area <= view.innerWidth * view.innerHeight * MAX_SCREEN_SHARE
}

/** The floating launchers drawn by bot markup under `screen`. */
export function findFloatingLaunchers(screen: Element): Element[] {
    const doc = screen.ownerDocument
    const view = doc.defaultView
    if (!view) return []
    const selectors = [...fixedSelectors(doc), '[style*="fixed"]']
    const found = new Set<Element>()
    for (const root of Array.from(screen.querySelectorAll(BOT_CONTENT_ROOTS))) {
        for (const selector of selectors) {
            let matches: Element[]
            try { matches = Array.from(root.querySelectorAll(selector)) } catch { continue }
            for (const element of matches) {
                if (found.has(element) || element.closest(`[${FLOATING_HIDDEN_ATTR}]`)) continue
                if (isFloatingLauncher(element, view)) found.add(element)
            }
        }
    }
    return [...found]
}

/** Hide the launchers found now. A hidden one stays hidden (it no longer looks fixed once hidden). */
export function hideFloatingLaunchers(screen: Element): number {
    const found = findFloatingLaunchers(screen)
    for (const element of found) element.setAttribute(FLOATING_HIDDEN_ATTR, '')
    return found.length
}

export function showFloatingLaunchers(screen: Element): void {
    for (const element of Array.from(screen.querySelectorAll(`[${FLOATING_HIDDEN_ATTR}]`))) element.removeAttribute(FLOATING_HIDDEN_ATTR)
}

/**
 * Svelte action for the chat screen: while `enabled`, hide the launchers bot
 * markup draws, again whenever messages, the background or a toggle change.
 */
export function hideFloatingBotControls(screen: HTMLElement, enabled: boolean) {
    let on = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
        if (!on || timer) return
        timer = setTimeout(() => {
            timer = null
            if (on) hideFloatingLaunchers(screen)
        }, 150)
    }
    // Our own mark is not in the filter, so marking does not rescan.
    const observer = new MutationObserver(schedule)
    const start = () => {
        on = true
        observer.observe(screen, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'open'] })
        screen.addEventListener('change', schedule, true)
        window.addEventListener('resize', schedule)
        hideFloatingLaunchers(screen)
        schedule() // once more after the background's markdown settles
    }
    const stop = () => {
        on = false
        observer.disconnect()
        screen.removeEventListener('change', schedule, true)
        window.removeEventListener('resize', schedule)
        if (timer) { clearTimeout(timer); timer = null }
        showFloatingLaunchers(screen)
    }
    if (enabled) start()
    return {
        update(next: boolean) {
            if (next && !on) start()
            else if (!next && on) stop()
        },
        destroy() { if (on) stop() },
    }
}
