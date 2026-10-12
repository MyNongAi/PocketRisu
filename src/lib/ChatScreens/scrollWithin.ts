// scrollIntoView walks all scrollable ancestors; if documentElement is
// bloated (e.g. by sidebar layout leakage) it gets scrolled too, pushing
// the viewport off body and revealing gray space below. Use this helper
// to scroll only the given container instead of climbing to the root.
export function scrollWithinContainer(
    el: HTMLElement,
    container: HTMLElement,
    // bottomInset: pixels at the container's bottom the reader cannot see
    // (a sticky composer over it); 'end' lands above them.
    options: { block: 'start' | 'end'; behavior: ScrollBehavior; bottomInset?: number }
) {
    const elRect = el.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const offset = options.block === 'start'
        ? elRect.top - containerRect.top
        : elRect.bottom - (containerRect.bottom - (options.bottomInset ?? 0))
    container.scrollTo({ top: container.scrollTop + offset, behavior: options.behavior })
}
