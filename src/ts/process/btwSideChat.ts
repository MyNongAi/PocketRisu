import type { OpenAIChat } from './index.svelte'

// BTW side chat: out-of-character questions about the current chat ("by the
// way, what does she know so far?") answered by the chat's own model without
// adding anything to the chat. Pure request building lives here so it can be
// tested without the database, parser or request layer; btwSideChat.svelte.ts
// gathers the inputs and sends them.
//
// The request is built from raw stored text on purpose. The main prompt runs
// the CBS parser, regex scripts and triggers over the same text, and those can
// write chat variables (chat.scriptstate) — a side question must not. Only the
// plain {{char}}/{{user}} placeholders are filled in.

export interface BtwExchange {
    question: string
    answer: string
    time: number
}

/** The fields of a chat message the transcript reads. */
export interface BtwTranscriptMessage {
    role: 'user' | 'char'
    data: string
    disabled?: false | true | 'allBefore'
    saying?: string
}

export const BTW_LIMITS = {
    /** Newest chat messages sent as context. */
    contextMessages: 30,
    /** Character budget of that transcript; the oldest lines are dropped first. */
    contextChars: 20000,
    /** Character card (description, personality, scenario). */
    cardChars: 8000,
    personaChars: 2000,
    /** Earlier side exchanges sent along so follow-up questions work. */
    historyExchanges: 6,
    /** Each earlier answer is cut to this length when sent as history. */
    historyAnswerChars: 3000,
    /** Exchanges kept per chat. */
    storedExchanges: 20,
    questionChars: 4000,
} as const

export const BTW_SYSTEM_INSTRUCTION = [
    'You are an out-of-character assistant for a roleplay chat. The user is stepping outside the story to ask you a side question ("by the way") about it.',
    'This side conversation is not part of the story: do not continue the roleplay, do not speak as the character, and do not narrate new events unless the user asks for a suggestion or a draft.',
    'Base your answer on the character information, the user persona and the recent chat log below. If they do not cover something, say so instead of inventing it.',
    'Answer in the language of the user\'s question, clearly and concisely.',
].join('\n')

const THOUGHTS_BLOCK = /<Thoughts>[\s\S]*?<\/Thoughts>/gi
const THOUGHTS_OPEN_TAIL = /<Thoughts>[\s\S]*$/i
const INLAY_TOKEN = /{{(?:inlay|inlayed|inlayeddata)::[^}]*}}/gi

/** Drops reasoning blocks, including one still open while a reply streams. */
export function stripBtwThoughts(text: string): string {
    return (text ?? '').replace(THOUGHTS_BLOCK, '').replace(THOUGHTS_OPEN_TAIL, '')
}

/** Message text as the side model should see it: no reasoning, no inlay asset tokens. */
export function cleanBtwMessageText(text: string): string {
    return stripBtwThoughts(text).replace(INLAY_TOKEN, '').trim()
}

/** Plain {{char}}/{{user}} placeholders only; any other macro stays as written. */
export function fillBtwPlaceholders(text: string, charName: string, userName: string): string {
    // Replacer functions: a name containing "$&" must not be read as a pattern.
    return (text ?? '')
        .replace(/{{(?:char|bot)}}|<(?:char|bot)>/gi, () => charName)
        .replace(/{{user}}|<user>/gi, () => userName)
}

/** Keeps the start of the text. */
export function truncateBtwText(text: string, max: number): string {
    if (text.length <= max) return text
    return text.slice(0, Math.max(0, max - 1)) + '…'
}

/** Keeps the end of the text (the newest part of a long message). */
function truncateBtwTextStart(text: string, max: number): string {
    if (text.length <= max) return text
    return '…' + text.slice(text.length - Math.max(0, max - 1))
}

export interface BtwTranscript {
    /** "Name: text" lines, oldest first. */
    lines: string[]
    /** Visible messages that did not fit. */
    omitted: number
}

export interface BtwTranscriptOptions {
    maxMessages?: number
    maxChars?: number
    /** Greeting shown before the first message; added only when the whole chat fits. */
    greeting?: { name: string, text: string }
    /** Applied to each selected message's text (placeholder filling). */
    fill?: (text: string) => string
}

/**
 * The newest messages of the chat as transcript lines, bounded by message
 * count and characters. Visibility follows the main prompt: disabled messages
 * are skipped and an "everything before" marker hides itself and all older
 * messages.
 */
export function selectBtwTranscript(
    messages: readonly BtwTranscriptMessage[],
    nameOf: (message: BtwTranscriptMessage) => string,
    options: BtwTranscriptOptions = {},
): BtwTranscript {
    const maxMessages = options.maxMessages ?? BTW_LIMITS.contextMessages
    const maxChars = options.maxChars ?? BTW_LIMITS.contextChars
    const fill = options.fill ?? ((text: string) => text)

    const visible: BtwTranscriptMessage[] = []
    let cutByMarker = false
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.disabled === true) continue
        if (message.disabled === 'allBefore') {
            cutByMarker = true
            break
        }
        visible.push(message)
    }

    // Newest first while filling the budget.
    const lines: string[] = []
    let used = 0
    let taken = 0
    for (const message of visible) {
        if (lines.length >= maxMessages) break
        const text = cleanBtwMessageText(fill(message.data ?? ''))
        taken++
        if (!text) continue
        const prefix = `${nameOf(message)}: `
        let line = prefix + text
        const remaining = maxChars - used
        if (line.length > remaining) {
            // A single huge newest message still contributes its end.
            if (lines.length > 0 || remaining <= prefix.length + 1) {
                taken--
                break
            }
            line = prefix + truncateBtwTextStart(text, remaining - prefix.length)
        }
        lines.push(line)
        used += line.length + 1
    }
    lines.reverse()

    const omitted = visible.length - taken
    const greeting = options.greeting
    if (greeting && omitted === 0 && !cutByMarker) {
        const text = cleanBtwMessageText(fill(greeting.text))
        const line = `${greeting.name}: ${text}`
        if (text && used + line.length <= maxChars) lines.unshift(line)
    }
    return { lines, omitted }
}

export interface BtwRequestInput {
    characterName: string
    /** Description, personality and scenario, placeholders already filled. */
    characterCard: string
    userName: string
    personaPrompt: string
    transcript: BtwTranscript
    history: readonly BtwExchange[]
    question: string
}

function escapeAttribute(value: string): string {
    return value.replace(/"/g, '\'')
}

/**
 * One system message (instruction, card, persona, chat log), then the earlier
 * side exchanges as user/assistant turns, then the question. A single leading
 * system message and strict alternation suit every provider path.
 */
export function buildBtwRequestMessages(input: BtwRequestInput): OpenAIChat[] {
    const sections: string[] = [BTW_SYSTEM_INSTRUCTION]

    const card = truncateBtwText(input.characterCard.trim(), BTW_LIMITS.cardChars)
    sections.push(card
        ? `<character name="${escapeAttribute(input.characterName)}">\n${card}\n</character>`
        : `<character name="${escapeAttribute(input.characterName)}" />`)

    const persona = truncateBtwText(input.personaPrompt.trim(), BTW_LIMITS.personaChars)
    sections.push(persona
        ? `<user_persona name="${escapeAttribute(input.userName)}">\n${persona}\n</user_persona>`
        : `<user_persona name="${escapeAttribute(input.userName)}" />`)

    const { lines, omitted } = input.transcript
    if (lines.length === 0) {
        sections.push('<chat_log>\n(The chat has no messages yet.)\n</chat_log>')
    } else {
        const note = omitted > 0
            ? `The last ${lines.length} messages; ${omitted} earlier messages are not shown.`
            : 'The whole chat so far.'
        sections.push(`<chat_log note="${note}">\n${lines.join('\n')}\n</chat_log>`)
    }

    const messages: OpenAIChat[] = [{ role: 'system', content: sections.join('\n\n') }]
    for (const exchange of input.history.slice(-BTW_LIMITS.historyExchanges)) {
        messages.push({ role: 'user', content: exchange.question })
        messages.push({ role: 'assistant', content: truncateBtwText(exchange.answer, BTW_LIMITS.historyAnswerChars) })
    }
    messages.push({ role: 'user', content: truncateBtwText(input.question.trim(), BTW_LIMITS.questionChars) })
    return messages
}

/** Appends an exchange, keeping only the newest `keep`. */
export function appendBtwExchange(history: readonly BtwExchange[], exchange: BtwExchange, keep: number = BTW_LIMITS.storedExchanges): BtwExchange[] {
    return [...history, exchange].slice(-keep)
}
