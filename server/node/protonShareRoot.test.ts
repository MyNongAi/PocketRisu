import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error the committed bundle has no type declarations
import { rootLinkMeta } from './vendor/protonShare.mjs'

// Proton removed GET drive/urls/{token}; the shared item now comes from the
// /links POST (as in @protontech/drive-sdk). rootLinkMeta turns that entry
// into the fields the rest of the module read from the old reply.
describe('Proton share root from /links', () => {
    it('maps a shared folder', () => {
        const meta = rootLinkMeta({
            Link: { LinkID: 'root', Type: 1, Name: 'enc-name', NodeKey: 'key', NodePassphrase: 'pass', ModifyTime: 1700000000 },
            Folder: { NodeHashKey: 'h' },
            File: null,
        })
        expect(meta).toMatchObject({ LinkID: 'root', LinkType: 1, Name: 'enc-name', NodeKey: 'key', NodePassphrase: 'pass', ModifyTime: 1700000000, Size: null, MIMEType: null })
    })

    it('maps a shared file with its size and media type', () => {
        const meta = rootLinkMeta({
            Link: { LinkID: 'f', Type: 2, Name: 'n', NodeKey: 'k', NodePassphrase: 'p' },
            File: { ActiveRevision: { RevisionID: 'r', EncryptedSize: 1234 }, TotalEncryptedSize: 2000, MediaType: 'image/png', ContentKeyPacket: 'c' },
        })
        expect(meta).toMatchObject({ LinkID: 'f', LinkType: 2, Size: 1234, MIMEType: 'image/png' })
    })

    it('falls back to the total size, and rejects an empty reply', () => {
        expect(rootLinkMeta({ Link: { LinkID: 'f', Type: 2 }, File: { ActiveRevision: null, TotalEncryptedSize: 99 } })?.Size).toBe(99)
        expect(rootLinkMeta(undefined)).toBeNull()
        expect(rootLinkMeta({ Link: {} })).toBeNull()
    })

    it('no longer calls the removed endpoint', () => {
        for (const file of ['./vendor/protonShare.mjs', './proton/protonShare.ts']) {
            const source = readFileSync(new URL(file, import.meta.url), 'utf8')
            expect(source).not.toMatch(/api\(`drive\/urls\/\$\{token\}`/)
            expect(source).toContain('auth.Share.LinkID')
        }
    })
})
