// Long-term memory reads a scene the 장면 접기 module (modules/scene-fold)
// folded as the module's summary of it. The module marks a finished scene
// inside the messages (hidden HTML comments) and keeps its summary in a chat
// variable, and swaps the summary in only in the request it sends, after
// long-term memory has run. Memory read the scene's full text: it summarized
// again a scene the module had summarized, and counted tokens the request no
// longer carried (the user's request, 2026-10-28). With this, memory gets the
// folded scene as one message, the summary, where the scene began.

import type { OpenAIChat } from '../index.svelte'
import type { Chat } from '../../storage/database.svelte'

/** The module's namespace; its marks mean nothing while it is off. */
export const SCENE_FOLD_NAMESPACE = 'scene-fold'

const START = /<!--sf:s:(\w+):(\w+)-->/g
const END = /<!--sf:e:(\w+)-->/g

export interface FoldedScene {
    id: string
    kind: string
    summary: string
    /** The ids (Message.chatId) of the scene's messages, start to end. */
    chatIds: Set<string>
}

/** The module's summary of a scene, from its chat variable (setState's JSON); null when it has none. */
function summaryOf(state: Chat['scriptstate'], id: string): string | null {
    const raw = state?.['$__sf_sum_' + id]
    if (typeof raw !== 'string' || raw === '') return null
    try {
        const value = JSON.parse(raw)
        return typeof value === 'string' && value.trim() ? value.trim() : null
    } catch {
        return null
    }
}

/**
 * The scenes of a chat, read the way the module reads them: a start mark
 * opens a scene (the first one of an id counts), an end mark closes it.
 * Folded are the closed ones the module has a summary of; `memberOf` maps a
 * message id to every scene it is in, open or folded.
 */
export function scenesOf(chat: Pick<Chat, 'message' | 'scriptstate'>): { folded: FoldedScene[], memberOf: Map<string, string[]> } {
    const open = new Map<string, { id: string, kind: string, chatIds: Set<string> }>()
    const started = new Set<string>()
    const closed: { id: string, kind: string, chatIds: Set<string> }[] = []
    const memberOf = new Map<string, string[]>()
    for (const message of chat.message ?? []) {
        const text = typeof message?.data === 'string' ? message.data : ''
        for (const [, kind, id] of text.matchAll(START)) {
            if (started.has(id)) continue
            started.add(id)
            open.set(id, { id, kind, chatIds: new Set() })
        }
        if (message?.chatId && open.size > 0) {
            memberOf.set(message.chatId, [...open.keys()])
            for (const scene of open.values()) scene.chatIds.add(message.chatId)
        }
        for (const [, id] of text.matchAll(END)) {
            const scene = open.get(id)
            if (!scene) continue
            open.delete(id)
            closed.push(scene)
        }
    }
    const folded: FoldedScene[] = []
    for (const scene of closed) {
        const summary = summaryOf(chat.scriptstate, scene.id)
        if (summary) folded.push({ ...scene, summary })
    }
    return { folded, memberOf }
}

/** What the request carries in place of a folded scene (the module's own wording). */
export function foldedSceneMessage(scene: FoldedScene): OpenAIChat {
    return {
        role: 'system',
        content: `[Folded scene · ${scene.kind}] The full text of this finished scene was left out; this is what happened:\n${scene.summary}`,
        memo: `sf:${scene.id}`,
    }
}

/**
 * The chats with each folded scene as its summary message. A message that is
 * also in a scene still in play stays, as the module keeps it. A scene that
 * long-term memory already summarized in part (a summary names one of its
 * messages) stays as it is, so that summary keeps its messages. Null when
 * nothing changes.
 */
export function foldScenes(
    chats: OpenAIChat[],
    chat: Pick<Chat, 'message' | 'scriptstate'>,
    summarizedMemos: ReadonlySet<string>,
): { chats: OpenAIChat[], removed: OpenAIChat[], added: OpenAIChat[] } | null {
    const { folded, memberOf } = scenesOf(chat)
    const byId = new Map<string, FoldedScene>()
    for (const scene of folded) {
        if ([...scene.chatIds].some((id) => summarizedMemos.has(id))) continue
        byId.set(scene.id, scene)
    }
    if (byId.size === 0) return null
    const out: OpenAIChat[] = []
    const removed: OpenAIChat[] = []
    const added: OpenAIChat[] = []
    const placed = new Set<string>()
    for (const message of chats) {
        const scenes = message.memo ? memberOf.get(message.memo) : undefined
        if (!scenes || !scenes.every((id) => byId.has(id))) {
            out.push(message)
            continue
        }
        removed.push(message)
        const id = scenes[0]
        if (placed.has(id)) continue
        placed.add(id)
        const summary = foldedSceneMessage(byId.get(id)!)
        added.push(summary)
        out.push(summary)
    }
    if (removed.length === 0) return null
    return { chats: out, removed, added }
}

/** foldScenes for a send: the chats memory gets, and the token count moved to match. */
export async function foldScenesForMemory(
    chats: OpenAIChat[],
    currentTokens: number,
    chat: Pick<Chat, 'message' | 'scriptstate' | 'hypaV3Data'>,
    tokenize: (message: OpenAIChat) => Promise<number>,
): Promise<{ chats: OpenAIChat[], currentTokens: number }> {
    const folded = foldScenes(chats, chat, summarizedMemosOf(chat))
    if (!folded) return { chats, currentTokens }
    for (const message of folded.removed) currentTokens -= await tokenize(message)
    for (const message of folded.added) currentTokens += await tokenize(message)
    return { chats: folded.chats, currentTokens }
}

/** The message ids long-term memory has summaries of. */
export function summarizedMemosOf(chat: Pick<Chat, 'hypaV3Data'>): Set<string> {
    const memos = new Set<string>()
    for (const summary of chat.hypaV3Data?.summaries ?? []) {
        for (const memo of summary?.chatMemos ?? []) if (typeof memo === 'string') memos.add(memo)
    }
    return memos
}
