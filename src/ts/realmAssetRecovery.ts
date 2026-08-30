import type { character } from './storage/database.svelte'
import { fetchRealmCharacter, getCharacterRealmId, getRisuHub, type hubType } from './characterCards'
import { forageStorage, requestImmediateSave } from './globalApi.svelte'
import { getDatabase } from './storage/database.svelte'

type AssetSlot = {
    key: string
    reference: string
    replace: (reference: string) => void
}

export type RealmRecoveryCandidate = hubType & { score: number }

export type RealmAssetRecoveryResult = {
    realmId: string
    recovered: number
    inspected: number
    remainingKnownMissing: number
}

function normalizeName(value: unknown): string {
    return String(value ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\[\](){}<>「」『』【】]/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ')
}

function slotKey(kind: string, name: unknown, extension: unknown = ''): string {
    return `${kind}:${normalizeName(name)}:${normalizeName(extension)}`
}

function characterAssetSlots(character: character): AssetSlot[] {
    const slots: AssetSlot[] = []
    if (character.image) {
        slots.push({ key: 'profile', reference: character.image, replace: (value) => { character.image = value } })
    }
    for (let index = 0; index < (character.emotionImages ?? []).length; index++) {
        const item = character.emotionImages[index]
        if (!item?.[1]) continue
        slots.push({
            key: slotKey('emotion', item[0], 'image'),
            reference: item[1],
            replace: (value) => { character.emotionImages[index][1] = value },
        })
    }
    for (let index = 0; index < (character.additionalAssets ?? []).length; index++) {
        const item = character.additionalAssets[index]
        if (!item?.[1]) continue
        slots.push({
            key: slotKey('asset', item[0], item[2] ?? ''),
            reference: item[1],
            replace: (value) => { character.additionalAssets[index][1] = value },
        })
    }
    for (let index = 0; index < (character.ccAssets ?? []).length; index++) {
        const item = character.ccAssets[index]
        if (!item?.uri) continue
        slots.push({
            key: slotKey(`cc-${item.type ?? 'asset'}`, item.name, item.ext),
            reference: item.uri,
            replace: (value) => { character.ccAssets[index].uri = value },
        })
    }
    return slots
}

async function assetExists(reference: string): Promise<boolean> {
    if (!reference) return false
    if (reference.startsWith('external://')) {
        try {
            const value = await forageStorage.readExternalAsset(reference)
            return Boolean(value?.length)
        } catch {
            return false
        }
    }
    if (reference.startsWith('assets/')) {
        try {
            const value = await forageStorage.getItem(reference) as Uint8Array | null
            return Boolean(value?.length)
        } catch {
            return false
        }
    }
    return true
}

function candidateQueues(character: character): Map<string, string[]> {
    const queues = new Map<string, string[]>()
    for (const slot of characterAssetSlots(character)) {
        const queue = queues.get(slot.key) ?? []
        queue.push(slot.reference)
        queues.set(slot.key, queue)
    }
    return queues
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

export function scoreRealmCandidate(character: character, candidate: hubType): number {
    const nameScore = tokenScore(normalizeName(character.name), normalizeName(candidate.name))
    const creator = normalizeName(character.creator ?? character.additionalData?.creator)
    const candidateCreator = normalizeName(candidate.creatorName ?? candidate.authorname ?? candidate.creator)
    const creatorBonus = creator && candidateCreator && creator === candidateCreator ? 0.15 : 0
    const assetBonus = candidate.hasAsset || candidate.hasEmotion ? 0.03 : 0
    return Math.min(1, nameScore * 0.82 + creatorBonus + assetBonus)
}

export async function findRealmRecoveryCandidates(character: character): Promise<RealmRecoveryCandidate[]> {
    const exactId = getCharacterRealmId(character)
    if (exactId) {
        return [{
            id: exactId,
            name: character.name,
            desc: '',
            download: '',
            img: '',
            tags: [],
            viewScreen: 'none',
            hasLore: false,
            hasEmotion: true,
            hasAsset: true,
            hot: 0,
            license: '',
            type: 'character',
            score: 1,
        }]
    }
    const candidates = await getRisuHub({ search: character.name, page: 0, nsfw: true, sort: '' })
    return candidates
        .map((candidate) => ({ ...candidate, score: scoreRealmCandidate(character, candidate) }))
        .filter((candidate) => candidate.score >= 0.45)
        .sort((left, right) => right.score - left.score)
        .slice(0, 8)
}

export async function recoverCharacterAssetsFromRealm(
    character: character,
    realmId = getCharacterRealmId(character),
): Promise<RealmAssetRecoveryResult> {
    if (!realmId) throw new Error('Realm source ID is required for asset recovery')
    const candidate = await fetchRealmCharacter(realmId)
    if (!candidate) throw new Error('Realm character could not be decoded')

    const queues = candidateQueues(candidate)
    const slots = characterAssetSlots(character)
    let recovered = 0
    let remainingKnownMissing = 0
    for (const slot of slots) {
        if (await assetExists(slot.reference)) continue
        const queue = queues.get(slot.key) ?? []
        let replacement = ''
        while (queue.length > 0 && !replacement) {
            const candidateReference = queue.shift() ?? ''
            if (await assetExists(candidateReference)) replacement = candidateReference
        }
        if (replacement) {
            slot.replace(replacement)
            recovered++
        } else {
            remainingKnownMissing++
        }
    }

    character.realmId = realmId
    character.extentions ??= {}
    character.extentions.risuRealmImportId = realmId
    if (character.sourceInfo) {
        const previous = Number(character.sourceInfo.missingAssetCount) || 0
        character.sourceInfo.missingAssetCount = Math.max(remainingKnownMissing, previous - recovered)
        character.sourceInfo.assetReferenceCount = Math.max(
            Number(character.sourceInfo.assetReferenceCount) || 0,
            slots.length,
        )
    }
    if ((Number(character.sourceInfo?.missingAssetCount) || 0) === 0) {
        const db = getDatabase()
        for (const entry of db.characterOrder ?? []) {
            if (typeof entry === 'string' || !entry?.name?.startsWith('[에셋 누락]')) continue
            entry.data = (entry.data ?? []).filter((chaId) => chaId !== character.chaId)
        }
        db.characterOrder = (db.characterOrder ?? []).filter((entry) => (
            typeof entry === 'string' || !entry?.name?.startsWith('[에셋 누락]') || (entry.data?.length ?? 0) > 0
        ))
    }
    if (recovered > 0) await requestImmediateSave()
    return { realmId, recovered, inspected: slots.length, remainingKnownMissing }
}
