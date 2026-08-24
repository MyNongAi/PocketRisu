import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import plannerModule from './external-asset-plan-worker.cjs'
import chunkModule from './chunkStore.cjs'
import utilsModule from './utils.cjs'

const { buildExternalAssetMigrationPlan } = plannerModule
const { createChunkStore } = chunkModule
const { encodeRisuSaveLegacy } = utilsModule

function makeDb() {
    const db = new Database(':memory:')
    db.exec(`
        CREATE TABLE kv (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `)
    return db
}

describe('external asset plan worker', () => {
    it('deduplicates references, indexes sizes once, and leaves missing assets out of the queue', async () => {
        const db = makeDb()
        const store = createChunkStore(db, { threshold: 32 })
        const decoded = {
            characters: [{
                chaId: 'char-1',
                image: 'assets/a.png',
                emotionImages: [['same', 'assets/a.png'], ['missing', 'assets/missing.png']],
                additionalAssets: [['b', 'assets/b.webp']],
            }],
            modules: [],
        }
        store.putValue('database/database.bin', Buffer.from(encodeRisuSaveLegacy(decoded)))
        db.prepare('INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)').run('assets/a.png', Buffer.alloc(4), 1)
        db.prepare('INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)').run('assets/b.webp', Buffer.alloc(7), 1)

        const plan = await buildExternalAssetMigrationPlan({ db, chunkStore: store })
        expect(plan).toMatchObject({ references: 4, uniqueAssets: 3, alreadyExternal: 0, bytes: 11 })
        expect(plan.items).toEqual([
            { internalKey: 'assets/a.png', size: 4 },
            { internalKey: 'assets/b.webp', size: 7 },
        ])
        expect(plan.missing).toEqual(['assets/missing.png'])
        db.close()
    })
})
