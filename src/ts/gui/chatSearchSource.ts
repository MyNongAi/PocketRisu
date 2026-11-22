// CHAT-SEARCH (2026-11-22): read-only, bounded search of one bot's saved messages.
import type { character, Chat } from '../storage/database.svelte'
import { forageStorage } from '../globalApi.svelte'
import { messageMatches, messageSnippet, searchTerms, type SnippetPart } from '../chatSearch'

export interface SearchMessage { data: string; role: 'user' | 'char'; index: number; chatId?: string }
export interface SearchHit { botId: string; chatId: string; chatName: string; messageId?: string; index: number; role: 'user' | 'char'; parts: SnippetPart[] }
export interface SearchSnapshot { hits: SearchHit[]; count: number; done: number; total: number; failed: number; reading: boolean }
export type PeekChat = (botId: string, index: number, chatId: string, signal: AbortSignal) => Promise<Pick<Chat, 'message'> | null>
export const chatSearchQueries = new Map<string, string>()

export class ChatSearchSource {
    private cache = new Map<string, SearchMessage[]>()
    private cacheChars = 0
    private failed = new Set<string>()
    private controller = new AbortController()
    private serial = 0
    private query = ''
    private update: (snapshot: SearchSnapshot) => void = () => {}
    private done = new Set<string>()
    private matched = new Map<string, { hits: SearchHit[]; count: number }>()
    private scanning = false
    private inFlight = new Map<string, Promise<SearchMessage[] | null>>()
    private activeReads = 0
    private waiters: Array<() => void> = []

    constructor(private character: Pick<character, 'chaId' | 'chats'>, private peek?: PeekChat, private maxChars = 40_000_000) {}

    dispose(): void {
        this.controller.abort()
        this.waiters.splice(0).forEach(wake => wake())
        this.serial++
        this.cache.clear()
        this.cacheChars = 0
    }

    search(query: string, update: (snapshot: SearchSnapshot) => void): void {
        this.query = query
        this.update = update
        this.done.clear()
        this.matched.clear()
        this.scanning = true
        const serial = ++this.serial
        this.emit()
        void this.scan(serial)
    }

    private key(id: string): string { return `${this.character.chaId}\u0000${id}` }

    private compact(chat: Pick<Chat, 'message'>): SearchMessage[] {
        return (chat.message ?? []).map((message, index) => ({
            data: message?.data ?? '', role: message?.role === 'user' ? 'user' : 'char', index, chatId: message?.chatId,
        }))
    }

    private remember(key: string, messages: SearchMessage[]): void {
        const chars = messages.reduce((sum, message) => sum + message.data.length, 0)
        if (chars > this.maxChars) return
        const old = this.cache.get(key)
        if (old) this.cacheChars -= old.reduce((sum, message) => sum + message.data.length, 0)
        this.cache.delete(key)
        while (this.cacheChars + chars > this.maxChars && this.cache.size) {
            const oldest = this.cache.keys().next().value as string
            const removed = this.cache.get(oldest)!
            this.cacheChars -= removed.reduce((sum, message) => sum + message.data.length, 0)
            this.cache.delete(oldest)
        }
        this.cache.set(key, messages)
        this.cacheChars += chars
    }

    private async read(chat: Chat, index: number): Promise<SearchMessage[] | null> {
        if (!chat._placeholder) return this.compact(chat) // Always live, never cached.
        const peek = this.peek ?? forageStorage.realStorage?.peekChatContent?.bind(forageStorage.realStorage)
        if (!chat.id || !peek) return []
        const key = this.key(chat.id)
        if (this.failed.has(key)) return null
        const cached = this.cache.get(key)
        if (cached) {
            this.cache.delete(key)
            this.cache.set(key, cached)
            return cached
        }
        const pending = this.inFlight.get(key)
        if (pending) return pending
        const task = (async () => {
            try {
                while (this.activeReads >= 2 && !this.controller.signal.aborted) {
                    await new Promise<void>(resolve => this.waiters.push(resolve))
                }
                if (this.controller.signal.aborted) return null
                this.activeReads++
                let body: Pick<Chat, 'message'> | null
                try { body = await peek(this.character.chaId, index, chat.id!, this.controller.signal) }
                finally { this.activeReads--; this.waiters.shift()?.() }
                if (this.controller.signal.aborted) return null
                if (!body) { this.failed.add(key); return null }
                const messages = this.compact(body)
                this.remember(key, messages)
                return messages
            } catch (error) {
                if (!this.controller.signal.aborted) this.failed.add(key)
                return null
            } finally { this.inFlight.delete(key) }
        })()
        this.inFlight.set(key, task)
        return task
    }

    private async scan(serial: number): Promise<void> {
        const chats = [...(this.character.chats ?? [])]
        let next = 0
        this.scanning = true
        const worker = async () => {
            while (next < chats.length && serial === this.serial && !this.controller.signal.aborted) {
                const index = next++
                const chat = chats[index]
                if (!chat) continue
                const messages = await this.read(chat, index)
                if (serial !== this.serial || this.controller.signal.aborted) return
                const key = this.key(chat.id ?? String(index))
                if (messages && chat.id) {
                    const terms = searchTerms(this.query)
                    const matching = messages.filter(message => messageMatches(message.data, terms))
                    this.matched.set(key, { count: matching.length, hits: matching.slice(0, 300).map(message => ({
                        botId: this.character.chaId, chatId: chat.id!, chatName: chat.name, messageId: message.chatId,
                        index: message.index, role: message.role, parts: messageSnippet(message.data, terms).parts,
                    })) })
                }
                this.done.add(key)
                this.emit()
            }
        }
        await Promise.all([worker(), worker()])
        if (serial === this.serial) { this.scanning = false; this.emit() }
    }

    private emit(): void {
        if (this.controller.signal.aborted) return
        const hits: SearchHit[] = []
        let count = 0
        for (const chat of this.character.chats ?? []) {
            if (!chat?.id) continue
            const matched = this.matched.get(this.key(chat.id))
            count += matched?.count ?? 0
            for (const hit of matched?.hits ?? []) {
                if (hits.length < 300) hits.push(hit)
            }
        }
        this.update({ hits, count, done: this.done.size, total: this.character.chats?.length ?? 0,
            failed: this.failed.size, reading: this.scanning })
    }
}
