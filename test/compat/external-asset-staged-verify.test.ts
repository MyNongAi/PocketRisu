import { afterAll, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Packr } from 'msgpackr'
import { zipSync } from 'fflate'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { normalizeBackup } from './helpers/normalize.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const sessionHeaders = { 'x-session-id': 'external-stage-verify', 'x-user-active': '1' }
const servers: ServerHandle[] = []

afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

function rawDatabase(assetKey: string): Buffer {
    return Buffer.concat([MAGIC_RAW, packr.encode({
        characters: [{
            name: 'External asset test',
            chaId: 'external-test',
            type: 'character',
            image: assetKey,
            additionalAssets: [],
            chats: [],
            chatPage: 0,
            firstMessage: 'hello',
        }],
        modules: [],
        personas: [],
        botPresets: [],
        botPresetsId: 0,
        selectedCharacter: 0,
    })])
}

function saveFolderZip(entries: Record<string, Buffer>): Buffer {
    return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([key, value]) => [
        Buffer.from(key, 'utf-8').toString('hex'),
        new Uint8Array(value),
    ]))))
}

async function waitForJob(client: RisuClient, jobId: string, statuses: string[], timeoutMs = 15_000): Promise<any> {
    const deadline = Date.now() + timeoutMs
    let last: any = null
    while (Date.now() < deadline) {
        const response = await client.fetch(`/api/external-assets/migrate/jobs/${encodeURIComponent(jobId)}`)
        expect(response.status).toBe(200)
        last = (await response.json()).job
        if (statuses.includes(last.status)) return last
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out waiting for ${statuses.join('/')} (last: ${last?.status})`)
}

describe('external asset staged-copy verification API', () => {
    test('blocks publish until a failed provider object is repaired and fully reverified', async () => {
        const server = await spawnServer()
        servers.push(server)
        const client = await createClient(server.port, server.password)
        const assetKey = 'assets/staged-verify.png'
        const asset = Buffer.from('provider object checked immediately before publish')
        const upload = await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/zip', ...sessionHeaders },
            body: new Uint8Array(saveFolderZip({
                'database/database.bin': rawDatabase(assetKey),
                [assetKey]: asset,
            })),
        })
        expect(upload.status).toBe(200)

        const start = await client.fetch('/api/external-assets/migrate/execute', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...sessionHeaders },
            body: JSON.stringify({ providerId: 'local' }),
        })
        expect(start.status).toBe(202)
        const migrationId = (await start.json()).migrationId as string
        const staged = await waitForJob(client, migrationId, ['staged', 'failed'])
        expect(staged).toMatchObject({ status: 'staged', stagedItems: 1, verifiedStagedItems: 0 })

        const earlyPublish = await client.fetch(`/api/external-assets/migrate/jobs/${migrationId}/finalize`, {
            method: 'POST', headers: sessionHeaders,
        })
        expect(earlyPublish.status).toBe(409)

        const hash = createHash('sha256').update(asset).digest('hex')
        const providerObject = path.join(server.cwd, 'save', 'external-assets', 'store', hash.slice(0, 2), hash)
        // Keep the size identical so the pass must perform the promised GET +
        // SHA-256 rather than succeeding from stat alone.
        await writeFile(providerObject, Buffer.alloc(asset.length, 0x78))

        const verifyBad = await client.fetch(`/api/external-assets/migrate/jobs/${migrationId}/verify-staged`, {
            method: 'POST', headers: sessionHeaders,
        })
        expect(verifyBad.status).toBe(202)
        const failed = await waitForJob(client, migrationId, ['verification-failed', 'staged-verified'])
        expect(failed).toMatchObject({
            status: 'verification-failed',
            verifiedStagedItems: 0,
            verificationFailedItems: 1,
        })

        const blockedPublish = await client.fetch(`/api/external-assets/migrate/jobs/${migrationId}/finalize`, {
            method: 'POST', headers: sessionHeaders,
        })
        expect(blockedPublish.status).toBe(409)

        await writeFile(providerObject, asset)
        const retry = await client.fetch(`/api/external-assets/migrate/jobs/${migrationId}/verify-staged`, {
            method: 'POST', headers: sessionHeaders,
        })
        expect(retry.status).toBe(202)
        const verified = await waitForJob(client, migrationId, ['staged-verified', 'verification-failed'])
        expect(verified).toMatchObject({
            status: 'staged-verified',
            verifiedStagedItems: 1,
            verifiedStagedBytes: asset.length,
            verificationFailedItems: 0,
            verificationProgress: 1,
        })

        const publish = await client.fetch(`/api/external-assets/migrate/jobs/${migrationId}/finalize`, {
            method: 'POST', headers: sessionHeaders,
        })
        expect(publish.status).toBe(200)
        const published = await publish.json()
        expect(published.job.status).toBe('published')
        expect(published.referencesRewritten).toBeGreaterThan(0)

        const { raw } = normalizeBackup(await client.exportBackup())
        expect((raw.characters as any[])[0].image).toBe(`external://local/${hash}`)
    }, 30_000)
})
