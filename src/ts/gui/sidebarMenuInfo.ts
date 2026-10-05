// Header lines for the sidebar's right-click menus: the same facts the
// character manager lists for a bot (when it was imported, its source, chats,
// last chat, assets), and for a folder its bot count and import date range.
import { getCharacterAssetCount } from './characterAssetCount'
import { localOriginOf, resolveCharacterSourceBadge } from './characterSourceBadge'
import { formatImportedDate } from './importedDate'

export type MenuInfoCharacter = {
    name?: string
    chats?: readonly unknown[]
    /** Archived stubs keep a count instead of their chats. */
    chatCount?: number
    lastInteraction?: number
    importedAt?: number
    additionalAssets?: unknown[]
    additionalAssetManifest?: { count?: number }
    /** Archived stubs keep the count they had. */
    assetCount?: number
    sourceInfo?: {
        label?: unknown
        importedAt?: number
        missingAssetCount?: unknown
        assetReferenceCount?: number
    }
    realmId?: string
    /** Where it was downloaded from on Proton (protonSource.ts). */
    nodeOnlyProtonSource?: { file?: string }
}

/** When this install imported the card; 0 for cards that predate the field. */
export function characterImportedAt(character: MenuInfoCharacter): number {
    return character.importedAt ?? character.sourceInfo?.importedAt ?? 0
}

export function characterMenuInfo(character: MenuInfoCharacter, agoText: (time: number) => string): string {
    const imported = formatImportedDate(characterImportedAt(character))
    const source = resolveCharacterSourceBadge(character.sourceInfo?.label, { ...localOriginOf(character), stamp: characterImportedAt(character) })
    const chats = character.chats?.length ?? character.chatCount ?? 0
    const assets = character.assetCount ?? getCharacterAssetCount(character)
    const missing = Math.max(0, Number(character.sourceInfo?.missingAssetCount) || 0)
    const origin = [
        imported ? `가져온 날짜 ${imported}` : '가져온 날짜 기록 없음',
        `출처 [${source.label}]${source.recorded ? '' : '(추정)'}`,
        ...(character.nodeOnlyProtonSource?.file ? [`프로톤 파일 ${character.nodeOnlyProtonSource.file}`] : []),
    ]
    const usage = [`채팅 ${chats.toLocaleString()}개`]
    if ((character.lastInteraction ?? 0) > 0) usage.push(`최근 대화 ${agoText(character.lastInteraction!)}`)
    usage.push(`에셋 ${assets.toLocaleString()}개`)
    if (missing > 0) usage.push(`누락 ${missing.toLocaleString()}개`)
    return [character.name || 'Unnamed', origin.join(' · '), usage.join(' · ')].join('\n')
}

export function folderMenuInfo(name: string, members: readonly MenuInfoCharacter[]): string {
    const dates = members.map(characterImportedAt).filter((time) => time > 0)
    let range = '가져온 날짜 기록 없음'
    if (dates.length > 0) {
        const first = formatImportedDate(Math.min(...dates))
        const last = formatImportedDate(Math.max(...dates))
        range = first === last ? `가져온 날짜 ${first}` : `가져온 날짜 ${first} ~ ${last}`
        const unknown = members.length - dates.length
        if (unknown > 0) range += ` (기록 없음 ${unknown.toLocaleString()}개)`
    }
    return [name, `봇 ${members.length.toLocaleString()}개 · ${range}`].join('\n')
}
