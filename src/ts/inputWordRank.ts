import { writable } from 'svelte/store'
import { forageStorage } from './globalApi.svelte'
import type { NodeStorage } from './storage/nodeStorage'

/**
 * Input word rank popup (src/lib/Others/InputWordRankDialog.svelte): the
 * words, phrases and sentences the user writes most. The server counts
 * (server/node/input-word-rank.cjs, the rules of plugins/input-word-rank) so
 * deactivated bots can be included without sending their chats here.
 */
export const inputWordRankOpen = writable(false)

export type InputWordRankScope = 'chat' | 'char' | 'all'

export interface InputWordRankOptions {
    scope: InputWordRankScope
    deactivated: boolean
    particles: boolean
    parens: boolean
    english: boolean
    botInputs: boolean
    exclude: string
}

export interface InputWordRankRequest extends InputWordRankOptions {
    chaId?: string
    chatId?: string
    limit?: number
}

export type InputWordRankRow = [text: string, count: number]

export interface InputWordRankTotals {
    bots: number
    deactivatedBots: number
    chats: number
    inputs: number
    copies: number
    botInputs: number
    words: number
    failed: number
    approximate: boolean
    stopped: boolean
}

export interface InputWordRankResult {
    words: InputWordRankRow[]
    phrases: InputWordRankRow[]
    sentences: InputWordRankRow[]
    totals: InputWordRankTotals
}

export const INPUT_WORD_RANK_DEFAULTS: InputWordRankOptions = {
    scope: 'char', deactivated: true, particles: true, parens: false, english: false, botInputs: true, exclude: '',
}

const OPTIONS_KEY = 'risu-input-word-rank'

/** The options last used on this device (kept like the plugin's, per device). */
export function loadInputWordRankOptions(): InputWordRankOptions {
    try {
        const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null')
        if (saved && typeof saved === 'object') return { ...INPUT_WORD_RANK_DEFAULTS, ...saved }
    } catch {}
    return { ...INPUT_WORD_RANK_DEFAULTS }
}

export function saveInputWordRankOptions(options: InputWordRankOptions) {
    try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(options)) } catch {}
}

export function rankInputWords(request: InputWordRankRequest, signal?: AbortSignal): Promise<InputWordRankResult | null> {
    return (forageStorage.realStorage as NodeStorage).rankInputWords(request, signal)
}
