import { afterEach, describe, expect, it } from 'vitest'
import { keepLabelInPane, newPaneFormId, scopePaneRadios } from './paneFormScope'

const parse = (html: string) => {
    const template = document.createElement('template')
    template.innerHTML = html
    return Array.from(template.content.childNodes)
}

const pane = (formId: string, html: string) => {
    const scroller = document.createElement('div')
    scroller.dataset.paneForm = formId
    scroller.innerHTML = html
    scroller.addEventListener('click', (event) => keepLabelInPane(event, scroller), true)
    document.body.append(scroller)
    return scroller
}

afterEach(() => {
    document.body.innerHTML = ''
})

describe('newPaneFormId', () => {
    it('gives each pane its own form', () => {
        expect(newPaneFormId()).not.toBe(newPaneFormId())
    })
})

describe('scopePaneRadios', () => {
    it('puts the radios with no form of their own into the pane form', () => {
        const scroller = pane('pane-a', '<div class="body"></div>')
        const nodes = parse([
            '<input type="radio" name="tab" checked>',
            '<div><input type="radio" name="tab"><input type="checkbox" id="c"></div>',
            '<form><input type="radio" name="tab"></form>',
            '<input type="radio" name="tab" form="own">',
            'text',
        ].join(''))
        scopePaneRadios(nodes, scroller.querySelector('.body')!)
        const forms = nodes.flatMap((node) => node instanceof Element
            ? [node, ...Array.from(node.querySelectorAll('input'))].filter((element) => element.matches('input'))
            : []).map((input) => input.getAttribute('form'))
        expect(forms).toEqual(['pane-a', 'pane-a', null, null, 'own'])
    })

    it('leaves a body that is in no pane alone', () => {
        const root = document.createElement('div')
        const nodes = parse('<input type="radio" name="tab">')
        scopePaneRadios(nodes, root)
        expect((nodes[0] as Element).hasAttribute('form')).toBe(false)
    })
})

describe('keepLabelInPane', () => {
    const panel = '<input type="checkbox" id="status"><label for="status">open</label>'

    it('acts on its own pane when the first element with that id is in the other one', () => {
        const left = pane('pane-a', panel)
        const right = pane('pane-b', panel)
        const label = right.querySelector('label')!
        const click = new MouseEvent('click', { bubbles: true, cancelable: true })
        label.dispatchEvent(click)
        expect(click.defaultPrevented).toBe(true)
        expect(right.querySelector<HTMLInputElement>('#status')!.checked).toBe(true)
        expect(left.querySelector<HTMLInputElement>('#status')!.checked).toBe(false)
        expect(document.activeElement).toBe(right.querySelector('#status'))
    })

    it('leaves the browser to it when the control is in the same pane', () => {
        const left = pane('pane-a', panel)
        pane('pane-b', panel)
        const click = new MouseEvent('click', { bubbles: true, cancelable: true })
        left.querySelector('label')!.dispatchEvent(click)
        expect(click.defaultPrevented).toBe(false)
    })

    it('leaves a press on a control inside the label alone', () => {
        pane('pane-a', panel)
        const right = pane('pane-b', '<input type="checkbox" id="status"><label for="status"><input type="checkbox" class="inner"></label>')
        const click = new MouseEvent('click', { bubbles: true, cancelable: true })
        right.querySelector('.inner')!.dispatchEvent(click)
        expect(click.defaultPrevented).toBe(false)
    })
})
