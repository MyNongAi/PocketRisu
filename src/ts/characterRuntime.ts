type RuntimeChat = {
    message?: unknown[]
    id?: string
    localLore?: unknown[]
    fmIndex?: number
}

type RuntimeLore = {
    bookVersion?: number
}

export type RuntimeCharacter = {
    chats?: RuntimeChat[]
    chatPage?: number
    type?: string
    chaId?: string
    sdData?: unknown
    utilityBot?: boolean
    triggerscript?: unknown[]
    alternateGreetings?: unknown[]
    exampleMessage?: string
    creatorNotes?: string
    systemPrompt?: string
    tags?: string[]
    creator?: string
    characterVersion?: string
    personality?: string
    scenario?: string
    firstMsgIndex?: number
    additionalData?: unknown
    voicevoxConfig?: unknown
    postHistoryInstructions?: string | null
    additionalText?: string
    depth_prompt?: unknown
    hfTTS?: unknown
    backgroundHTML?: string
    backgroundCSS?: string
    creation_date?: number
    globalLore?: RuntimeLore[]
    newGenData?: unknown
    ttsMode?: string
    customscript?: unknown[]
}

const isNullish = (value: unknown) => value === null || value === undefined

/**
 * Character selection is a hot path. Avoid walking every lorebook and chat
 * when the card already satisfies the invariants characterFormatUpdate adds.
 */
export function needsCharacterRuntimeNormalization(char: RuntimeCharacter): boolean {
    const chats = char.chats
    const chatPage = char.chatPage
    if (!Array.isArray(chats) || chats.length === 0) return true
    if (!Number.isInteger(chatPage) || !chats[chatPage as number]) return true
    if (!Array.isArray(chats[chatPage as number].message)) return true

    if (!char.type || !char.chaId) return true
    if (isNullish(char.sdData) || isNullish(char.utilityBot)) return true
    if (!Array.isArray(char.triggerscript) || !Array.isArray(char.alternateGreetings)) return true
    if (isNullish(char.exampleMessage) || isNullish(char.creatorNotes) || isNullish(char.systemPrompt)) return true
    if (!Array.isArray(char.tags) || isNullish(char.creator) || isNullish(char.characterVersion)) return true
    if (isNullish(char.personality) || isNullish(char.scenario) || isNullish(char.firstMsgIndex)) return true
    if (isNullish(char.additionalData) || isNullish(char.voicevoxConfig)) return true
    if (isNullish(char.additionalText) || isNullish(char.depth_prompt) || isNullish(char.hfTTS)) return true
    if (isNullish(char.backgroundHTML) || isNullish(char.backgroundCSS) || isNullish(char.creation_date)) return true
    if (!char.newGenData || !Array.isArray(char.customscript) || isNullish(char.ttsMode) || char.ttsMode === 'none') return true

    if (!Array.isArray(char.globalLore) || char.globalLore.some((book) => (book?.bookVersion ?? 1) < 2)) return true
    if (chats.some((chat) => !chat?.id || !Array.isArray(chat.localLore) || isNullish(chat.fmIndex))) return true

    // The legacy formatter consumes this into the current chat note once.
    if (char.postHistoryInstructions) return true

    return false
}
