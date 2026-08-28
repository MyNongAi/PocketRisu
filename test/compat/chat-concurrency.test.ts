import { afterAll, describe, expect, test } from 'vitest'
import { Packr } from 'msgpackr'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

function encodeChat(id: string, marker: string): Uint8Array {
  return new Uint8Array(Buffer.concat([
    MAGIC_RAW,
    packr.encode({
      id,
      name: id,
      lastDate: Date.now(),
      localLore: [],
      scriptstate: {},
      note: '',
      message: [{ role: 'char', data: marker }],
    }),
  ]))
}

async function boot() {
  const server = await spawnServer()
  servers.push(server)
  const client = await createClient(server.port, server.password)
  expect((await client.importBackup(createSeedBackup({
    characterCount: 1,
    chatsPerCharacter: 2,
  }))).ok).toBe(true)
  return client
}

function session(id: string) {
  return { 'x-session-id': id, 'x-user-active': '1' }
}

describe('per-chat optimistic concurrency', () => {
  test('a stale global writer may save a different hydrated chat', async () => {
    const client = await boot()
    const chatA = await client.fetch('/api/chat-content/test-char-0/0', {
      headers: { 'x-chat-id': 'chat-0-0', ...session('pc') },
    })
    expect(chatA.status).toBe(200)
    const chatAEtag = chatA.headers.get('etag')
    expect(chatAEtag).toBeTruthy()

    // The phone becomes the legacy global writer by changing another chat.
    const phoneWrite = await client.fetch('/api/chat-content/test-char-0/1', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-0-1',
        ...session('phone'),
      },
      body: encodeChat('chat-0-1', 'phone owns the writer lock'),
    })
    expect(phoneWrite.status).toBe(200)

    // The PC is globally stale, but its chat-specific baseline is current.
    const pcWrite = await client.fetch('/api/chat-content/test-char-0/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-0-0',
        'x-if-match': chatAEtag!,
        ...session('pc'),
      },
      body: encodeChat('chat-0-0', 'reroll survives'),
    })
    expect(pcWrite.status).toBe(200)
    expect((await pcWrite.json()).etag).toBeTruthy()
  }, 30_000)

  test('two writes to the same chat reject the stale copy with 409', async () => {
    const client = await boot()
    const initial = await client.fetch('/api/chat-content/test-char-0/0', {
      headers: { 'x-chat-id': 'chat-0-0', ...session('pc') },
    })
    const initialEtag = initial.headers.get('etag')
    expect(initialEtag).toBeTruthy()

    const phoneWrite = await client.fetch('/api/chat-content/test-char-0/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-0-0',
        'x-if-match': initialEtag!,
        ...session('phone'),
      },
      body: encodeChat('chat-0-0', 'new phone response'),
    })
    expect(phoneWrite.status).toBe(200)

    const stalePcWrite = await client.fetch('/api/chat-content/test-char-0/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-0-0',
        'x-if-match': initialEtag!,
        ...session('pc'),
      },
      body: encodeChat('chat-0-0', 'stale pc reroll'),
    })
    expect(stalePcWrite.status).toBe(409)
    expect(await stalePcWrite.json()).toMatchObject({
      error: 'Chat changed on another device',
    })
  }, 30_000)
})
