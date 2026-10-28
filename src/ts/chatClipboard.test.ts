import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_POST_SAFE_BYTES, backgroundPictureOf, boardLonghands, boardPostBytes, boardSafeStyles, buildPortableChatFragment, portableStyle, chatClipboardErrorMessage, boardSafeTags, clipboardImageSize, clipboardSizeLabel, isAnimatedImageDataUrl, shrinkClipboardImage, hexColors, replaceFormControls, coverImagePlacement, decodeClipboardCssContent, extractCssUrls, fetchClipboardDataUrl, inlineCssUrls, writeChatClipboard } from './chatClipboard'

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

    it('keeps the rendered frame and a closed details as its summary alone', async () => {
        const root = document.createElement('section')
        root.style.border = '2px solid rgb(1, 2, 3)'
        root.innerHTML = '<details><summary>asset</summary><img alt="asset" src="data:image/png;base64,AA=="></details>'
        document.body.append(root)

        const html = await buildPortableChatFragment(root)

        expect(html).toContain('<details')
        expect(html).not.toContain('<details open')
        const copy = new DOMParser().parseFromString(html, 'text/html')
        // A board unwraps <section>: the frame goes out on a div.
        const frame = copy.body.firstElementChild as HTMLElement
        expect(frame.tagName).toBe('DIV')
        expect(frame.style.borderTopWidth).toBe('2px')
        expect(frame.style.borderTopColor).toBe('rgb(1, 2, 3)')
        // what a closed details hides stays out, as on screen (2026-10-28)
        expect(html).toContain('asset</summary>')
        expect(html).not.toContain('data:image/png;base64,AA==')
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
        const icon = copy.body.firstElementChild!.querySelector(':scope > div') as HTMLElement
        expect(icon.style.height).toBe('40px')
        expect(icon.querySelector('span')!.getAttribute('style')).toContain('rotate(-45deg)')
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
        expect(copy.querySelector('body > div > div')!.getAttribute('style')).toContain('700px')
        expect(copy.querySelector('body > div > div:last-child')!.getAttribute('style')).toContain('300px')
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

    it('turns card buttons and form fields into styled spans that editors keep', async () => {
        const root = document.createElement('section')
        root.innerHTML = '<div><button risu-btn="attack" style="background:#2563eb;color:#fff;padding:4px 10px">공격 <b>!</b></button><input type="button" value="도망" style="color:red"><select><option>A</option><option selected>B</option></select><input type="hidden" value="x"></div>'
        document.body.append(root)
        const copy = new DOMParser().parseFromString(await buildPortableChatFragment(root), 'text/html')
        expect(copy.querySelector('button, input, select')).toBeNull()
        const spans = Array.from(copy.querySelectorAll('div > span'))
        expect(spans.map((span) => span.textContent)).toEqual(['공격 !', '도망', 'B'])
        expect((spans[0] as HTMLElement).style.backgroundColor).not.toBe('')
        expect((spans[0] as HTMLElement).style.display).toBe('inline-block')
        expect(spans[0].querySelector('b')).not.toBeNull()
        expect(copy.body.innerHTML).not.toContain('risu-btn')
    })

    it('also turns buttons into spans in parsed HTML of a message that is not on screen', () => {
        const doc = new DOMParser().parseFromString('<div><button style="color:red">열기</button><textarea>메모\n둘</textarea></div>', 'text/html')
        replaceFormControls(doc.body)
        expect(doc.querySelector('button, textarea')).toBeNull()
        expect(Array.from(doc.querySelectorAll('span')).map((span) => span.textContent)).toEqual(['열기', '메모\n둘'])
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

describe('boardSafeTags', () => {
    it('turns a quote mark into a span with its color, a blockquote into a div, and keeps safe tags', () => {
        const root = document.createElement('div')
        root.innerHTML = '<p>She said <mark risu-mark="quote2" style="color: rgb(255, 215, 0);">“hi”</mark> <em style="color: #8be9fd;">softly</em></p>'
            + '<blockquote style="display: block; color: #aaa;"><strong>note</strong></blockquote><span><kbd>K</kbd></span>'
        boardSafeTags(root)
        expect(root.querySelector('mark, blockquote, kbd')).toBeNull()
        const quote = root.querySelector('p > span')!
        expect(quote.textContent).toBe('“hi”')
        expect(quote.getAttribute('style')).toBe('color: rgb(255, 215, 0);')
        expect(root.querySelector('p > em')!.getAttribute('style')).toBe('color: #8be9fd;')
        expect(root.querySelector('div > strong')!.textContent).toBe('note')
        expect(root.querySelector('span > span')!.textContent).toBe('K')
    })
})

describe('hexColors', () => {
    it('writes opaque rgb() as hex and leaves alpha colors alone', () => {
        expect(hexColors('<p style="color: rgb(250, 250, 250);">a</p><i style="background-color:rgba(0, 0, 0, 0.5)">b</i>'))
            .toBe('<p style="color: #fafafa;">a</p><i style="background-color:rgba(0, 0, 0, 0.5)">b</i>')
        expect(hexColors('<p>rgb(1, 2, 3) stays</p>')).toBe('<p>rgb(1, 2, 3) stays</p>')
    })
})

describe('clipboard image size (board post limits)', () => {
    it('keeps an image no larger than twice its shown box, 1600 px on the long side at most', () => {
        // A 2000×3000 portrait drawn at 80×80: 160 px covers the box at 2×.
        expect(clipboardImageSize(2000, 3000, 80, 80)).toEqual({ width: 160, height: 240 })
        // Never enlarged.
        expect(clipboardImageSize(100, 50, 400, 300)).toEqual({ width: 100, height: 50 })
        // Box unknown: only the edge cap.
        expect(clipboardImageSize(4000, 2000)).toEqual({ width: 1600, height: 800 })
        // A wide box still gets enough height for cover.
        expect(clipboardImageSize(1000, 1000, 400, 100)).toEqual({ width: 800, height: 800 })
    })

    it('tells animated PNG and WebP apart from still ones', () => {
        const b64 = (text: string) => btoa(text)
        expect(isAnimatedImageDataUrl(`data:image/png;base64,${b64('PNGxxxxIHDRxxxxacTLxxxx')}`)).toBe(true)
        expect(isAnimatedImageDataUrl(`data:image/png;base64,${b64('PNGxxxxIHDRxxxxIDATxxxx')}`)).toBe(false)
        expect(isAnimatedImageDataUrl(`data:image/webp;base64,${b64('RIFFxxxxWEBPVP8XxxxxANIMxxxx')}`)).toBe(true)
        expect(isAnimatedImageDataUrl('data:image/gif;base64,R0lGOD')).toBe(false)
    })

    it('leaves the image as it is where it cannot be redrawn', async () => {
        // jsdom has no createImageBitmap.
        expect(await shrinkClipboardImage('data:image/png;base64,AA==', 80, 80)).toBe('data:image/png;base64,AA==')
        expect(await shrinkClipboardImage('data:image/gif;base64,R0lGOD', 80, 80)).toBe('data:image/gif;base64,R0lGOD')
    })

    it('shrinks each image and background to the box it is shown in', async () => {
        const root = document.createElement('section')
        root.innerHTML = '<img src="data:image/png;base64,PORTRAIT"><div style="background-image:url(/frame.png)">text</div>'
        document.body.append(root)
        vi.spyOn(root.querySelector('img')!, 'getBoundingClientRect').mockReturnValue({ width: 80, height: 80 } as DOMRect)
        vi.spyOn(root.querySelector('div')!, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 120 } as DOMRect)
        const shrinkImage = vi.fn(async (dataUrl: string, width: number, height: number) => `data:image/webp;base64,${dataUrl.startsWith('data:image/png;base64,PORTRAIT') ? 'PORTRAIT' : 'FRAME'}-${width}x${height}`)
        const fetchFn = vi.fn(async () => new Response(new Blob(['frame'], { type: 'image/png' })))
        const copy = new DOMParser().parseFromString(await buildPortableChatFragment(root, { shrinkImage, fetchFn }), 'text/html')
        expect(copy.querySelector('img')!.getAttribute('src')).toBe('data:image/webp;base64,PORTRAIT-80x80')
        // A board shows a pasted image at its pixel width (twice the shown size): no wider than shown.
        expect(copy.querySelector('img')!.style.maxWidth).toBe('min(100%, 80px)')
        expect(copy.querySelector('div div, section div')!.getAttribute('style')).toContain('data:image/webp;base64,FRAME-300x120')
    })

    it('turns an empty box drawn with a cover background into an <img>, which a board keeps', async () => {
        const root = document.createElement('section')
        root.innerHTML = '<p>before</p><div class="scene" style="display:block;width:336px;height:210px;border-radius:20px;background-image:url(/scene.png);background-size:cover;background-position:50% 10%"></div><div style="background-image:url(/frame.png);background-size:cover">text</div>'
        document.body.append(root)
        const [scene, frame] = Array.from(root.querySelectorAll('div'))
        vi.spyOn(scene, 'getBoundingClientRect').mockReturnValue({ width: 336, height: 210 } as DOMRect)
        vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 120 } as DOMRect)
        const fetchFn = vi.fn(async () => new Response(new Blob(['png'], { type: 'image/png' })))
        const rasterizeBackground = vi.fn(async () => 'data:image/webp;base64,SCENE')
        const shrinkImage = vi.fn(async () => 'data:image/webp;base64,FRAME')
        const copy = new DOMParser().parseFromString(await buildPortableChatFragment(root, { fetchFn, rasterizeBackground, shrinkImage }), 'text/html')
        expect(rasterizeBackground).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/), 336, 210, 'cover', '50% 10%')
        const images = copy.querySelectorAll('img')
        expect(images).toHaveLength(1)
        expect(images[0].getAttribute('src')).toBe('data:image/webp;base64,SCENE')
        expect(images[0].style.backgroundImage).toBe('')
        expect(images[0].style.borderRadius).toBe('20px')
        expect(images[0].style.width).toBe('336px')
        expect(images[0].style.maxWidth).toBe('min(100%, 336px)')
        expect(images[0].style.height).toBe('auto')
        expect(images[0].style.overflow).toBe('hidden')
        expect(images[0].hasAttribute('class')).toBe(false)
        // A box with text over its background keeps the background.
        const textBox = Array.from(copy.querySelectorAll('div')).find((element) => element.textContent === 'text')!
        expect(textBox.getAttribute('style')).toContain('data:image/webp;base64,FRAME')
        expect(root.querySelector('.scene')).not.toBeNull()
    })

    it('leaves a background that is not one picture fitted to the box', () => {
        const box = document.createElement('div')
        const style = (backgroundImage: string, backgroundSize: string, backgroundRepeat = 'repeat') => ({ backgroundImage, backgroundSize, backgroundRepeat, backgroundPosition: 'center' }) as CSSStyleDeclaration
        expect(backgroundPictureOf(box, style('url(a.png)', 'cover'), false, false)).toEqual({ url: 'a.png', fit: 'cover', position: 'center' })
        expect(backgroundPictureOf(box, style('url(a.png)', 'contain', 'no-repeat'), false, false)?.fit).toBe('contain')
        expect(backgroundPictureOf(box, style('url(a.png)', 'contain'), false, false)).toBeNull()
        expect(backgroundPictureOf(box, style('url(a.png)', 'auto'), false, false)).toBeNull()
        expect(backgroundPictureOf(box, style('url(a.png), url(b.png)', 'cover'), false, false)).toBeNull()
        expect(backgroundPictureOf(box, style('linear-gradient(red, blue), url(a.png)', 'cover'), false, false)).toBeNull()
        expect(backgroundPictureOf(box, style('url(a.png)', 'cover'), true, false)).toBeNull()
        expect(backgroundPictureOf(box, style('url(a.png)', 'cover'), false, true)).toBeNull()
        box.append(document.createElement('span'))
        expect(backgroundPictureOf(box, style('url(a.png)', 'cover'), false, false)).toBeNull()
    })

    it('labels the copy size', () => {
        expect(clipboardSizeLabel(500)).toBe('1KB')
        expect(clipboardSizeLabel(300 * 1024)).toBe('300KB')
        expect(clipboardSizeLabel(12.34 * 1024 * 1024)).toBe('12.3MB')
    })
})

describe('boardSafeStyles', () => {
    // Arca keeps flex-direction, flex-wrap, justify-content, align-items and
    // text-align left/center, but drops flex-flow, place-* and text-align start
    // (probed on a post, 2026-10-27): a column of assets pasted as one row.
    it('writes the flex and alignment shorthands a board drops as their longhands', () => {
        const root = document.createElement('div')
        root.innerHTML = '<div style="display:flex;flex-flow:column wrap;place-items:center;place-content:normal space-between;background-image:url(&quot;data:image/png;base64,AA==&quot;);gap:4px">'
            + '<p style="text-align:start;color:#fff">a</p><span style="place-self:safe center !important">b</span><i style="color:red">c</i></div>'
        boardSafeStyles(root)
        expect(root.firstElementChild!.getAttribute('style')).toBe('display:flex;flex-direction:column;flex-wrap:wrap;align-items:center;justify-items:center;align-content:normal;justify-content:space-between;background-image:url("data:image/png;base64,AA==");gap:4px')
        expect(root.querySelector('p')!.getAttribute('style')).toBe('text-align:left;color:#fff')
        expect(root.querySelector('span')!.getAttribute('style')).toBe('align-self:safe center !important;justify-self:safe center !important')
        expect(root.querySelector('i')!.getAttribute('style')).toBe('color:red')
    })

    it('fills the longhand a shorthand leaves out with its initial value', () => {
        expect(boardLonghands('flex-flow', 'wrap')).toEqual([['flex-direction', 'row'], ['flex-wrap', 'wrap']])
        expect(boardLonghands('flex-flow', 'column')).toEqual([['flex-direction', 'column'], ['flex-wrap', 'nowrap']])
        expect(boardLonghands('place-items', 'center')).toEqual([['align-items', 'center'], ['justify-items', 'center']])
        expect(boardLonghands('flex-direction', 'column')).toBeNull()
    })
})

describe('broken images in a copy', () => {
    it('leaves out a picture that failed to load or has no source', async () => {
        const root = document.createElement('section')
        root.innerHTML = '<p>a</p><img src="/assets/missing.png"><img src=""><img src="/assets/ok.png">'
        document.body.append(root)
        const [missing, empty, ok] = Array.from(root.querySelectorAll('img'))
        for (const [image, width] of [[missing, 0], [empty, 0], [ok, 120]] as const) {
            Object.defineProperty(image, 'complete', { value: true })
            Object.defineProperty(image, 'naturalWidth', { value: width })
            Object.defineProperty(image, 'naturalHeight', { value: width })
        }
        const fetchFn = vi.fn(async () => new Response(new Blob(['png'], { type: 'image/png' })))
        const shrinkImage = vi.fn(async () => 'data:image/webp;base64,OK')
        const copy = new DOMParser().parseFromString(await buildPortableChatFragment(root, { fetchFn, shrinkImage }), 'text/html')
        const images = copy.querySelectorAll('img')
        expect(images).toHaveLength(1)
        expect(images[0].getAttribute('src')).toBe('data:image/webp;base64,OK')
    })
})

describe('only what the reply shows is copied', () => {
    // A bot's button panels (the checkbox trick: a panel shown only while its
    // box is checked), a closed <details>, and a 도감 book with its floating
    // launcher fixed to the screen.
    const markup = '<p>본문 첫 줄</p>'
        + '<input type="checkbox" id="stat" style="display:none"><label for="stat">상태창</label>'
        + '<div class="panel" style="display:none"><p>닫힌 패널 내용</p></div>'
        + '<details><summary>상세 보기</summary><p>닫힌 상세 내용</p>남은 글</details>'
        + '<div style="position:fixed;right:8px;bottom:80px"><button>📖 도감 열기</button></div>'
        + '<div style="position:fixed;top:40px;left:40px;display:block"><p>물고기 도감 팝업</p></div>'
        + '<div style="visibility:hidden"><span>안 보이는 칸</span></div>'
        + '<div style="visibility:hidden"><span style="visibility:visible">보이는 안쪽 칸</span></div>'
        + '<p>본문 끝 줄</p>'

    it('leaves out closed panels, closed details, fixed launchers and popups, and invisible boxes', async () => {
        const root = document.createElement('div')
        root.innerHTML = markup
        document.body.append(root)
        const html = await buildPortableChatFragment(root, { getDefaultStyle: () => null })
        for (const shown of ['본문 첫 줄', '상태창', '상세 보기', '보이는 안쪽 칸', '본문 끝 줄']) expect(html).toContain(shown)
        for (const left of ['닫힌 패널 내용', '닫힌 상세 내용', '남은 글', '도감 열기', '물고기 도감 팝업', '안 보이는 칸']) expect(html).not.toContain(left)
    })

    it('keeps a panel and details the user opened', async () => {
        const root = document.createElement('div')
        root.innerHTML = markup.replace('class="panel" style="display:none"', 'class="panel" style="display:block"').replace('<details>', '<details open>')
        document.body.append(root)
        const html = await buildPortableChatFragment(root, { getDefaultStyle: () => null })
        for (const shown of ['닫힌 패널 내용', '닫힌 상세 내용', '남은 글']) expect(html).toContain(shown)
        expect(html).not.toContain('물고기 도감 팝업')
    })
})

// A computed style as the browser gives it: every property has a value.
function computedStyle(values: Record<string, string>, important: string[] = []): CSSStyleDeclaration {
    return {
        getPropertyValue: (property: string) => values[property] ?? '',
        getPropertyPriority: (property: string) => important.includes(property) ? 'important' : '',
    } as unknown as CSSStyleDeclaration
}

describe('portable styles (post size)', () => {
    // A paragraph inside a reply: everything as its parent or the default,
    // except what the bot's CSS set (color, a border radius).
    const base: Record<string, string> = {
        display: 'block', visibility: 'visible', 'box-sizing': 'border-box', position: 'static',
        top: 'auto', right: 'auto', bottom: 'auto', left: 'auto', 'z-index': 'auto',
        width: '343px', 'min-width': '0px', 'max-width': 'none', height: '48px', 'min-height': '0px', 'max-height': 'none', 'aspect-ratio': 'auto',
        'margin-top': '16px', 'margin-right': '0px', 'margin-bottom': '16px', 'margin-left': '0px',
        'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
        overflow: 'visible', 'overflow-x': 'visible', 'overflow-y': 'visible',
        color: 'rgb(230, 230, 230)', 'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none', 'background-size': 'auto',
        'background-position': '0% 0%', 'background-repeat': 'repeat', 'background-clip': 'border-box',
        'border-top': '0px none rgb(230, 230, 230)', 'border-right': '0px none rgb(230, 230, 230)',
        'border-bottom': '0px none rgb(230, 230, 230)', 'border-left': '0px none rgb(230, 230, 230)',
        'border-radius': '0px', 'border-collapse': 'separate', 'border-spacing': '0px 0px', 'table-layout': 'auto', 'box-shadow': 'none', outline: 'rgb(230, 230, 230) none 0px',
        'font-family': 'Pretendard, sans-serif', 'font-size': '16px', 'font-style': 'normal', 'font-weight': '400', 'line-height': '25.6px',
        'letter-spacing': 'normal', 'text-align': 'start', 'text-decoration': 'none solid rgb(230, 230, 230)', 'text-shadow': 'none',
        'white-space': 'normal', 'word-break': 'normal', 'overflow-wrap': 'break-word',
        'object-fit': 'fill', 'object-position': '50% 50%', opacity: '1', filter: 'none', 'clip-path': 'none',
        flex: '0 1 auto', 'flex-basis': 'auto', 'flex-direction': 'row', 'flex-grow': '0', 'flex-shrink': '1',
        'flex-wrap': 'nowrap', 'align-content': 'normal', 'align-items': 'normal', 'align-self': 'auto',
        'justify-content': 'normal', 'justify-items': 'normal', 'justify-self': 'auto', gap: 'normal',
        'grid-template-columns': 'none', 'grid-template-rows': 'none', 'grid-column': 'auto', 'grid-row': 'auto',
        transform: 'none', 'transform-origin': '171.5px 24px', 'transform-style': 'flat', perspective: 'none', 'perspective-origin': '171.5px 24px', 'backface-visibility': 'visible', 'vertical-align': 'baseline',
        fill: 'rgb(0, 0, 0)', 'fill-rule': 'nonzero', stroke: 'none', 'stroke-width': '1px', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter',
        'stop-color': 'rgb(0, 0, 0)', 'stop-opacity': '1', 'flood-color': 'rgb(0, 0, 0)', 'flood-opacity': '1',
    }
    const parent = computedStyle(base)
    // The tag's default in a blank page: black text, no margins of its own here.
    const defaults = computedStyle({ ...base, color: 'rgb(0, 0, 0)', 'border-top': '0px none rgb(0, 0, 0)', 'border-right': '0px none rgb(0, 0, 0)', 'border-bottom': '0px none rgb(0, 0, 0)', 'border-left': '0px none rgb(0, 0, 0)', outline: 'rgb(0, 0, 0) none 0px', 'text-decoration': 'none solid rgb(0, 0, 0)', width: 'auto', height: 'auto', 'transform-origin': '50% 50%', 'perspective-origin': '50% 50%' })
    const paragraph = computedStyle({ ...base, 'border-radius': '8px' })

    it('writes what differs, the always-written few, and leaves out the rest', () => {
        const style = portableStyle(paragraph, parent, defaults)
        expect(style).toContain('display:block')
        expect(style).toContain('margin-top:16px')
        expect(style).toContain('color:rgb(230, 230, 230)')
        expect(style).toContain('border-radius:8px')
        // inherited and the same as the parent
        expect(style).not.toContain('font-family')
        expect(style).not.toContain('white-space')
        // the default for the tag, though the undrawn border names another color
        expect(style).not.toContain('border-top')
        expect(style).not.toContain('outline')
        expect(style).not.toContain('text-decoration')
        expect(style).not.toContain('flex-direction')
        // the copied root writes inherited values in full
        expect(portableStyle(paragraph, null, defaults)).toContain('font-family:Pretendard, sans-serif')
        // an !important rule always goes out
        expect(portableStyle(computedStyle({ ...base, 'flex-direction': 'row' }, ['flex-direction']), parent, defaults)).toContain('flex-direction:row !important')
    })

    it('makes a long reply a fraction of the size', () => {
        const paragraphs = 300
        const before = portableStyle(paragraph).length * paragraphs
        const after = portableStyle(paragraph, parent, defaults).length * paragraphs
        expect(before).toBeGreaterThan(500 * 1024)
        expect(after).toBeLessThan(before / 5)
    })

    it('counts a pasted picture as the address a board gives it', () => {
        const picture = `<img src="data:image/webp;base64,${'A'.repeat(200_000)}">`
        expect(boardPostBytes(picture)).toBeLessThan(200)
        expect(boardPostBytes('<p>가</p>')).toBe(new Blob(['<p>가</p>']).size)
        expect(BOARD_POST_SAFE_BYTES).toBeLessThan(512 * 1024)
    })
})
