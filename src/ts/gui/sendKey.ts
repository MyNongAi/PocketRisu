// The send-key rule shared by the chat input and the message edit box:
// whether an Enter keydown should act (send, or finish an edit) rather than
// insert a newline. Mobile uses sendKeyMobile, desktop sendKeyPC.
export type SendKeyMode = 'enter' | 'ctrl-enter' | 'shift-enter' | 'button'

type KeyState = Pick<KeyboardEvent, 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>

/** Match the configured combo exactly: every other modifier must be absent,
 *  so e.g. Alt+Enter or Ctrl+Shift+Enter inserts a newline instead. */
export function isSendKey(e: KeyState, mode: SendKeyMode | undefined): boolean {
    switch (mode) {
        case 'enter': return !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
        case 'ctrl-enter': return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
        case 'shift-enter': return e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
        default: return false // 'button'
    }
}
