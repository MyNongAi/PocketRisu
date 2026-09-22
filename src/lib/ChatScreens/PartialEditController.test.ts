// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

import PartialEditController from './PartialEditController.svelte'

// UNIQUE appears once so it resolves straight to the confirmation modal.
// REPEATED appears twice so it stops at the match picker instead.
const UNIQUE = 'The second line goes away.'
const REPEATED = 'repeat block here'
const MESSAGE = [
  'The first line stays.',
  UNIQUE,
  REPEATED,
  'The third line stays.',
  REPEATED,
].join('\n')

class TestIntersectionObserver {
  static latest: TestIntersectionObserver | undefined
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: IntersectionObserverCallback) {
    TestIntersectionObserver.latest = this
  }

  setIntersecting(isIntersecting: boolean) {
    const target = this.observe.mock.calls[0]?.[0] as Element
    this.callback([{ isIntersecting, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }

  unobserve() {}
  takeRecords() { return [] }
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds = []
}

const mounted: unknown[] = []
let bodyRoot: HTMLElement

/**
 * happy-dom has no layout or real selection, so the drag path is driven with a
 * stub Selection anchored inside `bodyRoot` and a non-degenerate rect (the
 * controller ignores a 0x0 rect).
 */
function selectText(text: string) {
  const range = {
    commonAncestorContainer: bodyRoot.firstChild ?? bodyRoot,
    getBoundingClientRect: () => ({
      left: 10, right: 110, top: 10, bottom: 30, width: 100, height: 20,
    }),
  }
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => range,
  } as unknown as Selection)
  document.dispatchEvent(new Event('selectionchange'))
}

function dragDeleteButton() {
  return document.querySelector<HTMLButtonElement>(
    '.partial-edit-drag-btn-wrapper .partial-edit-btn-delete',
  )
}

/** Lets the 150ms selection debounce elapse and the resulting render settle. */
async function settle() {
  await vi.advanceTimersByTimeAsync(200)
  await tick()
}

async function mountController() {
  bodyRoot = document.createElement('div')
  bodyRoot.textContent = MESSAGE
  document.body.appendChild(bodyRoot)

  const target = document.createElement('div')
  document.body.appendChild(target)

  mounted.push(mount(PartialEditController, {
    target,
    props: { messageData: MESSAGE, chatIndex: 0, bodyRoot, dragEditEnabled: true },
  }))
  await tick()

  TestIntersectionObserver.latest?.setIntersecting(true)
  await tick()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
})

afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
  vi.useRealTimers()
  document.body.replaceChildren()
  TestIntersectionObserver.latest = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PartialEditController delete confirmation', () => {
  it('opens the confirmation modal for a uniquely matched selection', async () => {
    await mountController()
    selectText(UNIQUE)
    await settle()

    dragDeleteButton()!.click()
    await tick()

    expect(document.querySelector('.partial-delete-modal')).toBeTruthy()
  })

  it('closes cleanly when the confirmation is cancelled', async () => {
    await mountController()
    selectText(UNIQUE)
    await settle()
    dragDeleteButton()!.click()
    await tick()

    document.querySelector<HTMLButtonElement>('.partial-delete-modal .partial-edit-cancel-btn')!.click()
    await tick()

    expect(document.querySelector('.partial-delete-modal')).toBeNull()
  })

  // Regression: the 150ms selection debounce is guarded when the event fires
  // but not inside the timer body, so a selection made just before the
  // confirmation modal opens still raises the drag button over it. Matching a
  // second time from there leaves the match picker and the confirmation modal
  // on screen together, and cancelling the picker clears
  // matchingState.selectedRange while isConfirmingDelete stays true. The
  // confirmation modal is therefore still mounted when its template effect
  // re-runs, which threw "Cannot read properties of null (reading 'method')"
  // on the unguarded matchingState.selectedRange.method.
  it('survives the selected range being cleared while it is still open', async () => {
    await mountController()

    // A selection that will open the confirmation modal.
    selectText(UNIQUE)
    await settle()

    // A second selection queued while nothing is open yet — its debounce
    // survives the modal opening because the timer body has no guard.
    selectText(REPEATED)

    dragDeleteButton()!.click()
    await tick()
    expect(document.querySelector('.partial-delete-modal')).toBeTruthy()

    // The stale debounce fires and puts the drag button back over the modal.
    await settle()
    expect(dragDeleteButton()).toBeTruthy()

    // REPEATED matches twice, so this stops at the picker rather than
    // replacing the selected range.
    dragDeleteButton()!.click()
    await tick()
    const picker = document.querySelector('.partial-match-selection-modal')
    expect(picker, 'an ambiguous selection should open the match picker').toBeTruthy()
    expect(document.querySelector('.partial-delete-modal')).toBeTruthy()

    // Cancelling the picker nulls selectedRange but leaves the confirmation
    // modal mounted — this is what used to throw.
    picker!.querySelector<HTMLButtonElement>('.partial-edit-cancel-btn')!.click()
    await tick()

    expect(document.querySelector('.partial-match-selection-modal')).toBeNull()
  })
})
