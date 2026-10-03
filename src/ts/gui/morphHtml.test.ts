import { describe, expect, test } from 'vitest'
import { MorphedHtml } from './morphHtml'

function setup(html: string) {
    const root = document.createElement('span')
    document.body.appendChild(root)
    const view = new MorphedHtml()
    view.render(root, html)
    return { root, view }
}

const PANEL = (status: string) => `<p>Story text.</p>
<div class="panel" style="height:60px;overflow:auto"><div class="rows">${'<p>row</p>'.repeat(20)}</div></div>
<details><summary>Stats</summary><p>HP ${status}</p></details>
<button risu-btn="next">Next</button>`

describe('MorphedHtml', () => {
    test('a re-render keeps the elements, so a panel keeps its scroll and an opened <details>', () => {
        const { root, view } = setup(PANEL('10'))
        const panel = root.querySelector('.panel') as HTMLElement
        const details = root.querySelector('details') as HTMLDetailsElement
        const button = root.querySelector('button')
        panel.scrollTop = 40
        details.open = true

        expect(view.render(root, PANEL('7'))).toBe(true)

        expect(root.querySelector('.panel')).toBe(panel)
        expect(panel.scrollTop).toBe(40)
        expect(root.querySelector('details')).toBe(details)
        expect(details.open).toBe(true)
        expect(details.textContent).toContain('HP 7')
        expect(root.querySelector('button')).toBe(button)
    })

    test('the same string again changes nothing', () => {
        const { root, view } = setup(PANEL('10'))
        const first = root.firstChild
        expect(view.render(root, PANEL('10'))).toBe(false)
        expect(root.firstChild).toBe(first)
    })

    test('what the app changed after rendering survives when its source did not change', () => {
        const { root, view } = setup('<p>a <img src="cat.png"></p><p>b</p>')
        const img = root.querySelector('img') as HTMLImageElement
        img.setAttribute('src', 'blob:resolved')
        img.classList.add('root-loaded-image', 'root-loaded-image-contain')

        view.render(root, '<p>a <img src="cat.png"></p><p>c</p>')

        expect(root.querySelector('img')).toBe(img)
        expect(img.getAttribute('src')).toBe('blob:resolved')
        expect(root.textContent).toContain('c')
    })

    test('a source attribute change is applied, keeping the app classes on an image', () => {
        const { root, view } = setup('<img class="a" src="cat.png">')
        const img = root.querySelector('img') as HTMLImageElement
        img.classList.add('root-loaded-image')

        view.render(root, '<img class="b" src="dog.png">')

        expect(root.querySelector('img')).toBe(img)
        expect(img.getAttribute('src')).toBe('dog.png')
        expect(img.classList.contains('b')).toBe(true)
        expect(img.classList.contains('a')).toBe(false)
        expect(img.classList.contains('root-loaded-image')).toBe(true)
    })

    test('a source that opens or closes <details> itself still wins', () => {
        const { root, view } = setup('<details><summary>s</summary>x</details>')
        view.render(root, '<details open><summary>s</summary>x</details>')
        expect((root.querySelector('details') as HTMLDetailsElement).open).toBe(true)
    })

    test('a picked radio tab stays picked when the panel re-renders', () => {
        const html = (n: number) => `<input type="radio" name="t" id="t1" checked><input type="radio" name="t" id="t2"><div>count ${n}</div>`
        const { root, view } = setup(html(1))
        const second = root.querySelector('#t2') as HTMLInputElement
        second.checked = true

        view.render(root, html(2))

        expect(root.querySelector('#t2')).toBe(second)
        expect(second.checked).toBe(true)
        expect(root.textContent).toContain('count 2')
    })

    test('added and removed nodes in the middle leave the rest in place', () => {
        const { root, view } = setup('<p id="a">a</p><p id="b">b</p><p id="c">c</p>')
        const a = root.querySelector('#a')
        const c = root.querySelector('#c')

        view.render(root, '<p id="a">a</p><p id="c">c</p>')
        expect(root.querySelector('#a')).toBe(a)
        expect(root.querySelector('#c')).toBe(c)
        expect(root.querySelector('#b')).toBeNull()

        view.render(root, '<p id="a">a</p><p id="x">x</p><p id="y">y</p><p id="c">c</p>')
        expect(root.querySelector('#a')).toBe(a)
        expect(root.querySelector('#c')).toBe(c)
        expect(Array.from(root.children).map((el) => el.id)).toEqual(['a', 'x', 'y', 'c'])
    })

    test('a different tag is replaced', () => {
        const { root, view } = setup('<p>a</p>')
        const p = root.querySelector('p')
        view.render(root, '<div>a</div>')
        expect(root.querySelector('p')).toBeNull()
        expect(root.querySelector('div')?.textContent).toBe('a')
        expect(p?.isConnected).toBe(false)
    })

    test('a placeholder the app replaced at runtime is left alone while its source is unchanged', () => {
        const { root, view } = setup('<p>t1 <span data-inlay-id="x"></span></p>')
        const placeholder = root.querySelector('[data-inlay-id]') as HTMLElement
        const resolved = document.createElement('img')
        placeholder.replaceWith(resolved)

        view.render(root, '<p>t2 <span data-inlay-id="x"></span></p>')

        expect(root.querySelector('img')).toBe(resolved)
        expect(root.textContent).toContain('t2')
    })

    test('only its own nodes: what else lives in the root is untouched, and clear removes only its nodes', () => {
        const root = document.createElement('div')
        const other = document.createElement('span')
        other.textContent = 'svelte'
        root.appendChild(other)
        const view = new MorphedHtml()
        view.render(root, '<p>one</p>')
        view.render(root, '<p>two</p><p>three</p>')
        expect(root.firstChild).toBe(other)
        expect(root.textContent).toBe('sveltetwothree')
        view.clear()
        expect(root.childNodes.length).toBe(1)
        expect(root.firstChild).toBe(other)
    })

    test('a live child list changed by someone else is rebuilt from the source', () => {
        const { root, view } = setup('<div class="box"><p>a</p></div>')
        const box = root.querySelector('.box') as HTMLElement
        box.appendChild(document.createElement('hr'))

        view.render(root, '<div class="box"><p>b</p></div>')

        expect(root.querySelector('.box')).toBe(box)
        expect(box.innerHTML).toBe('<p>b</p>')
    })
})
