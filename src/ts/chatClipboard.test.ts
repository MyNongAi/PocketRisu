import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPortableChatFragment, chatClipboardErrorMessage, coverImagePlacement, decodeClipboardCssContent, extractCssUrls, fetchClipboardDataUrl, inlineCssUrls, writeChatClipboard } from './chatClipboard'

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
})

describe('portable chat clipboard assets', () => {
    it('extracts quoted and unquoted CSS background URLs', () => {
        expect(extractCssUrls(`url("/a.png"), linear-gradient(red, blue), url(blob:sample)`))
            .toEqual(['/a.png', 'blob:sample'])
    })

    it('embeds every CSS URL without dropping the surrounding frame style', async () => {
        const result = await inlineCssUrls(
            `linear-gradient(#0008,#0008),url('/frame.png') center/cover,url(/asset.webp)`,
            async (url) => `data:image/mock;base64,${url === '/frame.png' ? 'FRAME' : 'ASSET'}`,
        )
        expect(result).toContain('linear-gradient(#0008,#0008)')
        expect(result).toContain('data:image/mock;base64,FRAME')
        expect(result).toContain('data:image/mock;base64,ASSET')
    })

    it('keeps the original MIME instead of flattening every asset to JPEG', async () => {
        const fetchMock = vi.fn(async () => new Response(new Blob(['gif-bytes'], { type: 'image/gif' })))
        const result = await fetchClipboardDataUrl('blob:asset', fetchMock)
        expect(result.startsWith('data:image/gif;base64,')).toBe(true)
    })

    it('keeps the rendered frame and the current collapsed details state', async () => {
        const root = document.createElement('section')
        root.style.border = '2px solid rgb(1, 2, 3)'
        root.innerHTML = '<details><summary>asset</summary><img alt="asset" src="data:image/png;base64,AA=="></details>'
        document.body.append(root)

        const html = await buildPortableChatFragment(root)

        expect(html).toContain('<details')
        expect(html).not.toContain('<details open')
        const copy = new DOMParser().parseFromString(html, 'text/html')
        expect(copy.querySelector('section')!.style.borderTopWidth).toBe('2px')
        expect(copy.querySelector('section')!.style.borderTopColor).toBe('rgb(1, 2, 3)')
        expect(html).toContain('data:image/png;base64,AA==')
        root.remove()
    })
})

describe('clipboard layout snapshot', () => {
    it('materializes CSS-generated emoji and empty decorative shapes', async () => {
        const root = document.createElement('section')
        root.innerHTML = '<b class="label">Status</b><div class="icon" style="position:relative;width:40px;height:40px"></div>'
        document.body.append(root)
        const none = document.createElement('span').style
        none.content = 'none'
        const emoji = document.createElement('span').style
        emoji.cssText = `content:'🍽️ ';font-size:14px;display:inline`
        const shape = document.createElement('span').style
        shape.cssText = `content:'';display:block;position:absolute;width:20px;height:30px;background-color:red;transform:rotate(-45deg)`
        const html = await buildPortableChatFragment(root, {
            getPseudoStyle: (element, pseudo) => pseudo === '::after' ? none : element.className === 'label' ? emoji : element.className === 'icon' ? shape : none,
        })
        const copy = new DOMParser().parseFromString(html, 'text/html')
        expect(copy.querySelector('b')!.textContent).toBe('🍽️ Status')
        expect(copy.querySelector('div')!.style.height).toBe('40px')
        expect(copy.querySelector('div span')!.getAttribute('style')).toContain('rotate(-45deg)')
        expect(root.querySelector('b')!.textContent).toBe('Status')
    })

    it('decodes escaped CSS text without interpreting it as markup', () => {
        expect(decodeClipboardCssContent('"\\1f60a "')).toBe('😊')
        expect(decodeClipboardCssContent('"<img onerror=bad>"')).toBe('<img onerror=bad>')
        expect(decodeClipboardCssContent('counter(number)')).toBeNull()
        expect(decodeClipboardCssContent('url("icon.png")')).toBeNull()
    })

    it('keeps background image and positioned notebook dimensions', async () => {
        const root = document.createElement('section')
        root.innerHTML = '<div class="book" style="position:relative;height:700px"><div style="position:absolute;top:0;height:700px">cover</div><div style="position:absolute;top:0;height:700px">inside</div></div><div class="image" style="height:300px;background-image:url(data:image/png;base64,AA==)"></div>'
        document.body.append(root)
        const copy = new DOMParser().parseFromString(await buildPortableChatFragment(root), 'text/html')
        expect(copy.querySelector('section > div')!.getAttribute('style')).toContain('700px')
        expect(copy.querySelector('section > div:last-child')!.getAttribute('style')).toContain('300px')
    })

    it('keeps a cropped hover frame as an aspect-ratio image, not the full portrait', async () => {
        const root = document.createElement('section')
        root.innerHTML = '<table style="border-collapse:separate;border-spacing:0px;border-radius:15px;overflow:hidden"><tbody><tr><td><img class="hover-frame" style="width:100%;height:480px;aspect-ratio:1 / 1;object-fit:cover;object-position:top" src="data:image/png;base64,AA=="></td></tr></tbody></table>'
        document.body.append(root)
        const copy = new DOMParser().parseFromString(await buildPortableChatFragment(root), 'text/html')
        const image = copy.querySelector('img')!
        expect(image.style.aspectRatio).toBe('1 / 1')
        expect(image.style.height).toBe('auto')
        expect(image.style.getPropertyPriority('aspect-ratio')).toBe('important')
        expect(image.style.objectFit).toBe('cover')
        expect(image.style.objectPosition).toBe('top')
        expect(copy.querySelector('table')!.style.borderCollapse).toBe('separate')
        expect(image.hasAttribute('class')).toBe(false)
        expect(root.querySelector('img')!.className).toBe('hover-frame')
    })

    it('pre-crops cover images and lets the table frame shrink with the pasted image', async () => {
        const root = document.createElement('section')
        root.innerHTML = '<table style="height:435px"><tbody><tr><td style="height:435px"><img style="display:block;width:100%;height:435px;aspect-ratio:1/1.45;object-fit:cover;object-position:top" src="data:image/png;base64,AA=="></td></tr></tbody></table>'
        document.body.append(root)
        vi.spyOn(root.querySelector('img')!, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 435 } as DOMRect)
        const rasterizeCover = vi.fn(async () => 'data:image/png;base64,CROPPED')
        const copy = new DOMParser().parseFromString(await buildPortableChatFragment(root, { rasterizeCover }), 'text/html')
        expect(rasterizeCover).toHaveBeenCalledWith('data:image/png;base64,AA==', 300, 435, 'top')
        expect(copy.querySelector('table')!.style.height).toBe('auto')
        expect(copy.querySelector('td')!.style.height).toBe('auto')
        const image = copy.querySelector('img')!
        expect(image.getAttribute('src')).toBe('data:image/png;base64,CROPPED')
        expect(image.style.aspectRatio).toBe('auto')
        expect(image.style.width).toBe('100%')
    })

    it('retains the top crop instead of centering the full source portrait', () => {
        expect(coverImagePlacement(100, 200, 100, 100, 'center top'))
            .toEqual({ x: 0, y: 0, width: 100, height: 200 })
        expect(coverImagePlacement(100, 200, 100, 100, 'center center').y).toBe(-50)
        expect(coverImagePlacement(200, 100, 100, 100, 'right center').x).toBe(-100)
    })

    it('replaces status-widget SVG icons with embedded bitmaps for editors that strip SVG', async () => {
        const root = document.createElement('section')
        root.innerHTML = '<div><svg viewBox="0 0 20 20" style="width:20px;height:20px"><defs><linearGradient id="heart"><stop style="stop-color:#ff85a8"/></linearGradient></defs><path fill="url(#heart)" d="M0 0h20v20H0z"/></svg></div>'
        document.body.append(root)
        const svg = root.querySelector('svg')!
        vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ width: 20, height: 20 } as DOMRect)
        const rasterizeSvg = vi.fn(async () => 'data:image/png;base64,HEART')
        const copy = new DOMParser().parseFromString(await buildPortableChatFragment(root, { rasterizeSvg }), 'text/html')
        expect(rasterizeSvg).toHaveBeenCalledTimes(1)
        expect(copy.querySelector('svg')).toBeNull()
        expect(copy.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,HEART')
        expect(copy.querySelector('img')!.style.width).toBe('20px')
        expect(root.querySelector('svg')).toBe(svg)
    })

    it('lets details and text containers reflow instead of fixing the old measured height', async () => {
        const root = document.createElement('section')
        root.innerHTML = '<div style="height:100px;width:650px;overflow:hidden"><details style="height:30px"><summary>Information</summary><p>Long status text</p></details></div><p>Following text</p>'
        document.body.append(root)
        const copy = new DOMParser().parseFromString(await buildPortableChatFragment(root), 'text/html')
        expect(copy.querySelector('details')!.style.height).toBe('auto')
        expect(copy.querySelector('div')!.style.height).toBe('auto')
        expect(copy.querySelector('div')!.style.width).toBe('auto')
        expect(copy.querySelector('div')!.style.overflow).toBe('visible')
        expect(copy.querySelector('details')!.open).toBe(false)
    })

    it('snapshots styles before waiting for the first image fetch', async () => {
        let resolveFetch!: (response: Response) => void
        const fetchFn = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
        const root = document.createElement('div')
        root.innerHTML = '<img src="/asset.png"><div style="border-radius:15px">frame</div>'
        document.body.append(root)
        const pending = buildPortableChatFragment(root, { fetchFn })
        root.querySelector('div')!.style.borderRadius = '60px'
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))
        resolveFetch(new Response(new Blob(['image'], { type: 'image/png' })))
        const html = await pending
        expect(html).toContain('15px')
        expect(html).not.toContain('60px')
    })
})

describe('clipboard focus and promised HTML', () => {
    it('registers the write before asynchronous assets finish', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        let content!: Record<string, Blob | Promise<Blob>>
        vi.stubGlobal('ClipboardItem', class {
            constructor(data: Record<string, Blob | Promise<Blob>>) { content = data }
        })
        const write = vi.spyOn(navigator.clipboard, 'write').mockResolvedValue(undefined)
        let resolveHtml!: (html: string) => void
        const html = new Promise<string>(resolve => { resolveHtml = resolve })
        const pending = writeChatClipboard('plain', html)
        expect(write).toHaveBeenCalledTimes(1)
        expect(content['text/html']).toBeInstanceOf(Promise)
        resolveHtml('<div>frame</div>')
        expect(await (await content['text/html']).text()).toBe('<div>frame</div>')
        await pending
    })

    it('does not retry writeText or report success when the page is unfocused', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(false)
        const writeText = vi.spyOn(navigator.clipboard, 'writeText')
        await expect(writeChatClipboard('plain', Promise.resolve('<p>frame</p>'))).rejects.toThrow('리스 창')
        expect(writeText).not.toHaveBeenCalled()
        expect(chatClipboardErrorMessage(new DOMException('Document is not focused.', 'NotAllowedError'))).toContain('포커스')
    })
})
