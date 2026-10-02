// Chats the branch graph reads, loaded only while the graph is open.
//
// Chats already in memory are read as they are. A chat that is still a
// placeholder is read from the server with peekChatContent: the body is
// compacted at once (previews only) and never put into the database, so the
// hydrated-chat LRU, delta-sync bases and save preconditions stay untouched.
// Reads are bounded: a first batch of likely relatives when the graph opens,
// then more only when the user asks, a few at a time.

import { untrack } from 'svelte'
import type { character } from '../storage/database.svelte'
import { forageStorage } from '../globalApi.svelte'
import { getFirstMessageAtIndex } from '../firstMessage'
import { compactChat, pickChatsToLoad, unloadedChat, type GraphChat } from './branches'

/** Chats read automatically when the graph opens (parents and look-alikes). */
export const AUTO_LOAD_LIMIT = 12
/** Chats read per "load more". */
export const LOAD_MORE_BATCH = 12
/** Most chats one open graph reads from the server in total. */
export const MAX_CHAT_READS = 120
const READ_CONCURRENCY = 2

export interface BranchGraphSnapshot {
    chats: GraphChat[]
    activeChatIndex: number
}

export class BranchGraphSource {
    private readonly fetched = new Map<string, GraphChat>()
    private readonly attempted = new Set<string>()
    private readonly failedIds = new Set<string>()
    private readonly controller = new AbortController()
    private reads = 0

    constructor(private readonly character: character) {}

    get chaId(): string {
        return this.character.chaId
    }

    get failedCount(): number {
        return this.failedIds.size
    }

    get readBudgetLeft(): number {
        return Math.max(0, MAX_CHAT_READS - this.reads)
    }

    /** Compact view of every chat of the character, as of now. */
    snapshot(): BranchGraphSnapshot {
        return untrack(() => {
            const character = this.character
            const chats = (character.chats ?? []).map((chat, index): GraphChat => {
                if (!chat) return unloadedChat({}, index)
                if (!chat._placeholder) return compactChat(chat, index, getFirstMessageAtIndex(character, chat.fmIndex))
                const read = chat.id ? this.fetched.get(chat.id) : undefined
                return read ? { ...read, index } : unloadedChat(chat, index)
            })
            return { chats, activeChatIndex: character.chatPage ?? 0 }
        })
    }

    /** Unloaded chats that are neither read nor failed. */
    unloadedCount(snapshot: BranchGraphSnapshot): number {
        let count = 0
        for (const chat of snapshot.chats) if (!chat.loaded && chat.id && !this.failedIds.has(chat.id)) count++
        return count
    }

    /**
     * Read the active chat's likely relatives, a round at a time: a parent read
     * in one round can name its own parent for the next.
     */
    async autoLoad(onRound: () => void): Promise<void> {
        let budget = AUTO_LOAD_LIMIT
        while (budget > 0 && !this.controller.signal.aborted) {
            const snapshot = this.snapshot()
            const ids = pickChatsToLoad(snapshot.chats, snapshot.activeChatIndex, {
                limit: Math.min(budget, this.readBudgetLeft),
                includeOthers: false,
                skip: this.attempted,
            })
            if (ids.length === 0) return
            budget -= ids.length
            await this.read(ids)
            if (!this.controller.signal.aborted) onRound()
        }
    }

    /** Read the next batch, relatives first, then the newest other chats. */
    async loadMore(): Promise<void> {
        const snapshot = this.snapshot()
        const ids = pickChatsToLoad(snapshot.chats, snapshot.activeChatIndex, {
            limit: Math.min(LOAD_MORE_BATCH, this.readBudgetLeft),
            includeOthers: true,
            skip: this.attempted,
        })
        await this.read(ids)
    }

    dispose(): void {
        this.controller.abort()
    }

    private async read(ids: string[]): Promise<void> {
        const queue = [...ids]
        const worker = async () => {
            while (queue.length > 0 && !this.controller.signal.aborted) {
                const id = queue.shift()!
                if (this.attempted.has(id)) continue
                this.attempted.add(id)
                await this.readOne(id)
            }
        }
        await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, worker))
    }

    private async readOne(id: string): Promise<void> {
        const chats = this.character.chats ?? []
        const index = chats.findIndex((chat) => chat?.id === id)
        const slot = index === -1 ? null : chats[index]
        // Gone, or hydrated meanwhile (then snapshot() reads it from memory).
        if (!slot || !slot._placeholder) return
        this.reads++
        try {
            const body = await forageStorage.realStorage.peekChatContent(this.chaId, index, id, this.controller.signal)
            if (!body) {
                this.failedIds.add(id)
                return
            }
            const greeting = getFirstMessageAtIndex(this.character, body.fmIndex)
            this.fetched.set(id, compactChat({ ...body, id, name: slot.name }, index, greeting))
        } catch (error) {
            if (this.controller.signal.aborted) return
            console.warn('[branchGraph] could not read chat', id, error)
            this.failedIds.add(id)
        }
    }
}
