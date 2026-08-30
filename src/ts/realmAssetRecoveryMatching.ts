type RealmRecoveryCharacterLike = {
    name?: unknown
    creator?: unknown
    additionalData?: { creator?: unknown }
}

type RealmRecoveryCandidateLike = {
    name?: unknown
    creatorName?: unknown
    authorname?: unknown
    creator?: unknown
    hasAsset?: unknown
    hasEmotion?: unknown
}

export function normalizeRealmName(value: unknown): string {
    return String(value ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\[\](){}<>「」『』【】]/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ')
}

function tokenScore(left: string, right: string): number {
    if (!left || !right) return 0
    if (left === right) return 1
    if (left.includes(right) || right.includes(left)) return 0.82
    const a = new Set(left.split(' ').filter(Boolean))
    const b = new Set(right.split(' ').filter(Boolean))
    let intersection = 0
    for (const token of a) if (b.has(token)) intersection++
    return (2 * intersection) / Math.max(1, a.size + b.size)
}

export function scoreRealmCandidate(
    character: RealmRecoveryCharacterLike,
    candidate: RealmRecoveryCandidateLike,
): number {
    const nameScore = tokenScore(normalizeRealmName(character.name), normalizeRealmName(candidate.name))
    const creator = normalizeRealmName(character.creator ?? character.additionalData?.creator)
    const candidateCreator = normalizeRealmName(candidate.creatorName ?? candidate.authorname ?? candidate.creator)
    const creatorBonus = creator && candidateCreator && creator === candidateCreator ? 0.15 : 0
    const assetBonus = candidate.hasAsset || candidate.hasEmotion ? 0.03 : 0
    return Math.min(1, nameScore * 0.82 + creatorBonus + assetBonus)
}
