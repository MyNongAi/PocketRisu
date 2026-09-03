import type { character } from './storage/database.svelte'
import { fetchRealmCharacter, getCharacterRealmId, getRisuHub, type hubType } from './characterCards'
import { moveCharacterToRecoveryFolder, releaseCharacterFromMissingFolders } from './characterRecoveryFolders'
import { forageStorage, requestImmediateSave } from './globalApi.svelte'
import {
    normalizeRealmName,
    scoreRealmCandidate,
    selectStrictRealmRecoveryCandidate,
} from './realmAssetRecoveryMatching'
import { getDatabase } from './storage/database.svelte'
import { v4 as uuidv4 } from 'uuid'

export { scoreRealmCandidate } from './realmAssetRecoveryMatching'

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

export const MOBILE_WEB_MISSING_ASSET_FOLDER = '[에셋 누락] 모바일웹리스'
export const PROTON_RECOVERY_FOLDER = '프로톤'

export type RealmFolderRecoveryProgress = {
    current: number
    total: number
    characterName: string
    phase: 'checking' | 'searching' | 'downloading' | 'saving'
    recoveredCharacters: number
    recoveredAssets: number
    movedToProton: number
    failed: number
}

export type RealmFolderRecoveryResult = {
    targetFolder: string
    total: number
    processed: number
    exactSourceIds: number
    strictTitleMatches: number
    recoveredCharacters: number
    recoveredAssets: number
    alreadyHealthy: number
    movedToProton: number
    noRealmMatch: number
    ambiguous: number
    failed: number
    canceled: boolean
    failures: { chaId: string, name: string, error: string }[]
}

function slotKey(kind: string, name: unknown, extension: unknown = ''): string {
    return `${kind}:${normalizeRealmName(name)}:${normalizeRealmName(extension)}`
}

function realmCardAssetSlotKey(asset: { type?: unknown, name?: unknown, ext?: unknown }): string {
    const type = String(asset.type ?? 'asset')
    if (type === 'icon' && asset.name === 'main') return 'profile'
    if (type === 'emotion') return slotKey('emotion', asset.name, 'image')
    if (type === 'x-risu-asset') return slotKey('asset', asset.name, asset.ext ?? 'unknown')
    return slotKey(`cc-${type}`, asset.name, asset.ext ?? 'unknown')
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
    options: { save?: boolean } = {},
): Promise<RealmAssetRecoveryResult> {
    if (!realmId) throw new Error('Realm source ID is required for asset recovery')
    const slots = characterAssetSlots(character)
    const needed = new Map<string, number>()
    for (const slot of slots) {
        if (await assetExists(slot.reference)) continue
        needed.set(slot.key, (needed.get(slot.key) ?? 0) + 1)
    }
    const candidate = await fetchRealmCharacter(realmId, {
        includePrimaryImage: needed.has('profile'),
        selectAssets: (assets) => {
            const remaining = new Map(needed)
            return assets.filter((asset) => {
                const key = realmCardAssetSlotKey(asset)
                const count = remaining.get(key) ?? 0
                if (count <= 0) return false
                remaining.set(key, count - 1)
                return true
            })
        },
    })
    if (!candidate) throw new Error('Realm character could not be decoded')

    const queues = candidateQueues(candidate)
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
        character.sourceInfo.missingAssetCount = remainingKnownMissing
        character.sourceInfo.assetReferenceCount = Math.max(
            Number(character.sourceInfo.assetReferenceCount) || 0,
            slots.length,
        )
    }
    if ((Number(character.sourceInfo?.missingAssetCount) || 0) === 0) {
        const db = getDatabase()
        db.characterOrder = releaseCharacterFromMissingFolders(db.characterOrder ?? [], character.chaId)
    }
    if (recovered > 0 && options.save !== false) await requestImmediateSave()
    return { realmId, recovered, inspected: slots.length, remainingKnownMissing }
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException('Realm folder recovery was canceled.', 'AbortError')
}

/**
 * Sequential, resumable-in-practice recovery for one explicit source folder.
 * No fuzzy candidate is ever downloaded automatically. Cards without a safe
 * Realm match (or with still-missing slots after recovery) are moved into the
 * Proton folder so they remain visible for a later Proton-card repair pass.
 */
export async function recoverCharacterFolderAssetsFromRealm(
    targetFolderName = MOBILE_WEB_MISSING_ASSET_FOLDER,
    options: {
        signal?: AbortSignal
        onProgress?: (progress: RealmFolderRecoveryProgress) => void
    } = {},
): Promise<RealmFolderRecoveryResult> {
    const db = getDatabase()
    const targetFolder = (db.characterOrder ?? []).find((entry) => (
        typeof entry !== 'string' && entry.name === targetFolderName
    ))
    const targetIds = typeof targetFolder === 'string' || !targetFolder
        ? []
        : [...new Set(targetFolder.data ?? [])]
    const characters = new Map((db.characters ?? []).map((character) => [character.chaId, character]))
    const result: RealmFolderRecoveryResult = {
        targetFolder: targetFolderName,
        total: targetIds.length,
        processed: 0,
        exactSourceIds: 0,
        strictTitleMatches: 0,
        recoveredCharacters: 0,
        recoveredAssets: 0,
        alreadyHealthy: 0,
        movedToProton: 0,
        noRealmMatch: 0,
        ambiguous: 0,
        failed: 0,
        canceled: false,
        failures: [],
    }

    const progress = (characterName: string, phase: RealmFolderRecoveryProgress['phase']) => {
        options.onProgress?.({
            current: result.processed,
            total: result.total,
            characterName,
            phase,
            recoveredCharacters: result.recoveredCharacters,
            recoveredAssets: result.recoveredAssets,
            movedToProton: result.movedToProton,
            failed: result.failed,
        })
    }

    for (const chaId of targetIds) {
        const character = characters.get(chaId)
        if (!character || character.trashTime) {
            result.processed++
            continue
        }
        try {
            throwIfAborted(options.signal)
            progress(character.name, 'checking')
            if ((Number(character.sourceInfo?.missingAssetCount) || 0) <= 0) {
                db.characterOrder = releaseCharacterFromMissingFolders(db.characterOrder ?? [], chaId)
                result.alreadyHealthy++
                result.processed++
                continue
            }

            let realmId = getCharacterRealmId(character)
            if (realmId) {
                result.exactSourceIds++
            } else {
                progress(character.name, 'searching')
                const candidates = await getRisuHub({ search: character.name, page: 0, nsfw: true, sort: '' })
                throwIfAborted(options.signal)
                const exactTitles = candidates.filter((candidate) => (
                    normalizeRealmName(candidate.name) === normalizeRealmName(character.name)
                ))
                const selected = selectStrictRealmRecoveryCandidate(character, candidates)
                if (!selected) {
                    if (exactTitles.length > 1) result.ambiguous++
                    else result.noRealmMatch++
                    db.characterOrder = moveCharacterToRecoveryFolder(
                        db.characterOrder ?? [], chaId, PROTON_RECOVERY_FOLDER, uuidv4(),
                    )
                    result.movedToProton++
                    result.processed++
                    continue
                }
                realmId = selected.id
                result.strictTitleMatches++
            }

            progress(character.name, 'downloading')
            const recovered = await recoverCharacterAssetsFromRealm(character, realmId, { save: false })
            result.recoveredAssets += recovered.recovered
            if (recovered.remainingKnownMissing === 0) {
                db.characterOrder = releaseCharacterFromMissingFolders(db.characterOrder ?? [], chaId)
                result.recoveredCharacters++
            } else {
                db.characterOrder = moveCharacterToRecoveryFolder(
                    db.characterOrder ?? [], chaId, PROTON_RECOVERY_FOLDER, uuidv4(),
                )
                result.movedToProton++
            }
            result.processed++
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                result.canceled = true
                break
            }
            result.failed++
            result.processed++
            result.failures.push({
                chaId,
                name: character.name,
                error: error instanceof Error ? error.message : String(error),
            })
        }

        if (result.processed > 0 && result.processed % 10 === 0) {
            progress(character.name, 'saving')
            await requestImmediateSave()
        }
    }

    if (result.processed > 0) {
        progress('', 'saving')
        await requestImmediateSave()
    }
    return result
}
