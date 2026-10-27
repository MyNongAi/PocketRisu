// Two chat panes are one document. A card's CSS panel that worked alone on
// screen (a status window drawn only in the newest reply) then exists once
// in each pane, with the same ids and the same radio names:
// - `<label for="x">` acts on the first #x in the document, so a press in
//   the right pane toggled the left pane's checkbox and focused it, and the
//   left pane scrolled to it (the user's report, 2026-10-27);
// - radios with one name are one group across the document, so picking a tab
//   in one pane cleared the same tab in the other.
// Each pane gets a form of its own (DefaultChatScreen); a message's radios
// that have no form join it, and a label acts on its own pane's #x.

let nextPaneForm = 0

/** An id for one chat pane's hidden form. */
export function newPaneFormId(): string {
    nextPaneForm += 1
    return `risu-pane-form-${nextPaneForm}`
}

/**
 * Puts the radios of freshly parsed message nodes, before they are drawn,
 * into the form of the pane `root` is in. Drawn first and moved after, a
 * checked radio would already have cleared its namesake in the other pane.
 */
export function scopePaneRadios(nodes: readonly Node[], root: Element): void {
    const formId = root.closest<HTMLElement>('[data-pane-form]')?.dataset.paneForm
    if (!formId) return
    for (const node of nodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        const element = node as Element
        const radios = Array.from(element.querySelectorAll('input[type="radio"]'))
        if (element.matches('input[type="radio"]')) radios.unshift(element)
        for (const radio of radios) {
            if (radio.hasAttribute('form') || radio.closest('form')) continue
            radio.setAttribute('form', formId)
        }
    }
}

const LABELABLE = 'button, input:not([type="hidden"]), meter, output, progress, select, textarea'

/**
 * A click on a `<label for>` in `pane` whose control (the first element with
 * that id in the document) is in another pane: acts on the element with that
 * id in `pane` instead, as if the pane were alone on screen, without
 * scrolling to it.
 */
export function keepLabelInPane(event: MouseEvent, pane: Element): void {
    if (event.defaultPrevented) return
    const target = event.target instanceof Element ? event.target : null
    const label = target?.closest('label')
    if (!label || !label.htmlFor || !pane.contains(label)) return
    // A press on a control or link inside the label is not the label's.
    if (target!.closest('a, button, input, select, textarea, label') !== label) return
    const control = label.ownerDocument.getElementById(label.htmlFor)
    if (!control || pane.contains(control)) return
    const own = pane.querySelector(`#${CSS.escape(label.htmlFor)}`)
    if (!(own instanceof HTMLElement) || !own.matches(LABELABLE)) return
    event.preventDefault()
    own.focus({ preventScroll: true })
    if (own instanceof HTMLButtonElement || (own instanceof HTMLInputElement && /^(checkbox|radio|button|submit|reset)$/i.test(own.type))) {
        own.click()
    }
}
