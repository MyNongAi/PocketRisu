import { describe, expect, it } from 'vitest'
import { scrollWithinContainer } from './scrollWithin'

const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect

describe('scrollWithinContainer', () => {
    it("lands an element's end above the strip a sticky composer covers", () => {
        const tops: (number | undefined)[] = []
        const container = {
            scrollTop: 100,
            getBoundingClientRect: () => rect(0, 800),
            scrollTo: (options: ScrollToOptions) => { tops.push(options.top) },
        } as unknown as HTMLElement
        const element = { getBoundingClientRect: () => rect(500, 1000) } as unknown as HTMLElement
        scrollWithinContainer(element, container, { block: 'end', behavior: 'instant' })
        scrollWithinContainer(element, container, { block: 'end', behavior: 'instant', bottomInset: 120 })
        scrollWithinContainer(element, container, { block: 'start', behavior: 'instant', bottomInset: 120 })
        expect(tops).toEqual([300, 420, 600])
    })
})
