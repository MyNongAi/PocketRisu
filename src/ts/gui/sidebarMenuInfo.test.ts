import { describe, expect, it } from 'vitest'
import { characterImportedAt, characterMenuInfo, folderMenuInfo } from './sidebarMenuInfo'

const ago = (time: number) => `ago(${time})`
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime()

describe('characterMenuInfo', () => {
    it('lists the import date, source, chats, last chat, assets and missing assets', () => {
        const text = characterMenuInfo({
            name: '봇',
            chats: [{}, {}, {}],
            lastInteraction: 5,
            sourceInfo: { label: '모바일웹리스', importedAt: at(2026, 8, 30), missingAssetCount: 4, assetReferenceCount: 12 },
        }, ago)
        expect(text).toBe('봇\n가져온 날짜 26.08.30 · 출처 [모바일]\n채팅 3개 · 최근 대화 ago(5) · 에셋 12개 · 누락 4개')
    })

    it('says when the import date was never recorded and marks a guessed source', () => {
        const text = characterMenuInfo({ name: '', chats: [] }, ago)
        expect(text).toBe('Unnamed\n가져온 날짜 기록 없음 · 출처 [웹](추정)\n채팅 0개 · 에셋 0개')
    })

    it('uses the counts an archived stub keeps', () => {
        const text = characterMenuInfo({ name: '보관', chatCount: 7, assetCount: 2, importedAt: at(2026, 10, 1) }, ago)
        expect(text).toContain('가져온 날짜 26.10.01')
        expect(text).toContain('채팅 7개 · 에셋 2개')
    })

    it('prefers the card import time over the source collection time', () => {
        expect(characterImportedAt({ importedAt: 2, sourceInfo: { importedAt: 1 } })).toBe(2)
        expect(characterImportedAt({ sourceInfo: { importedAt: 1 } })).toBe(1)
        expect(characterImportedAt({})).toBe(0)
    })
})

describe('folderMenuInfo', () => {
    it('shows the range of import dates and how many bots have none', () => {
        const text = folderMenuInfo('폴더', [
            { importedAt: at(2026, 9, 3) },
            { importedAt: at(2026, 8, 30) },
            {},
        ])
        expect(text).toBe('폴더\n봇 3개 · 가져온 날짜 26.08.30 ~ 26.09.03 (기록 없음 1개)')
    })

    it('shows one date when every bot came the same day', () => {
        expect(folderMenuInfo('폴더', [{ importedAt: at(2026, 10, 2) }, { importedAt: at(2026, 10, 2) + 1000 }]))
            .toBe('폴더\n봇 2개 · 가져온 날짜 26.10.02')
    })

    it('says when no bot has a recorded date', () => {
        expect(folderMenuInfo('빈 폴더', [])).toBe('빈 폴더\n봇 0개 · 가져온 날짜 기록 없음')
    })
})
