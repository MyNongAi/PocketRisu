import { describe, expect, it } from 'vitest'
import { drawableNode, drawErrorMessage } from './pictureDrawOptions'

describe('picture drawing options', () => {
    it('skips HTML images without a picture URL', () => {
        const image = document.createElement('img')
        expect(drawableNode(image)).toBe(false)
        image.setAttribute('src', '')
        expect(drawableNode(image)).toBe(false)
        image.setAttribute('src', '  ')
        expect(drawableNode(image)).toBe(false)
        image.setAttribute('src', 'portrait.png')
        expect(drawableNode(image)).toBe(true)
        image.removeAttribute('src')
        image.setAttribute('srcset', 'portrait-2x.png 2x')
        expect(drawableNode(image)).toBe(true)
    })

    it('skips SVG images without a picture URL', () => {
        const image = document.createElementNS('http://www.w3.org/2000/svg', 'image')
        const drawable = () => drawableNode(image as unknown as HTMLElement)
        expect(drawable()).toBe(false)
        image.setAttribute('href', 'portrait.png')
        expect(drawable()).toBe(true)
        image.removeAttribute('href')
        image.setAttribute('xlink:href', 'portrait.png')
        expect(drawable()).toBe(true)
    })

    it('keeps other elements', () => {
        expect(drawableNode(document.createElement('div'))).toBe(true)
        const span = document.createElement('span')
        span.textContent = 'hello'
        expect(drawableNode(span)).toBe(true)
    })

    it('uses a readable drawing error or the fallback', () => {
        expect(drawErrorMessage(new Error('x'), 'f')).toBe('x')
        expect(drawErrorMessage(new Event('error'), 'f')).toBe('f')
        expect(drawErrorMessage(undefined, 'f')).toBe('f')
        expect(drawErrorMessage(new Error(''), 'f')).toBe('f')
    })
})
