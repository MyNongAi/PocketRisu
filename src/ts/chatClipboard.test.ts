import { describe, expect, it, vi } from 'vitest'
import { buildPortableChatFragment, extractCssUrls, fetchClipboardDataUrl, inlineCssUrls } from './chatClipboard'

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
        expect(html).toContain('border-top:2px solid rgb(1, 2, 3)')
        expect(html).toContain('data:image/png;base64,AA==')
        root.remove()
    })
})
