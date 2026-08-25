import { afterAll, describe, expect, test } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { Packr } from 'msgpackr'
import { zipSync } from 'fflate'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const HOUR_MS = 60 * 60 * 1000
const DB_KEY = 'database/database.bin'
const DB_KEY_HEX = Buffer.from(DB_KEY, 'utf-8').toString('hex')
const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const sessionHeaders = { 'x-session-id': 'snapshot-retention-test', 'x-user-active': '1' }

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

async function boot(options: Parameters<typeof spawnServer>[0] = {}): Promise<{ client: RisuClient; server: ServerHandle }> {
    const server = await spawnServer(options)
    servers.push(server)
    return { server, client: await createClient(server.port, server.password) }
}

function rawDatabase(tag: string): Buffer {
    const database = {
        characters: [],
        personas: [],
        botPresets: [],
        botPresetsId: 0,
        selectedCharacter: -1,
        snapshotRetentionTag: tag,
    }
    return Buffer.concat([MAGIC_RAW, packr.encode(database)])
}

async function uploadSaveFolder(client: RisuClient, database: Buffer): Promise<Response> {
    const body = Buffer.from(zipSync({ [DB_KEY_HEX]: new Uint8Array(database) }))
    return client.fetch('/api/migrate/save-folder/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/zip', ...sessionHeaders },
        body: new Uint8Array(body),
    })
}

describe('automatic snapshot retention schedule', () => {
    test('defaults to 12 hours and preserves the interval for legacy limit-only updates', async () => {
        const { client } = await boot()

        const initial = await (await client.fetch('/api/db/snapshots/limits')).json()
        expect(initial.intervalMs).toBe(12 * HOUR_MS)
        expect(initial.intervalOptions).toEqual([0, HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, 24 * HOUR_MS])
        expect(initial.defaults.intervalMs).toBe(12 * HOUR_MS)

        const update = await client.fetch('/api/db/snapshots/limits', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...sessionHeaders },
            body: JSON.stringify({ maxCount: 20, maxBytes: 500 * 1024 * 1024, intervalMs: 6 * HOUR_MS }),
        })
        expect(update.status).toBe(200)
        expect((await update.json()).intervalMs).toBe(6 * HOUR_MS)

        // Older clients know only the two retention fields. Their PUT must not
        // reset the newly persisted schedule.
        const legacyUpdate = await client.fetch('/api/db/snapshots/limits', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...sessionHeaders },
            body: JSON.stringify({ maxCount: 21, maxBytes: 510 * 1024 * 1024 }),
        })
        expect(legacyUpdate.status).toBe(200)
        expect((await legacyUpdate.json()).intervalMs).toBe(6 * HOUR_MS)

        const invalid = await client.fetch('/api/db/snapshots/limits', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...sessionHeaders },
            body: JSON.stringify({ maxCount: 20, maxBytes: 500 * 1024 * 1024, intervalMs: 5 * HOUR_MS }),
        })
        expect(invalid.status).toBe(400)
    })

    test('a missing source does not consume the cooldown, and off keeps existing snapshots', async () => {
        const { client } = await boot()

        // The first import has no previous live DB to copy. The immediate second
        // import must still create a snapshot of the first DB.
        expect((await client.importBackup(createSeedBackup({ characterCount: 1 }))).ok).toBe(true)
        expect((await client.importBackup(createSeedBackup({ characterCount: 2 }))).ok).toBe(true)
        let snapshots = (await (await client.fetch('/api/db/snapshots')).json()).snapshots
        expect(snapshots).toHaveLength(1)

        const disable = await client.fetch('/api/db/snapshots/limits', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...sessionHeaders },
            body: JSON.stringify({ maxCount: 20, maxBytes: 500 * 1024 * 1024, intervalMs: 0 }),
        })
        expect(disable.status).toBe(200)

        expect((await client.importBackup(createSeedBackup({ characterCount: 3 }))).ok).toBe(true)
        snapshots = (await (await client.fetch('/api/db/snapshots')).json()).snapshots
        expect(snapshots).toHaveLength(1)
    })

    test('uses the newest persisted snapshot as cooldown anchor after server boot', async () => {
        const existingTimestamp = Date.now() - 60_000
        const existingKey = `database/dbbackup-${Math.round(existingTimestamp / 100)}.bin`
        const { client } = await boot({
            seedSave: async saveDir => {
                await writeFile(`${saveDir}/${DB_KEY_HEX}`, rawDatabase('live-before-restart'))
                const snapshotHex = Buffer.from(existingKey, 'utf-8').toString('hex')
                await writeFile(`${saveDir}/${snapshotHex}`, rawDatabase('existing-snapshot'))
            },
        })

        // This replacement asks createBackupAndRotate() to snapshot the current
        // DB. Because the on-disk snapshot is only one minute old, a restarted
        // server must honor its remaining 12-hour cooldown and not add another.
        const upload = await uploadSaveFolder(client, rawDatabase('replacement'))
        expect(upload.status).toBe(200)
        const snapshots = (await (await client.fetch('/api/db/snapshots')).json()).snapshots
        expect(snapshots).toHaveLength(1)
        expect(snapshots[0].key).toBe(existingKey)
    })
})
