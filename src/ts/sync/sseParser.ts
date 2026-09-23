// Incremental parser for a text/event-stream body read through fetch (an
// EventSource cannot send PocketRisu's auth header). Chunks may split a frame
// anywhere, including inside a multi-byte character, so callers feed decoded
// text from a streaming TextDecoder and this keeps the unfinished tail.

export interface SseMessage {
    event: string
    data: string
    id?: string
}

export function createSseParser(onMessage: (message: SseMessage) => void): (chunk: string) => void {
    let pending = ''

    function dispatch(frame: string) {
        let event = 'message'
        let id: string | undefined
        const data: string[] = []
        for (const line of frame.split('\n')) {
            if (line === '' || line.startsWith(':')) continue
            const colon = line.indexOf(':')
            const field = colon === -1 ? line : line.slice(0, colon)
            let value = colon === -1 ? '' : line.slice(colon + 1)
            if (value.startsWith(' ')) value = value.slice(1)
            if (field === 'event') event = value
            else if (field === 'data') data.push(value)
            else if (field === 'id') id = value
        }
        if (data.length === 0) return
        onMessage({ event, data: data.join('\n'), id })
    }

    return (chunk: string) => {
        pending += chunk.replace(/\r\n?/g, '\n')
        let boundary = pending.indexOf('\n\n')
        while (boundary !== -1) {
            dispatch(pending.slice(0, boundary))
            pending = pending.slice(boundary + 2)
            boundary = pending.indexOf('\n\n')
        }
    }
}
