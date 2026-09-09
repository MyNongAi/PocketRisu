export type ErrorMessagePresentation = {
    message: string
    original?: string
}

function structuredMessage(raw: string): string {
    if (!raw.startsWith('{')) return raw
    try {
        const parsed = JSON.parse(raw) as { message?: unknown, error?: unknown }
        if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim()
        if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim()
    } catch {}
    return raw
}

function translateKnownError(rawMessage: string): string | null {
    const raw = structuredMessage(rawMessage)
    let match: RegExpMatchArray | null

    match = raw.match(/^This chat is still generating on another page or device\. Try again in up to (\d+) seconds?\.?$/i)
    if (match) return `이 채팅은 다른 페이지나 기기에서 아직 생성 중입니다. 최대 ${match[1]}초 후 다시 시도해 주세요.`

    if (/^This chat is still generating on another page or device\./i.test(raw)
        || /^This chat is already generating on another page or device$/i.test(raw)
        || /^This chat is already active on another page or device\./i.test(raw)) {
        return '이 채팅은 다른 페이지나 기기에서 사용 중입니다. 기존 작업이 끝난 뒤 다시 시도해 주세요.'
    }

    if (/^This chat changed on another page or device\./i.test(raw)
        || /^Chat changed on another device$/i.test(raw)) {
        return '이 채팅이 다른 페이지나 기기에서 변경되었습니다. 메시지를 덮어쓰지 않도록 페이지를 새로고침한 뒤 다시 보내 주세요.'
    }

    if (/^Chat no longer exists on the server$/i.test(raw)) {
        return '이 채팅의 본문이 서버에 존재하지 않습니다. 다른 탭에서 삭제됐거나 이전 데이터 이전 과정에서 본문이 누락됐을 수 있습니다.'
    }

    match = raw.match(/^Failed to save (\d+) chats?(?::\s*(.+))?$/i)
    if (match) {
        const detail = match[2] ? translateKnownError(match[2]) : null
        return detail
            ? `채팅 ${match[1]}개를 저장하지 못했습니다. ${detail}`
            : `채팅 ${match[1]}개를 서버에 저장하지 못했습니다.`
    }

    if (/^Could not check this chat with the server\./i.test(raw)) {
        return '서버에서 이 채팅의 상태를 확인하지 못했습니다. 서버 연결을 확인한 뒤 다시 시도해 주세요.'
    }

    if (/^The server rejected this chat request\./i.test(raw)) {
        return '서버가 이 채팅 요청을 거부했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.'
    }

    if (/^The server has been updated or the network connection has been lost\./i.test(raw)) {
        return '서버가 업데이트되었거나 네트워크 연결이 끊겼습니다. 페이지를 새로고침해 주세요.'
    }

    if (/^At most two chats can generate at the same time\.?$/i.test(raw)) {
        return '동시에 생성할 수 있는 채팅은 최대 2개입니다. 진행 중인 응답이 끝난 뒤 다시 시도해 주세요.'
    }

    if (/request entity too large/i.test(raw)) {
        return '서버로 보내는 저장 데이터가 허용 크기를 초과했습니다. 큰 변경사항을 작은 단위로 나누거나 저장 요청 제한을 확인해 주세요.'
    }

    if (/^Card not found(?:, probably the card is still uploading)?$/i.test(raw)) {
        return 'RisuRealm에서 카드 파일을 찾지 못했습니다. 카드가 아직 업로드 중이거나 목록에서 제거된 상태일 수 있습니다.'
    }

    match = raw.match(/^Realm download failed:\s*(\d+)$/i)
    if (match) return `RisuRealm 카드 다운로드에 실패했습니다. 서버 응답 코드는 HTTP ${match[1]}입니다.`

    if (/^Realm response did not contain a character card$/i.test(raw)) {
        return 'RisuRealm 응답에 캐릭터 카드 데이터가 들어 있지 않습니다.'
    }
    if (/^Realm CharX did not contain card\.json$/i.test(raw)) {
        return 'RisuRealm의 CHARX 파일에 필수 card.json이 없습니다.'
    }
    if (/^Realm CharX is not a v3 character card$/i.test(raw)) {
        return 'RisuRealm의 CHARX 파일이 지원되는 V3 캐릭터 카드가 아닙니다.'
    }

    if (/Failed to fetch|NetworkError when attempting to fetch resource/i.test(raw)) {
        return '네트워크 요청에 실패했습니다. PocketRisu 서버와 인터넷 연결을 확인해 주세요.'
    }

    if (/^WebCrypto is unavailable in the PocketRisu host/i.test(raw)) {
        return '현재 접속 주소에서는 브라우저 암호화 기능을 사용할 수 없습니다. localhost 또는 HTTPS 주소로 접속해 주세요.'
    }

    if (/^Cold storage restore failed$/i.test(raw)) {
        return '서버의 채팅 보관소에서 데이터를 복원하지 못했습니다.'
    }

    return null
}

export function localizeErrorMessage(message: string, locale: string): ErrorMessagePresentation {
    const original = message.trim()
    if (!original || !locale.toLowerCase().startsWith('ko')) return { message: original }
    if (/[가-힣]/.test(original)) return { message: original }

    const translated = translateKnownError(original)
        ?? '알 수 없는 오류가 발생했습니다. 아래 원문을 복사해 진단에 사용해 주세요.'
    return translated === original
        ? { message: original }
        : { message: translated, original }
}

export function formatErrorCopyText(
    presentation: ErrorMessagePresentation,
    description?: string,
): string {
    const lines = [presentation.message]
    if (presentation.original && presentation.original !== presentation.message) {
        lines.push('', `[원문] ${presentation.original}`)
    }
    if (description?.trim()) lines.push('', description.trim())
    return lines.join('\n')
}
