// The text log (📝 in a message's ☰ menu, logCaptureState.svelte.ts): a range
// of the open chat copied as one HTML post for a board like Arca (the user's
// request, 2026-10-30: "텍스트 로그도 1장씩이 아닌 가위 방식으로"). Each
// message is written as the message menu's copy writes one (Chat.svelte: the
// sender's small portrait and name, then the reply as shown). The messages
// are mounted in the log image's hidden box (mountLogRange), so every asset
// is resolved, and each body goes through buildPortableChatFragment.

import { language } from 'src/lang'
import { DBState, selIdState } from '../stores.svelte'
import { getFileSrc } from '../globalApi.svelte'
import {
    boardPostBytes,
    boardSafeStyles,
    buildPortableChatFragment,
    fetchClipboardDataUrl,
    hexColors,
    rasterizeCoverImage,
    shrinkClipboardImage,
} from '../chatClipboard'
import { mountLogRange, personaFor, type RenderLogOptions } from './logCaptureRender'

export interface RenderedLogText {
    html: string
    /** The messages as plain text, for a paste where HTML is not taken. */
    text: string
    /** What the post weighs on a board (boardPostBytes). */
    bytes: number
}

function escapeHtml(text: string): string {
    const span = document.createElement('span')
    span.textContent = text
    return span.innerHTML
}

/** A sender's portrait as the single copy draws it: 40 px, cropped square. */
async function portrait(path: string | undefined): Promise<string> {
    if (!path) return ''
    try {
        const src = await getFileSrc(path)
        if (!src) return ''
        const embedded = await fetchClipboardDataUrl(src)
        return await rasterizeCoverImage(embedded, 40, 40, 'center').catch(() => shrinkClipboardImage(embedded, 40, 40))
    } catch {
        return ''
    }
}

/** Messages `from`..`to` of the open chat (-1 is the greeting) as one post. */
export async function renderLogText(options: RenderLogOptions): Promise<RenderedLogText> {
    const { signal, onProgress } = options
    const db = DBState.db
    const character = db.characters[selIdState.selId]
    const chat = character?.chats?.[character.chatPage]
    const persona = personaFor(chat?.bindedPersona)
    const { blocks, cleanup } = await mountLogRange(options, false)
    try {
        const root = getComputedStyle(document.documentElement)
        const textColor = root.getPropertyValue('--risu-theme-textcolor')
        const icons = new Map<string, Promise<string>>()
        const iconFor = (path: string | undefined) => {
            const key = path ?? ''
            if (!icons.has(key)) icons.set(key, portrait(path))
            return icons.get(key)!
        }
        const sections: string[] = []
        const plain: string[] = []
        onProgress?.('text', 0, blocks.length)
        for (const [done, { index, block }] of blocks.entries()) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
            const body = block.querySelector<HTMLElement>('span.chattext')
            if (!body) continue
            const isUser = index >= 0 && chat?.message?.[index]?.role === 'user'
            const name = isUser ? persona.name : character?.name ?? ''
            const icon = await iconFor(isUser ? persona.icon : character?.image)
            const doc = new DOMParser().parseFromString(await buildPortableChatFragment(body), 'text/html')
            doc.querySelectorAll('img').forEach((img) => {
                img.setAttribute('alt', img.getAttribute('alt') || 'from PocketRisu')
            })
            boardSafeStyles(doc.body)
            sections.push(`<div style="margin-bottom: 1rem;">
<div style="display: flex; flex-direction: row; align-items: center; gap: 8px; margin-bottom: 0.5rem;">
    ${icon ? `<img style="width: 40px; height: 40px; max-width: 40px; border-radius: 50%; object-fit: cover;" src="${icon}" alt="profile">` : ''}
    <span style="color: ${textColor}; font-weight: 600; font-size: 1rem;">${escapeHtml(name)}</span>
</div>
<div>
    ${doc.body.innerHTML}
</div>
</div>`)
            plain.push(`${name}\n${body.innerText.trim()}`)
            onProgress?.('text', done + 1, blocks.length)
        }
        if (sections.length === 0) throw new Error(language.logCapture.empty)
        const html = hexColors(`<div style="font-family: 'Segoe UI', Roboto, Arial, sans-serif; color: ${textColor}; line-height: 1.6; max-width: 600px; margin: 0.5rem auto; background: ${root.getPropertyValue('--risu-theme-bgcolor')}; border-radius: 8px; overflow: hidden;">
<div style="padding: 12px 16px;">
${sections.join('\n')}
</div>
</div>`)
        return { html, text: plain.join('\n\n'), bytes: boardPostBytes(html) }
    } finally {
        cleanup()
    }
}
