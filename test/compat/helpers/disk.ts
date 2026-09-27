/**
 * Read what a spawned server has actually written to disk, bypassing its
 * in-memory cache: /api/read serves dbCache, so it cannot tell whether an
 * acknowledged change ever reached risuai.db.
 */
import path from 'node:path'
import type { RisuClient } from './client.js'

const Sqlite = require('better-sqlite3')
const utils = require('../../../server/node/utils.cjs')

/** Raw bytes of a kv value, reassembled when it is stored chunked. */
export function readDiskValue(cwd: string, key: string): Buffer | null {
  const db = new Sqlite(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: Buffer } | undefined
    if (!row) return null
    const chunks = db.prepare(
      'SELECT c.data FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash WHERE m.manifest_key = ? ORDER BY m.seq',
    ).all(key) as { data: Buffer }[]
    return chunks.length > 0 ? Buffer.concat(chunks.map((c) => c.data)) : row.value
  } finally {
    db.close()
  }
}

/** The database.bin on disk, decoded (full chats, as the server stores it). */
export async function readDiskDb(cwd: string): Promise<any> {
  const raw = readDiskValue(cwd, 'database/database.bin')
  if (!raw) throw new Error('database/database.bin is not on disk')
  return utils.normalizeJSON(await utils.decodeRisuSave(raw))
}

/** Cookie header for the routes behind sessionAuthMiddleware (e.g. /api/db/flush). */
export async function sessionCookie(client: RisuClient): Promise<string> {
  const res = await client.fetch('/api/session', { method: 'POST' })
  if (!res.ok) throw new Error(`/api/session failed (${res.status})`)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('/api/session set no cookie')
  return cookie
}
