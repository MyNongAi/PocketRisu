// The 🎨 album (the user's request, 2026-11-09): the pictures in a chat's
// replies, the replies that came out without one (to draw them in a row), and
// the style samples — one picture per "프리셋 X", kept as assets of the 🎨
// module so its 에셋 tab shows and deletes them too. Pure helpers:
// illustrationRun.ts draws, illustrationSamples.ts keeps the samples,
// IllustrationAlbum.svelte shows them.
import type { IllustrationPrompt, IllustrationScene } from './illustration'

/** A picture reference in a message, as the parser reads it. */
const INLAY_REF = /\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/g

export interface AlbumMessage {
    role?: string
    data?: string
    chatId?: string
    isComment?: boolean
    disabled?: unknown
    nodeOnlyIllustrations?: Record<string, IllustrationPrompt>
}

export interface AlbumPicture {
    inlayId: string
    /** The message's index in the chat. */
    index: number
    messageId?: string
    /** The scene 🎨 drew it from: such a picture can be drawn again or taken out. */
    prompt?: IllustrationPrompt
}

/** The picture ids a text refers to, in order, each once. */
export function inlayIdsOf(text: string | undefined): string[] {
    const ids: string[] = []
    for (const match of (text ?? '').matchAll(INLAY_REF)) {
        if (!ids.includes(match[1])) ids.push(match[1])
    }
    return ids
}

function isReply(message: AlbumMessage | null | undefined): message is AlbumMessage {
    return !!message && message.role === 'char' && !message.isComment
}

/**
 * The pictures in a chat's replies, newest first (a phone album's order). A
 * picture a later reply shows again is listed once, at its latest place.
 */
export function chatPictures(messages: readonly (AlbumMessage | null | undefined)[] | undefined): AlbumPicture[] {
    const seen = new Set<string>()
    const pictures: AlbumPicture[] = []
    const list = messages ?? []
    for (let index = list.length - 1; index >= 0; index--) {
        const message = list[index]
        if (!isReply(message)) continue
        const ids = inlayIdsOf(message.data)
        for (let i = ids.length - 1; i >= 0; i--) {
            const inlayId = ids[i]
            if (seen.has(inlayId)) continue
            seen.add(inlayId)
            const prompt = message.nodeOnlyIllustrations?.[inlayId]
            pictures.push({ inlayId, index, messageId: message.chatId, ...(prompt ? { prompt } : {}) })
        }
    }
    return pictures
}

/**
 * The replies with text and no picture, oldest first: among the last `limit`
 * replies (0: every reply). Hidden ones and comments are not replies here.
 */
export function repliesWithoutPictures(messages: readonly (AlbumMessage | null | undefined)[] | undefined, limit: number): number[] {
    const replies: number[] = []
    const list = messages ?? []
    for (let index = 0; index < list.length; index++) {
        const message = list[index]
        if (isReply(message) && !message.disabled) replies.push(index)
    }
    const window = limit > 0 ? replies.slice(-limit) : replies
    return window.filter((index) => {
        const data = list[index]?.data ?? ''
        return data.trim() !== '' && inlayIdsOf(data).length === 0
    })
}

/** A style sample's asset name in the 🎨 module: its preset's name after this. */
export const SAMPLE_ASSET_PREFIX = '🎨 샘플 · '

export function sampleAssetName(presetName: string): string {
    return SAMPLE_ASSET_PREFIX + presetName
}

/** The preset a sample asset is of, or null for any other asset. */
export function samplePresetName(assetName: string | undefined): string | null {
    if (!assetName?.startsWith(SAMPLE_ASSET_PREFIX)) return null
    const name = assetName.slice(SAMPLE_ASSET_PREFIX.length)
    return name ? name : null
}

/** One picture of each style, drawn from the same scene so they compare. */
export const DEFAULT_SAMPLE_SCENE = '1girl, solo, upper body, looking at viewer, smile, simple background'

export function sampleScene(text: string | undefined): IllustrationScene {
    return { line: 0, camera: '', scene: (text ?? '').trim() || DEFAULT_SAMPLE_SCENE, characters: [] }
}

/** The samples among a module's assets, by preset name (the last one of a name wins). */
export function samplesByPreset(assets: readonly ([string, string, string] | null | undefined)[] | undefined): Map<string, { path: string, ext: string, index: number }> {
    const samples = new Map<string, { path: string, ext: string, index: number }>()
    ;(assets ?? []).forEach((asset, index) => {
        const name = samplePresetName(asset?.[0])
        if (name && asset?.[1]) samples.set(name, { path: asset[1], ext: asset[2] ?? '', index })
    })
    return samples
}

/** The picture's thumbnail as the server keeps it (the settings' inlay gallery uses the same). */
export function inlayThumbSrc(inlayId: string): string {
    const hex = Array.from(new TextEncoder().encode('inlay_thumb/' + inlayId), (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `/api/asset/${hex}`
}
