import { describe, expect, it, vi } from 'vitest'

// util.ts (encryptBuffer, decryptBuffer) pulls in the database; stub it so
// the import chain does not loop, as util.test.ts does.
vi.mock(import('./stores.svelte'), () => ({ selectedCharID: { subscribe: () => () => {} }, DBState: { db: {} }, selIdState: { selId: -1 } } as any))
vi.mock(import('./storage/database.svelte'), () => ({ getDatabase: () => ({}) } as any))

import { encodeRccCard, licenseEffect } from './rccCard'
import { CCLicenseData } from './licenses'
import { decryptBuffer } from './util'

// Reads a card the way Risu's importer does (characterCards.ts, `rcc||`).
async function readLikeRisu(value: string, password?: string) {
    const parts = value.split('||')
    expect(parts.slice(0, 2)).toEqual(['rcc', 'rccv1'])
    expect(parts).toHaveLength(5)
    const encrypted = Buffer.from(parts[2], 'base64')
    const hashed = Buffer.from(await crypto.subtle.digest('SHA-256', encrypted)).toString('hex')
    expect(hashed).toBe(parts[3])
    const meta = JSON.parse(Buffer.from(parts[4], 'base64').toString('utf-8'))
    const key = meta.usePassword ? password : 'RISU_NONE'
    return { meta, card: JSON.parse(Buffer.from(await decryptBuffer(encrypted, key)).toString('utf-8')) }
}

const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '테스트 봇', description: '설명 😀', extensions: { risuai: { license: 'private' } } } }

describe('encodeRccCard', () => {
    it('makes a card Risu opens without asking when there is no password', async () => {
        const { meta, card: read } = await readLikeRisu(await encodeRccCard(card))
        expect(meta).toEqual({})
        expect(read).toEqual(card)
    })

    it('asks for the password and opens only with it', async () => {
        const value = await encodeRccCard(card, '긴 비밀번호 123')
        const { meta, card: read } = await readLikeRisu(value, '긴 비밀번호 123')
        expect(meta).toEqual({ usePassword: true })
        expect(read).toEqual(card)
        await expect(readLikeRisu(value, '틀린 비밀번호')).rejects.toThrow()
    })

    it('says what Risu does with each license it offers', () => {
        expect(licenseEffect('')).toBe('none')
        expect(licenseEffect(undefined)).toBe('none')
        expect(licenseEffect('private')).toBe('private')
        expect(Object.keys(CCLicenseData).map((license) => [license, licenseEffect(license)])).toEqual([
            ['CC BY 4.0', 'label'],
            ['CC BY-NC 4.0', 'label'],
            ['CC BY-NC-SA 4.0', 'noExport'],
            ['CC BY-SA 4.0', 'noExport'],
            ['CC BY-ND 4.0', 'noExport'],
            ['CC BY-NC-ND 4.0', 'noExport'],
            ['private', 'private'],
        ])
    })

    it('keeps the card unreadable as a plain card', async () => {
        const value = await encodeRccCard(card)
        expect(value).not.toContain('테스트 봇')
        expect(() => JSON.parse(Buffer.from(value, 'base64').toString('utf-8'))).toThrow()
    })
})
