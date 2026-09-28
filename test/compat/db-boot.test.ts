/**
 * database.bin served from the boot planner (server/node/boot-payload.cjs):
 * GET /api/read as every bundle reads it (same bytes as a whole encode of
 * the client view, now streamed, with a strong ETag, a 304 on
 * If-None-Match, x-db-hash, and no compression for a browser on the same
 * machine only).
 *
 * Requests go through node:http so the test sees the bytes and headers the
 * server sends (fetch would decompress and could not set Host).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import http from 'node:http'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { readDiskDb } from './helpers/disk.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')
const sessionHeaders = { 'x-session-id': 'db-boot', 'x-user-active': '1' }

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

// One request, the body as sent (not decompressed). With `onResponse`, the
// test gets the response before its body is read (to pause it).
function rawRequest(port: number, options: {
  method?: string
  path: string
  headers?: Record<string, string>
  body?: Buffer
  onResponse?: (res: http.IncomingMessage) => Promise<void> | void
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
      if (options.onResponse) Promise.resolve(options.onResponse(res)).catch(reject)
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

function readHeaders(client: RisuClient, extra: Record<string, string> = {}) {
  return { 'risu-auth': client.token, 'file-path': DB_KEY_HEX, ...extra }
}

function readRaw(srv: ServerHandle, client: RisuClient, extra: Record<string, string> = {}) {
  return rawRequest(srv.port, { path: '/api/read', headers: readHeaders(client, extra) })
}

async function decodeView(bytes: Buffer) {
  return utils.normalizeJSON(await utils.decodeRisuSave(bytes)) as any
}

function sendPatch(client: RisuClient, patch: unknown[], expectedHash: string) {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch, expectedHash }),
  })
}

function sendWrite(client: RisuClient, db: unknown, headers: Record<string, string>) {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX, ...headers },
    body: Buffer.from(utils.encodeRisuSaveLegacy(db)),
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

async function boot(characterCount = 3) {
  const srv = await spawnServer()
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  expect((await client.importBackup(createSeedBackup({ characterCount, chatsPerCharacter: 2 }))).ok).toBe(true)
  return { srv, client }
}

describe('GET /api/read of database.bin', () => {
  let srv: ServerHandle
  let client: RisuClient
  beforeAll(async () => { ({ srv, client } = await boot()) })

  test('serves the view as before, with x-db-etag, a strong ETag, x-db-hash and the sync cursor', async () => {
    const res = await readRaw(srv, client)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    // This test is a browser on the server's machine: no compression.
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(Number(res.headers['content-length'])).toBe(res.body.length)
    const etag = res.headers['x-db-etag'] as string
    expect(etag).toMatch(/^m1-[0-9a-f]{40}$/)
    expect(res.headers.etag).toBe(`"${etag}"`)
    const view = await decodeView(res.body)
    expect(view.characters).toHaveLength(3)
    expect(view.characters[0].chats[0]._stub).toBe(true)
    expect(res.headers['x-db-hash']).toBe(utils.calculateHash(view).toString(16))
    expect(res.headers['x-sync-instance']).toBeTruthy()
    expect(res.headers['x-sync-seq']).toMatch(/^\d+$/)
    // The bytes are exactly a whole encode of the view they decode to.
    expect(Buffer.from(utils.encodeRisuSaveLegacy(view)).equals(res.body)).toBe(true)
  })

  test('answers If-None-Match with 304 and the same headers; a patch makes it 200 again', async () => {
    const first = await readRaw(srv, client)
    const etag = first.headers['x-db-etag'] as string
    for (const form of [`"${etag}"`, `W/"${etag}"`, etag, `"other", "${etag}"`]) {
      const again = await readRaw(srv, client, { 'if-none-match': form })
      expect(again.status).toBe(304)
      expect(again.body.length).toBe(0)
      expect(again.headers['x-db-etag']).toBe(etag)
      expect(again.headers['x-db-hash']).toBe(first.headers['x-db-hash'])
      expect(again.headers['x-sync-seq']).toBe(first.headers['x-sync-seq'])
    }
    const view = await decodeView(first.body)
    const patched = await sendPatch(client, [{ op: 'replace', path: '/characters/0/name', value: 'renamed for 304' }], utils.calculateHash(view).toString(16))
    expect(patched.status).toBe(200)
    const patchEtag = (await patched.json() as { etag: string }).etag
    const after = await readRaw(srv, client, { 'if-none-match': `"${etag}"` })
    expect(after.status).toBe(200)
    expect(after.headers['x-db-etag']).toBe(patchEtag)
    expect(after.headers['x-db-etag']).not.toBe(etag)
    expect(Number(after.headers['x-sync-seq'])).toBeGreaterThan(Number(first.headers['x-sync-seq']))
    expect((await decodeView(after.body)).characters[0].name).toBe('renamed for 304')
  })

  test('a warm read after a patch serves it without persisting it; the save timer persists it later', async () => {
    const before = await readRaw(srv, client)
    const view = await decodeView(before.body)
    const name = `warm-${Date.now()}`
    const patched = await sendPatch(client, [{ op: 'replace', path: '/characters/1/name', value: name }], utils.calculateHash(view).toString(16))
    expect(patched.status).toBe(200)
    const read = await readRaw(srv, client)
    expect((await decodeView(read.body)).characters[1].name).toBe(name)
    expect((await readDiskDb(srv.cwd)).characters[1].name).not.toBe(name)
    const deadline = Date.now() + 15_000
    while ((await readDiskDb(srv.cwd)).characters[1].name !== name) {
      if (Date.now() > deadline) throw new Error('the save timer did not persist the patch')
      await sleep(250)
    }
  }, 30_000)

  test('compresses every request but a direct one from this machine', async () => {
    const plain = await readRaw(srv, client, { 'accept-encoding': 'br, gzip' })
    expect(plain.headers['content-encoding']).toBeUndefined()
    const cases: [Record<string, string>, string][] = [
      // Tailscale Serve and other local reverse proxies.
      [{ 'accept-encoding': 'br, gzip', 'x-forwarded-for': '100.64.0.7' }, 'br'],
      [{ 'accept-encoding': 'gzip', forwarded: 'for=100.64.0.7' }, 'gzip'],
      [{ 'accept-encoding': 'br', host: 'laptop.tailnet.ts.net' }, 'br'],
    ]
    for (const [headers, encoding] of cases) {
      const res = await readRaw(srv, client, headers)
      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBe(encoding)
      expect(res.headers['content-length']).toBeUndefined()
      const body = encoding === 'br' ? zlib.brotliDecompressSync(res.body) : zlib.gunzipSync(res.body)
      expect(body.equals(plain.body)).toBe(true)
    }
  })

  test('a pre-upgrade md5 etag in x-if-match gets 409 with the current etag, which then writes', async () => {
    const read = await readRaw(srv, client)
    const view = await decodeView(read.body)
    const md5 = createHash('md5').update(read.body).digest('hex')
    const stale = await sendWrite(client, { ...view, globalNote: 'from an old tab' }, { 'x-if-match': md5 })
    expect(stale.status).toBe(409)
    const { currentEtag } = await stale.json() as { currentEtag: string }
    expect(currentEtag).toBe(read.headers['x-db-etag'])
    const write = await sendWrite(client, { ...view, globalNote: 'rebased' }, { 'x-if-match': currentEtag })
    expect(write.status).toBe(200)
    const writeEtag = (await write.json() as { etag: string }).etag
    const after = await readRaw(srv, client)
    expect(after.headers['x-db-etag']).toBe(writeEtag)
    expect((await decodeView(after.body)).globalNote).toBe('rebased')
  })
})

describe('a large database read', () => {
  test('streams the root of the moment it was asked for, whatever patches land meanwhile', async () => {
    const { srv, client } = await boot(40)
    const seeded = await readRaw(srv, client)
    const big = await decodeView(seeded.body)
    // About 16MB of view: more than the socket buffers hold.
    big.characters = big.characters.map((c: any, i: number) => ({ ...c, desc: `${i}:`.padEnd(400 * 1024, 'd') }))
    expect((await sendWrite(client, big, { 'x-if-match': seeded.headers['x-db-etag'] as string })).status).toBe(200)

    // The read logs its [Read] line when the last byte is written.
    const readLines = () => srv.stdout().split('\n').filter((line) => line.includes('[Read]')).length
    const readsBefore = readLines()
    let resume = () => {}
    const reading = rawRequest(srv.port, {
      path: '/api/read',
      headers: readHeaders(client),
      onResponse: (res) => {
        res.pause()
        resume = () => res.resume()
      },
    })
    await sleep(300)
    let hash = utils.calculateHash(big).toString(16)
    for (let n = 0; n < 3; n++) {
      const res = await sendPatch(client, [{ op: 'replace', path: `/characters/${n}/name`, value: `patched ${n}` }], hash)
      expect(res.status).toBe(200)
      big.characters[n].name = `patched ${n}`
      hash = utils.calculateHash(big).toString(16)
    }
    // The stream is still waiting for the paused reader.
    expect(readLines()).toBe(readsBefore)
    resume()
    const streamed = await reading
    expect(streamed.body.length).toBeGreaterThan(15 * 1024 * 1024)
    const view = await decodeView(streamed.body)
    expect(view.characters[0].name).not.toBe('patched 0')
    expect(utils.calculateHash(view).toString(16)).toBe(streamed.headers['x-db-hash'])
    const now = await decodeView((await readRaw(srv, client)).body)
    expect(now.characters.slice(0, 3).map((c: any) => c.name)).toEqual(['patched 0', 'patched 1', 'patched 2'])
  }, 60_000)
})

describe('an empty save folder', () => {
  test('answers an empty body, as before (the client then creates a database)', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    const res = await readRaw(srv, client)
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(0)
    expect(res.headers['x-db-etag']).toBeUndefined()
  })
})
