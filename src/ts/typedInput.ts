// Which user messages are the user's own input (the user's request,
// 2026-11-07: "내가 직접 넣은 인풋만 제목으로", and the same for the input
// shown under a reply). Bots also put user messages in the chat: a panel's
// request ("[ACADEMY_REQUEST:2:1:19] ...", Lua addChat/insertChat or a
// trigger's add-chat), or a context block their Lua appends to what the user
// typed ("[SIM_REQUEST_CONTEXT] ... [/SIM_REQUEST_CONTEXT]").
//
// A message sent from the input box carries its send time; one a script adds
// does not (in the live DB, the untimed user messages were bots' commands and
// records). The empty send ("*says nothing*") has none either.

type InputMessage = { role?: string, data?: string, time?: number }

/** `[UPPER_NAME]...[/UPPER_NAME]` (or `[UPPER_NAME:args]`): a block a bot appends to the input. */
const SYSTEM_BLOCK = /\n?\[([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?::[^\]\n]*)?\][\s\S]*?\[\/\1\]/g

/** The text without the blocks a bot's script adds to an input, as the user typed it. */
export function withoutSystemBlocks(text: string): string {
    return text.replace(SYSTEM_BLOCK, '').trimEnd()
}

/** Whether a message is an input the user sent from the input box, with something they typed in it. */
export function isTypedInput(message: InputMessage | undefined): boolean {
    if (message?.role !== 'user' || !message.time || typeof message.data !== 'string') return false
    const text = withoutSystemBlocks(message.data).trim()
    return text !== '' && text !== '*says nothing*'
}
