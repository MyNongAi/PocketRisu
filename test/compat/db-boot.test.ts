/**
 * database.bin served from the boot planner (server/node/boot-payload.cjs):
 * - GET /api/read as every bundle reads it: the same bytes as a whole encode
 *   of the client view, now streamed, with a strong ETag, a 304 on
 *   If-None-Match, x-db-hash, and no compression for a browser on the same
 *   machine only;
 * - POST /api/db/boot (protocol 1): the manifest of that payload and the
 *   segments the client does not hold. parseBootBody below is a reference
 *   reader of the format; the tests check that what it assembles is the
 *   /api/read payload and that the manifest's Merkle root is x-db-etag.
 *
 * Requests go through node:http so the test sees the bytes and headers the
 * server sends (fetch would decompress and could not set Host).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import http from 'node:http'
import zlib from 'node:zlib'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { readDiskDb } from './helpers/disk.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')
// fileURLToPath, not URL.pathname: on Windows .pathname is "/H:/..." and the
// server child fails to load the preload.
const BOOT_PLANNER_OFF = fileURLToPath(new URL('./helpers/boot-planner-off-preload.cjs', import.meta.url))

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

// ── POST /api/db/boot ────────────────────────────────────────────────────────
// A reference reader of the framed body (protocol 1, integers big-endian):
//   'PRB1' | u8 flags (bit 0: key block)
//   [u8 keyIdLen, keyId, u8 32, key[32]]        only when flags bit 0
//   u32 prefixLen, prefix | u32 segCount
//   segCount x { digest[16], u32 len, u8 included }
//   the included segments' bytes, in manifest order
interface BootBody {
  flags: number
  keyId: string | null
  key: Buffer | null
  prefix: Buffer
  manifest: { digest: Buffer; len: number; included: boolean }[]
  segments: (Buffer | null)[]
}

function parseBootBody(body: Buffer): BootBody {
  let at = 0
  const take = (n: number) => {
    if (at + n > body.length) throw new Error(`truncated at ${at}`)
    const out = body.subarray(at, at + n)
    at += n
    return out
  }
  if (take(4).toString('latin1') !== 'PRB1') throw new Error('bad magic')
  const flags = take(1)[0]
  let keyId: string | null = null
  let key: Buffer | null = null
  if (flags & 1) {
    keyId = take(take(1)[0]).toString('ascii')
    key = Buffer.from(take(take(1)[0]))
  }
  const prefixLen = take(4).readUInt32BE(0)
  if (prefixLen > 64) throw new Error('prefix too long')
  const prefix = Buffer.from(take(prefixLen))
  const count = take(4).readUInt32BE(0)
  if (count > 1048576) throw new Error('too many segments')
  const manifest = []
  for (let i = 0; i < count; i++) {
    const entry = take(21)
    manifest.push({ digest: Buffer.from(entry.subarray(0, 16)), len: entry.readUInt32BE(16), included: entry[20] === 1 })
  }
  const segments = manifest.map((entry) => (entry.included ? Buffer.from(take(entry.len)) : null))
  if (at !== body.length) throw new Error(`${body.length - at} trailing bytes`)
  return { flags, keyId, key, prefix, manifest, segments }
}

const digestOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest().subarray(0, 16)

function merkleEtag(prefix: Buffer, manifest: BootBody['manifest']) {
  const hash = createHash('sha256').update(Buffer.from([1])).update(prefix)
  const len = Buffer.alloc(4)
  for (const entry of manifest) {
    len.writeUInt32BE(entry.len)
    hash.update(entry.digest).update(len)
  }
  return `m1-${hash.digest('hex').slice(0, 40)}`
}

// What a client does with the body: every segment from the network or from
// its cache (keyed by digest, hex), each checked against its digest.
function assemble(parsed: BootBody, cache = new Map<string, Buffer>()) {
  return Buffer.concat([parsed.prefix, ...parsed.manifest.map((entry, i) => {
    const bytes = parsed.segments[i] ?? cache.get(entry.digest.toString('hex'))
    if (!bytes) throw new Error(`segment ${i} is neither sent nor cached`)
    if (bytes.length !== entry.len || !digestOf(bytes).equals(entry.digest)) throw new Error(`segment ${i} fails its digest`)
    return bytes
  })])
}

function cacheOf(parsed: BootBody, cache = new Map<string, Buffer>()) {
  parsed.manifest.forEach((entry, i) => { if (parsed.segments[i]) cache.set(entry.digest.toString('hex'), parsed.segments[i]!) })
  return cache
}

function postBoot(srv: ServerHandle, client: RisuClient, {
  have = [] as Buffer[],
  keyId = '',
  cache = '1',
  headers = {} as Record<string, string>,
  onResponse = undefined as ((res: http.IncomingMessage) => void) | undefined,
} = {}) {
  return rawRequest(srv.port, {
    method: 'POST',
    path: '/api/db/boot',
    headers: {
      'risu-auth': client.token,
      'content-type': 'application/octet-stream',
      'x-boot-protocol': '1',
      'x-boot-cache': cache,
      'x-boot-cache-key-id': keyId,
      ...headers,
    },
    body: Buffer.concat(have),
    onResponse,
  })
}

// Reads the change feed from `since` until `marker` shows up (or timeoutMs).
async function readEventsUntil(client: RisuClient, since: { instance: string; seq: string }, marker: RegExp, timeoutMs = 3000) {
  const res = await client.fetch(`/api/sync/events?since=${since.seq}&instance=${since.instance}`)
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const timer = setTimeout(() => { reader.cancel().catch(() => {}) }, timeoutMs)
  try {
    while (!marker.test(text)) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
  return text
}

describe('POST /api/db/boot', () => {
  let srv: ServerHandle
  let client: RisuClient
  beforeAll(async () => { ({ srv, client } = await boot()) })

  test('with nothing held, sends every segment; they assemble to the /api/read bytes and the manifest to its etag', async () => {
    const read = await readRaw(srv, client)
    const res = await postBoot(srv, client)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/x-pocketrisu-boot')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-boot-protocol']).toBe('1')
    for (const name of ['x-db-etag', 'x-db-hash', 'x-sync-instance', 'x-sync-seq']) {
      expect(res.headers[name], name).toBe(read.headers[name])
    }
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(Number(res.headers['content-length'])).toBe(res.body.length)

    const parsed = parseBootBody(res.body)
    expect(parsed.manifest.every((entry) => entry.included)).toBe(true)
    expect(assemble(parsed).equals(read.body)).toBe(true)
    expect(merkleEtag(parsed.prefix, parsed.manifest)).toBe(res.headers['x-db-etag'])
    expect(Number(res.headers['x-boot-total'])).toBe(read.body.length)
    expect(Number(res.headers['x-boot-included'])).toBe(parsed.manifest.reduce((sum, entry) => sum + entry.len, 0))

    // The key block: HMAC-SHA256(jwt secret, 'pocketrisu/boot-cache/v1') and
    // the first 16 hex digits of its sha256.
    const secret = readFileSync(path.join(srv.cwd, 'save', '__jwt_secret'), 'utf-8').trim()
    const key = createHmac('sha256', secret).update('pocketrisu/boot-cache/v1').digest()
    expect(parsed.flags).toBe(1)
    expect(parsed.key!.equals(key)).toBe(true)
    expect(parsed.keyId).toBe(createHash('sha256').update(key).digest('hex').slice(0, 16))
  })

  test('with the digests of an earlier boot, sends only the segment a lastDate patch changed', async () => {
    const first = parseBootBody((await postBoot(srv, client)).body)
    const cache = cacheOf(first)
    const have = first.manifest.map((entry) => entry.digest)
    const read = await readRaw(srv, client)
    const lastDate = Date.now() + 1
    const patched = await sendPatch(client, [{ op: 'replace', path: '/characters/1/chats/0/lastDate', value: lastDate }], read.headers['x-db-hash'] as string)
    expect(patched.status).toBe(200)

    const res = await postBoot(srv, client, { have, keyId: first.keyId! })
    const parsed = parseBootBody(res.body)
    const sent = parsed.manifest.filter((entry) => entry.included)
    expect(sent).toHaveLength(1)
    expect(Number(res.headers['x-boot-included'])).toBe(sent[0].len)
    const after = await readRaw(srv, client)
    expect(res.headers['x-db-etag']).toBe(after.headers['x-db-etag'])
    expect(res.headers['x-db-etag']).not.toBe(read.headers['x-db-etag'])
    const assembled = assemble(parsed, cache)
    expect(assembled.equals(after.body)).toBe(true)
    expect(merkleEtag(parsed.prefix, parsed.manifest)).toBe(res.headers['x-db-etag'])
    expect((await decodeView(assembled)).characters[1].chats[0].lastDate).toBe(lastDate)
  })

  test('held digests count only under the current key id; the key block comes only with x-boot-cache: 1', async () => {
    const first = parseBootBody((await postBoot(srv, client)).body)
    const have = first.manifest.map((entry) => entry.digest)
    for (const keyId of ['', 'wrong-key-id-000']) {
      const parsed = parseBootBody((await postBoot(srv, client, { have, keyId })).body)
      expect(parsed.manifest.every((entry) => entry.included)).toBe(true)
    }
    const current = (await readRaw(srv, client)).body
    const noKey = parseBootBody((await postBoot(srv, client, { cache: '0' })).body)
    expect(noKey.flags).toBe(0)
    expect(noKey.key).toBeNull()
    expect(assemble(noKey).equals(current)).toBe(true)
    const held = parseBootBody((await postBoot(srv, client, { have, keyId: first.keyId! })).body)
    expect(held.manifest.some((entry) => entry.included)).toBe(false)
    expect(assemble(held, cacheOf(first)).equals(current)).toBe(true)
  })

  test('refuses a bad protocol, a have-list of odd length or over the cap, and a missing auth header', async () => {
    const badProtocol = await postBoot(srv, client, { headers: { 'x-boot-protocol': '2' } })
    expect(badProtocol.status).toBe(400)
    expect(JSON.parse(badProtocol.body.toString()).code).toBe('BOOT_PROTOCOL_UNSUPPORTED')
    expect((await postBoot(srv, client, { have: [Buffer.alloc(15)] })).status).toBe(400)
    expect((await postBoot(srv, client, { have: [Buffer.alloc(16 * 262144 + 16)] })).status).toBe(413)
    expect((await postBoot(srv, client, { have: [Buffer.alloc(16 * 262144)] })).status).toBe(200)
    const unauthenticated = await rawRequest(srv.port, {
      method: 'POST',
      path: '/api/db/boot',
      headers: { 'x-boot-protocol': '1', 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(0),
    })
    expect(unauthenticated.status).toBe(400)
    expect(unauthenticated.body.includes(Buffer.from('PRB1'))).toBe(false)
  })

  test('x-sync-seq is where the change feed stood: the feed from there has what came after the payload', async () => {
    let read = await readRaw(srv, client)
    expect((await sendPatch(client, [{ op: 'replace', path: '/characters/2/name', value: 'before the boot' }], read.headers['x-db-hash'] as string)).status).toBe(200)
    const res = await postBoot(srv, client)
    expect((await decodeView(assemble(parseBootBody(res.body)))).characters[2].name).toBe('before the boot')
    read = await readRaw(srv, client)
    expect((await sendPatch(client, [{ op: 'replace', path: '/characters/2/name', value: 'after the boot' }], read.headers['x-db-hash'] as string)).status).toBe(200)
    const events = await readEventsUntil(client, { instance: res.headers['x-sync-instance'] as string, seq: res.headers['x-sync-seq'] as string }, /after the boot/)
    expect(events).toMatch(/after the boot/)
    expect(events).not.toMatch(/before the boot/)
  })

  test('is compressed for a request that did not come straight from this machine', async () => {
    const plain = await postBoot(srv, client)
    const forwarded = await postBoot(srv, client, { headers: { 'accept-encoding': 'br', 'x-forwarded-for': '100.64.0.7' } })
    expect(forwarded.headers['content-encoding']).toBe('br')
    expect(zlib.brotliDecompressSync(forwarded.body).equals(plain.body)).toBe(true)
    const proxied = await postBoot(srv, client, { headers: { 'accept-encoding': 'gzip', host: 'laptop.tailnet.ts.net' } })
    expect(proxied.headers['content-encoding']).toBe('gzip')
    expect(zlib.gunzipSync(proxied.body).equals(plain.body)).toBe(true)
  })
})

describe('a large database', () => {
  let srv: ServerHandle
  let client: RisuClient
  let big: any
  beforeAll(async () => {
    ({ srv, client } = await boot(40))
    const seeded = await readRaw(srv, client)
    big = await decodeView(seeded.body)
    // About 16MB of view: more than the socket buffers hold.
    big.characters = big.characters.map((c: any, i: number) => ({ ...c, desc: `${i}:`.padEnd(400 * 1024, 'd') }))
    expect((await sendWrite(client, big, { 'x-if-match': seeded.headers['x-db-etag'] as string })).status).toBe(200)
  }, 60_000)

  // Starts a request and pauses its response, applies three patches while
  // the server waits for the reader, then reads the rest.
  async function streamWhilePatching(request: (onResponse: (res: http.IncomingMessage) => void) => Promise<RawResponse>, logTag: string, round: number) {
    // The server logs its line once the last byte is written.
    const logLines = () => srv.stdout().split('\n').filter((line) => line.includes(logTag)).length
    const linesBefore = logLines()
    let resume = () => {}
    const pending = request((res) => {
      res.pause()
      resume = () => res.resume()
    })
    await sleep(300)
    const names: string[] = []
    for (let n = 0; n < 3; n++) {
      const name = `round ${round} patch ${n}`
      const res = await sendPatch(client, [{ op: 'replace', path: `/characters/${n}/name`, value: name }], utils.calculateHash(big).toString(16))
      expect(res.status).toBe(200)
      big.characters[n].name = name
      names.push(name)
    }
    // The stream is still waiting for the paused reader.
    expect(logLines()).toBe(linesBefore)
    resume()
    return { response: await pending, names }
  }

  test('a read streams the root of the moment it was asked for, whatever patches land meanwhile', async () => {
    const { response, names } = await streamWhilePatching((onResponse) => rawRequest(srv.port, { path: '/api/read', headers: readHeaders(client), onResponse }), '[Read]', 1)
    expect(response.body.length).toBeGreaterThan(15 * 1024 * 1024)
    const view = await decodeView(response.body)
    expect(view.characters[0].name).not.toBe(names[0])
    expect(utils.calculateHash(view).toString(16)).toBe(response.headers['x-db-hash'])
    const now = await decodeView((await readRaw(srv, client)).body)
    expect(now.characters.slice(0, 3).map((c: any) => c.name)).toEqual(names)
  }, 60_000)

  test('a boot stream does too, and its parts still verify', async () => {
    const { response, names } = await streamWhilePatching((onResponse) => postBoot(srv, client, { onResponse }), '[Boot] database', 2)
    const parsed = parseBootBody(response.body)
    expect(merkleEtag(parsed.prefix, parsed.manifest)).toBe(response.headers['x-db-etag'])
    const view = await decodeView(assemble(parsed))
    expect(view.characters[0].name).not.toBe(names[0])
    expect(utils.calculateHash(view).toString(16)).toBe(response.headers['x-db-hash'])
  }, 60_000)
})

describe('an empty save folder', () => {
  test('answers an empty /api/read body, as before (the client then creates a database), and a 204 boot', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    const res = await readRaw(srv, client)
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(0)
    expect(res.headers['x-db-etag']).toBeUndefined()
    const booted = await postBoot(srv, client)
    expect(booted.status).toBe(204)
    expect(booted.body.length).toBe(0)
  })
})

describe('a disabled planner', () => {
  test('reads encode the whole view with an md5 etag; /api/db/boot answers 503 BOOT_DISABLED', async () => {
    const srv = await spawnServer({ env: { NODE_OPTIONS: `--require ${BOOT_PLANNER_OFF}` } })
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    expect((await client.importBackup(createSeedBackup({ characterCount: 2 }))).ok).toBe(true)
    const read = await readRaw(srv, client)
    expect(read.status).toBe(200)
    const etag = createHash('md5').update(read.body).digest('hex')
    expect(read.headers['x-db-etag']).toBe(etag)
    expect(read.headers.etag).toBe(`"${etag}"`)
    expect(read.headers['x-db-hash']).toBe(utils.calculateHash(await decodeView(read.body)).toString(16))
    expect((await readRaw(srv, client, { 'if-none-match': `"${etag}"` })).status).toBe(304)
    const patched = await sendPatch(client, [{ op: 'replace', path: '/characters/0/name', value: 'md5 again' }], read.headers['x-db-hash'] as string)
    expect(patched.status).toBe(200)
    const after = await readRaw(srv, client)
    expect((await patched.json() as { etag: string }).etag).toBe(createHash('md5').update(after.body).digest('hex'))
    const booted = await postBoot(srv, client)
    expect(booted.status).toBe(503)
    expect(JSON.parse(booted.body.toString()).code).toBe('BOOT_DISABLED')
  })
})
