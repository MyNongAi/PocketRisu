// A bot panel opened by a CSS toggle (a ticked checkbox: `.toggle:checked ~
// .panel`) and closed by a trigger button (its ✕ runs Lua that sets the
// panel's variable) counted on stock Risu re-creating the message after a
// trigger, which unticks the box. Message bodies now change in place
// (morphHtml.ts) and keep a box the reader ticked, so such a panel stayed open
// (the user's report, 2026-10-19: Belladonna Academy's shop and inventory).
// A close-looking trigger button unticks the boxes that show the panel it
// sits in; other buttons (a +5 inside a panel, a tab) leave every box as is.

const CLOSE_WORDS = /(^|[^a-z])(close|hide|dismiss)([^a-z]|$)|닫기|✕|✖|×|❌/i
const CLOSE_TEXT = /^(x|✕|✖|×|❌|닫기)$/i

/** A trigger/button meant to close something: by its trigger name, label, title, class or one-glyph text. */
export function looksLikeCloseControl(element: Element): boolean {
    const fields = [
        element.getAttribute('risu-trigger') ?? '',
        element.getAttribute('risu-btn') ?? '',
        element.getAttribute('aria-label') ?? '',
        element.getAttribute('title') ?? '',
        typeof element.className === 'string' ? element.className : '',
    ]
    return fields.some((field) => CLOSE_WORDS.test(field)) || CLOSE_TEXT.test((element.textContent ?? '').trim())
}

/** Selectors of the page's style rules that depend on a ticked box. */
function checkedSelectors(doc: Document): string[] {
    const found: string[] = []
    const walk = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
            if ('selectorText' in rule && typeof (rule as CSSStyleRule).selectorText === 'string') {
                const selector = (rule as CSSStyleRule).selectorText
                if (selector.includes(':checked')) found.push(selector)
            }
            if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules)
        }
    }
    for (const sheet of Array.from(doc.styleSheets)) {
        try { walk(sheet.cssRules) } catch { /* another origin's sheet */ }
    }
    return found
}

function matchesAny(element: Element, selectors: readonly string[]): boolean {
    return selectors.some((selector) => {
        try { return element.matches(selector) } catch { return false }
    })
}

/** Whether ticking `toggle` is what makes a rule apply to `element`. */
function controls(toggle: HTMLInputElement, element: Element, selectors: readonly string[]): boolean {
    const was = toggle.checked
    toggle.checked = true
    const on = matchesAny(element, selectors)
    toggle.checked = false
    const off = matchesAny(element, selectors)
    toggle.checked = was
    return on && !off
}

/**
 * Untick the ticked checkboxes in `root` that show the panel `control` sits
 * in (a rule with :checked applies to one of its ancestors only while the box
 * is ticked). Returns how many it unticked.
 */
export function closeTogglePanels(control: Element, root: Element): number {
    const toggles = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter((box) => box.checked)
    if (toggles.length === 0) return 0
    const selectors = checkedSelectors(root.ownerDocument)
    if (selectors.length === 0) return 0
    const ancestors: Element[] = []
    for (let node: Element | null = control; node && node !== root; node = node.parentElement) ancestors.push(node)
    let unticked = 0
    for (const toggle of toggles) {
        if (ancestors.some((ancestor) => controls(toggle, ancestor, selectors))) {
            toggle.checked = false
            unticked++
        }
    }
    return unticked
}
