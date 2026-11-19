// SEND-ECHO (2026-11-20): display-only text while a composer send is preparing.
export interface PendingSendEcho {
    sendId: string
    text: string
}

export function setSendEcho(echoes: Map<string, PendingSendEcho>, chatId: string, echo: PendingSendEcho): Map<string, PendingSendEcho> {
    const next = new Map(echoes)
    next.set(chatId, echo)
    return next
}

export function clearSendEcho(echoes: Map<string, PendingSendEcho>, chatId: string, sendId: string): Map<string, PendingSendEcho> {
    if (echoes.get(chatId)?.sendId !== sendId) return echoes
    const next = new Map(echoes)
    next.delete(chatId)
    return next
}
