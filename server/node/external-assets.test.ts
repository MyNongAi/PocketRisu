import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pkg from './external-assets.cjs'

const {
    ByteLruCache,
    createAndroidSafProvider,
    createExternalAssetService,
    createFilesystemProvider,
    createHttpProvider,
    createManifestStore,
    externalAssetProviderFingerprint,
    isExternalAssetUri,
    makeExternalAssetUri,
    parseExternalAssetUri,
    sha256,
    withRetry,
} = pkg as any

const tempDirs: string[] = []

function tempDir(name: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
    tempDirs.push(dir)
    return dir
}

function memoryManifest(now?: () => string) {
    const values = new Map<string, Buffer>()
    const store = createManifestStore({
        now,
        getValue: async (key: string) => values.get(key) ?? null,
        setValue: async (key: string, value: Buffer) => values.set(key, Buffer.from(value)),
    })
    return { store, values }
}

async function allFiles(dir: string): Promise<string[]> {
    const result: string[] = []
    async function walk(current: string) {
        const entries = await fsp.readdir(current, { withFileTypes: true }).catch((error: any) => {
            if (error?.code === 'ENOENT') return []
            throw error
        })
        for (const entry of entries) {
            const file = path.join(current, entry.name)
            if (entry.isDirectory()) await walk(file)
            else result.push(file)
        }
    }
    await walk(dir)
    return result
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
})

describe('external:// URI contract', () => {
    it('creates and parses a canonical provider/hash URI', () => {
        const hash = 'A'.repeat(64)
        const uri = makeExternalAssetUri('home-assets', hash)
        expect(uri).toBe(`external://home-assets/${'a'.repeat(64)}`)
        expect(parseExternalAssetUri(uri)).toEqual({
            providerId: 'home-assets',
            hash: 'a'.repeat(64),
            uri,
        })
        expect(isExternalAssetUri(uri)).toBe(true)
        expect(isExternalAssetUri('assets/old.png')).toBe(false)
    })

    it.each([
        'external://../' + 'a'.repeat(64),
        'external://UPPER/' + 'a'.repeat(64),
        'external://local/not-a-hash',
        'external://local/' + 'a'.repeat(64) + '/extra',
        'https://example.test/' + 'a'.repeat(64),
    ])('rejects malformed or traversal-like URI %s', (uri) => {
        expect(() => parseExternalAssetUri(uri)).toThrow()
        expect(isExternalAssetUri(uri)).toBe(false)
    })
})

describe('ByteLruCache', () => {
    it('evicts least-recently-used buffers by total byte size', () => {
        const cache = new ByteLruCache(6)
        cache.set('a', Buffer.from('aaa'))
        cache.set('b', Buffer.from('bb'))
        expect(cache.get('a').toString()).toBe('aaa') // a is now newest
        cache.set('c', Buffer.from('cc'))              // b is evicted
        expect(cache.has('a')).toBe(true)
        expect(cache.has('b')).toBe(false)
        expect(cache.has('c')).toBe(true)
        expect(cache.sizeBytes).toBe(5)
    })

    it('does not retain a single object larger than the configured budget', () => {
        const cache = new ByteLruCache(2)
        expect(cache.set('large', Buffer.from('abc'))).toBe(false)
        expect(cache.size).toBe(0)
        expect(cache.sizeBytes).toBe(0)
    })

    it('can inspect an entry without changing LRU recency', () => {
        const cache = new ByteLruCache(4)
        cache.set('old', Buffer.from('aa'))
        cache.set('new', Buffer.from('bb'))
        expect(cache.peek('old')).toEqual(Buffer.from('aa'))
        cache.set('third', Buffer.from('cc'))
        expect(cache.has('old')).toBe(false)
        expect(cache.has('new')).toBe(true)
    })
})

describe('retry helper', () => {
    it('retries retryable failures and stops after success', async () => {
        const operation = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('temporary'), { retryable: true }))
            .mockResolvedValue('ok')
        const sleep = vi.fn().mockResolvedValue(undefined)
        await expect(withRetry(operation, { attempts: 3, baseDelayMs: 10, jitter: false, sleep })).resolves.toBe('ok')
        expect(operation).toHaveBeenCalledTimes(2)
        expect(sleep).toHaveBeenCalledWith(10)
    })
})

describe('filesystem provider', () => {
    it('PUTs, GETs, and stats content-addressed files', async () => {
        const rootDir = tempDir('external-fs')
        const provider = createFilesystemProvider({ id: 'local', rootDir })
        const data = Buffer.from('filesystem asset')
        const hash = sha256(data)

        await expect(provider.put(hash, data)).resolves.toMatchObject({ hash, size: data.length, existed: false })
        await expect(provider.put(hash, data)).resolves.toMatchObject({ existed: true })
        await expect(provider.get(hash)).resolves.toEqual(data)
        await expect(provider.stat(hash)).resolves.toMatchObject({ hash, size: data.length })

        const files = await allFiles(rootDir)
        expect(files).toHaveLength(1)
        expect(path.basename(files[0])).toBe(hash)
        expect(path.basename(path.dirname(files[0]))).toBe(hash.slice(0, 2))
    })

    it('refuses bytes that do not match their content key', async () => {
        const provider = createFilesystemProvider({ id: 'local', rootDir: tempDir('external-fs') })
        await expect(provider.put('a'.repeat(64), Buffer.from('wrong'))).rejects.toMatchObject({ code: 'HASH_MISMATCH' })
    })

    it('safely deduplicates concurrent PUTs of the same hash', async () => {
        const provider = createFilesystemProvider({ id: 'local', rootDir: tempDir('external-fs') })
        const data = Buffer.from('shared character/module asset')
        const hash = sha256(data)
        await expect(Promise.all(Array.from({ length: 8 }, () => provider.put(hash, data)))).resolves.toHaveLength(8)
        await expect(provider.get(hash)).resolves.toEqual(data)
    })

    it('can preserve same-volume trash as a hard link without duplicating payload blocks', async () => {
        const root = tempDir('external-provider')
        const provider = createFilesystemProvider({ id: 'local', rootDir: root })
        const data = Buffer.from('hard-linked recovery bytes')
        const hash = sha256(data)
        await provider.put(hash, data)
        const linked = path.join(root, 'trash', 'recovery.bin')
        await expect(provider.linkTo(hash, linked)).resolves.toBe(true)
        expect(fs.readFileSync(linked)).toEqual(data)
        expect(fs.statSync(linked).nlink).toBeGreaterThanOrEqual(2)
    })
})

describe('HTTP provider', () => {
    it('supports retrying GET and verified PUT without exposing private URLs', async () => {
        const data = Buffer.from('remote asset')
        const hash = sha256(data)
        const calls: Array<{ method: string, url: string, body?: Buffer }> = []
        let getAttempts = 0
        const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ method: init.method!, url, body: init.body ? Buffer.from(init.body as any) : undefined })
            if (init.method === 'GET' && ++getAttempts === 1) return new Response('busy', { status: 503 })
            if (init.method === 'GET') return new Response(data, { status: 200 })
            if (init.method === 'PUT') return new Response(null, { status: 201 })
            return new Response(null, { status: 200, headers: { 'content-length': String(data.length) } })
        })
        const provider = createHttpProvider({
            id: 'remote',
            baseUrl: 'https://assets.example.test/bucket',
            fetch: fetchMock,
            headers: { authorization: 'Bearer secret' },
            retry: { attempts: 2, baseDelayMs: 0, jitter: false, sleep: async () => {} },
        })

        await expect(provider.get(hash)).resolves.toEqual(data)
        await expect(provider.put(hash, data, { mimeType: 'image/png' })).resolves.toMatchObject({ hash, size: data.length })
        expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2)
        expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: data })
        expect(calls.every((call) => call.url === `https://assets.example.test/bucket/${hash}`)).toBe(true)
        expect(provider.getPublicUrl(hash)).toBeNull()
        expect(provider.capabilities.directUrl).toBe(false)
    })

    it('returns a direct URL only when public reads were explicitly enabled', () => {
        const provider = createHttpProvider({
            id: 'public',
            baseUrl: 'https://cdn.example.test/assets/',
            publicRead: true,
            fetch: vi.fn(),
        })
        const hash = 'a'.repeat(64)
        expect(provider.getPublicUrl(hash)).toBe(`https://cdn.example.test/assets/${hash}`)
        expect(provider.capabilities.directUrl).toBe(true)
    })

    it('aborts a stalled request at the configured timeout', async () => {
        vi.useFakeTimers()
        const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }))
        const provider = createHttpProvider({
            id: 'slow',
            baseUrl: 'https://assets.example.test/',
            fetch: fetchMock,
            timeoutMs: 1_000,
            retry: { attempts: 1 },
        })

        const pending = expect(provider.stat('a'.repeat(64)))
            .rejects.toMatchObject({ code: 'HTTP_NETWORK_ERROR' })
        await vi.advanceTimersByTimeAsync(1_001)
        await pending
        vi.useRealTimers()
    })
})

describe('Android SAF capability', () => {
    it('is an explicit future/native-bridge capability, not a fake filesystem provider', async () => {
        const provider = createAndroidSafProvider({ id: 'saf' })
        expect(provider.capabilities).toMatchObject({ unsupported: true, read: false, write: false, androidSaf: false })
        await expect(provider.get('a'.repeat(64))).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' })
    })
})

describe('provider verification fingerprint', () => {
    it('binds receipts to destination, credentials, and trash while ignoring cache tuning', () => {
        const base = {
            enabled: true,
            trashRoot: 'H:/PocketRisu-Assets/trash',
            cacheMaxBytes: 64,
            retryCount: 2,
            providers: {
                remote: {
                    type: 'http',
                    baseUrl: 'https://assets.example.test/',
                    headers: { authorization: 'Bearer one' },
                },
            },
        }
        const fingerprint = externalAssetProviderFingerprint(base, 'remote')
        expect(externalAssetProviderFingerprint({ ...base, cacheMaxBytes: 128, retryCount: 9 }, 'remote'))
            .toBe(fingerprint)
        expect(externalAssetProviderFingerprint({ ...base, trashRoot: 'H:/other-trash' }, 'remote'))
            .not.toBe(fingerprint)
        expect(externalAssetProviderFingerprint({
            ...base,
            providers: { remote: { ...base.providers.remote, headers: { authorization: 'Bearer two' } } },
        }, 'remote')).not.toBe(fingerprint)
    })
})

describe('detached pre-publish receipt verification', () => {
    it('stats then reads and hashes one provider object without populating the LRU', async () => {
        const data = Buffer.from('verify directly from provider')
        const hash = sha256(data)
        const order: string[] = []
        const provider = {
            id: 'external',
            capabilities: { read: true, stat: true },
            async stat() { order.push('stat'); return { hash, size: data.length } },
            async get() { order.push('get'); return Buffer.from(data) },
        }
        const { store } = memoryManifest()
        const service = createExternalAssetService({ providers: [provider], manifestStore: store, retry: { attempts: 1 } })

        await expect(service.verifyDetachedReceipt({
            uri: makeExternalAssetUri('external', hash),
            providerId: 'external',
            hash,
            size: data.length,
        })).resolves.toMatchObject({ hash, size: data.length, statSize: data.length })
        expect(order).toEqual(['stat', 'get'])
        expect(service.cache.size).toBe(0)
    })

    it('rejects a stat size mismatch before downloading bytes', async () => {
        const data = Buffer.from('expected')
        const hash = sha256(data)
        const get = vi.fn(async () => data)
        const provider = {
            id: 'external',
            capabilities: { read: true, stat: true },
            async stat() { return { hash, size: data.length + 1 } },
            get,
        }
        const { store } = memoryManifest()
        const service = createExternalAssetService({ providers: [provider], manifestStore: store, retry: { attempts: 1 } })

        await expect(service.verifyDetachedReceipt({
            uri: makeExternalAssetUri('external', hash),
            hash,
            size: data.length,
        })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
        expect(get).not.toHaveBeenCalled()
    })

    it('stream-verifies the retained trash copy and rejects a changed copy', async () => {
        const trashDir = tempDir('external-recovery-receipt')
        const data = Buffer.from('recoverable migration copy')
        const hash = sha256(data)
        const trashPath = 'job/receipt.bin'
        await fsp.mkdir(path.join(trashDir, 'job'), { recursive: true })
        await fsp.writeFile(path.join(trashDir, trashPath), data)
        const { store } = memoryManifest()
        const service = createExternalAssetService({
            providers: [],
            manifestStore: store,
            trashDir,
        })

        await expect(service.verifyRecoveryReceipt({ trashPath, hash, size: data.length }))
            .resolves.toMatchObject({ trashPath, hash, size: data.length })
        await fsp.writeFile(path.join(trashDir, trashPath), Buffer.from('tampered migration copy'))
        await expect(service.verifyRecoveryReceipt({ trashPath, hash, size: data.length }))
            .rejects.toMatchObject({ code: expect.stringMatching(/SIZE_MISMATCH|HASH_MISMATCH/) })
    })
})

describe('KV-backed manifest', () => {
    it('persists small JSON bytes and serializes concurrent updates', async () => {
        let tick = 0
        const { store, values } = memoryManifest(() => `t${++tick}`)
        const a = makeExternalAssetUri('local', 'a'.repeat(64))
        const b = makeExternalAssetUri('local', 'b'.repeat(64))

        await Promise.all([
            store.upsert(a, { hash: 'a'.repeat(64), size: 1 }),
            store.upsert(b, { hash: 'b'.repeat(64), size: 2 }),
        ])
        expect(await store.list()).toHaveLength(2)
        expect(await store.get(a)).toMatchObject({ uri: a, size: 1 })
        const persisted = JSON.parse(values.values().next().value.toString('utf8'))
        expect(persisted).toMatchObject({ version: 1 })
        expect(Object.keys(persisted.assets)).toEqual([a, b])
    })

    it('applies a batch with one manifest load/save, including repeated URI updates', async () => {
        const values = new Map<string, Buffer>()
        let reads = 0
        let writes = 0
        const store = createManifestStore({
            getValue: async (key: string) => {
                reads++
                return values.get(key) ?? null
            },
            setValue: async (key: string, value: Buffer) => {
                writes++
                values.set(key, Buffer.from(value))
            },
        })
        const a = makeExternalAssetUri('local', 'a'.repeat(64))
        const b = makeExternalAssetUri('local', 'b'.repeat(64))

        const results = await store.upsertMany([
            { uri: a, updater: { hash: 'a'.repeat(64), count: 1 } },
            { uri: b, value: { hash: 'b'.repeat(64), count: 10 } },
            { uri: a, updater: (old: any) => ({ ...old, count: old.count + 1 }) },
        ])

        expect(reads).toBe(1)
        expect(writes).toBe(1)
        expect(results.map((entry: any) => entry.count)).toEqual([1, 10, 2])
        const persisted = JSON.parse(values.values().next().value!.toString('utf8'))
        expect(persisted.assets[a]).toMatchObject({ uri: a, count: 2 })
        expect(persisted.assets[b]).toMatchObject({ uri: b, count: 10 })
    })
})

describe('safe migration staging and fallback lifecycle', () => {
    it('stages upload -> re-download verification -> trash -> manifest without deleting internal data', async () => {
        const providerRoot = tempDir('external-provider')
        const trashDir = tempDir('external-trash')
        const provider = createFilesystemProvider({ id: 'local', rootDir: providerRoot })
        const data = Buffer.from('character emotion image')
        const originalGet = provider.get
        const originalPut = provider.put
        const order: string[] = []
        provider.put = async (...args: any[]) => { order.push('put'); return originalPut(...args) }
        provider.get = async (...args: any[]) => { order.push('get'); return originalGet(...args) }

        const values = new Map<string, Buffer>()
        const store = createManifestStore({
            get: async (key: string) => values.get(key) ?? null,
            set: async (key: string, value: Buffer) => {
                expect(await allFiles(trashDir)).toHaveLength(1)
                order.push('manifest')
                values.set(key, Buffer.from(value))
            },
        })
        const internal = new Map([['assets/legacy.png', data]])
        const service = createExternalAssetService({
            providers: [provider],
            manifestStore: store,
            trashDir,
            readInternal: async (key: string) => internal.get(key) ?? null,
            retry: { attempts: 1 },
        })

        const staged = await service.stage({
            providerId: 'local',
            data,
            internalKey: 'assets/legacy.png',
            assetName: 'happy',
            mimeType: 'image/png',
            migrationId: 'migration-1',
            manifestMetadata: { sourceKind: 'character' },
        })
        expect(order).toEqual(['put', 'get', 'manifest'])
        expect(staged.uri).toBe(makeExternalAssetUri('local', sha256(data)))
        expect(staged.entry).toMatchObject({
            status: 'staged',
            size: data.length,
            migrationIds: ['migration-1'],
            sourceKind: 'character',
            fallbacks: [{ internalKey: 'assets/legacy.png' }],
        })
        expect(internal.get('assets/legacy.png')).toEqual(data) // staging never deletes the source
    })

    it('stages an async batch while loading and saving the growing manifest only once', async () => {
        const provider = createFilesystemProvider({ id: 'local', rootDir: tempDir('external-provider') })
        const trashDir = tempDir('external-trash')
        const values = new Map<string, Buffer>()
        let reads = 0
        let writes = 0
        const store = createManifestStore({
            getValue: async (key: string) => {
                reads++
                return values.get(key) ?? null
            },
            setValue: async (key: string, value: Buffer) => {
                writes++
                values.set(key, Buffer.from(value))
            },
        })
        const service = createExternalAssetService({
            providers: [provider], manifestStore: store, trashDir, retry: { attempts: 1 },
        })
        const shared = Buffer.from('same bytes referenced by character and module')

        async function* inputs() {
            yield {
                providerId: 'local', data: shared, internalKey: 'assets/character.png',
                migrationId: 'migration-character', manifestMetadata: { sourceKind: 'character' },
            }
            yield {
                providerId: 'local', data: shared, internalKey: 'assets/module.png',
                migrationId: 'migration-module', manifestMetadata: { sourceKind: 'module' },
            }
            yield {
                providerId: 'local', data: Buffer.from('different bytes'), internalKey: 'assets/other.png',
                migrationId: 'migration-character',
            }
        }

        const staged = await service.stageMany(inputs())
        expect(staged).toHaveLength(3)
        expect(reads).toBe(1)
        expect(writes).toBe(1)
        expect(staged[0].uri).toBe(staged[1].uri)
        expect(staged[0].entry).toMatchObject({
            migrationIds: ['migration-character', 'migration-module'],
            sourceKind: 'module',
            fallbacks: [
                { internalKey: 'assets/character.png' },
                { internalKey: 'assets/module.png' },
            ],
        })
        const persisted = JSON.parse(values.values().next().value!.toString('utf8'))
        expect(Object.keys(persisted.assets)).toHaveLength(2)
    })

    it('publishes no batch mappings when a later stage fails verification', async () => {
        const trashDir = tempDir('external-trash')
        const { store } = memoryManifest()
        const good = Buffer.from('first good asset')
        const bad = Buffer.from('second asset')
        const badHash = sha256(bad)
        const uploaded = new Map<string, Buffer>()
        const provider = {
            id: 'remote',
            capabilities: { read: true, write: true },
            async put(hash: string, data: Buffer) { uploaded.set(hash, Buffer.from(data)) },
            async get(hash: string) {
                return hash === badHash ? Buffer.from('corrupted after upload') : uploaded.get(hash)!
            },
        }
        const service = createExternalAssetService({
            providers: [provider], manifestStore: store, trashDir, retry: { attempts: 1 },
        })

        await expect(service.stageMany([
            { providerId: 'remote', data: good, internalKey: 'assets/good.png' },
            { providerId: 'remote', data: bad, internalKey: 'assets/bad.png' },
        ])).rejects.toMatchObject({ code: 'HASH_MISMATCH' })
        expect(await store.list()).toEqual([])
        expect(await allFiles(trashDir)).toHaveLength(1) // safe orphan; no reference was published
    })

    it('does not publish a manifest entry when re-download verification fails', async () => {
        const trashDir = tempDir('external-trash')
        const { store } = memoryManifest()
        const data = Buffer.from('good bytes')
        const provider = {
            id: 'broken',
            capabilities: { read: true, write: true },
            async put() {},
            async get() { return Buffer.from('corrupt bytes') },
        }
        const service = createExternalAssetService({
            providers: [provider], manifestStore: store, trashDir, retry: { attempts: 1 },
        })
        await expect(service.stage({
            providerId: 'broken', data, internalKey: 'assets/a.png',
        })).rejects.toMatchObject({ code: 'HASH_MISMATCH' })
        expect(await store.list()).toEqual([])
        expect(await allFiles(trashDir)).toEqual([])
    })

    it('falls back to trash first and then the retained internal file when the provider is down', async () => {
        const providerRoot = tempDir('external-provider')
        const trashDir = tempDir('external-trash')
        const provider = createFilesystemProvider({ id: 'local', rootDir: providerRoot })
        const data = Buffer.from('fallback bytes')
        const internal = new Map([['assets/fallback.png', data]])
        const { store } = memoryManifest()
        const service = createExternalAssetService({
            providers: [provider],
            manifestStore: store,
            trashDir,
            readInternal: async (key: string) => internal.get(key) ?? null,
            retry: { attempts: 1 },
        })
        const { uri, entry } = await service.stage({
            providerId: 'local', data, internalKey: 'assets/fallback.png',
        })
        service.cache.clear()
        fs.rmSync(providerRoot, { recursive: true, force: true })

        await expect(service.readWithMeta(uri)).resolves.toMatchObject({ data, source: 'trash' })
        fs.rmSync(path.join(trashDir, entry.fallbacks[0].trashPath), { force: true })
        await expect(service.readWithMeta(uri)).resolves.toMatchObject({ data, source: 'internal' })
    })

    it('repairs an unavailable provider object only from hash-verified fallback bytes', async () => {
        const providerRoot = tempDir('external-provider')
        const trashDir = tempDir('external-trash')
        const provider = createFilesystemProvider({ id: 'local', rootDir: providerRoot })
        const data = Buffer.from('doctor recovery bytes')
        const { store } = memoryManifest(() => '2026-08-25T00:00:00.000Z')
        const service = createExternalAssetService({
            providers: [provider], manifestStore: store, trashDir, retry: { attempts: 1 },
            now: () => '2026-08-25T00:00:00.000Z',
        })
        const staged = await service.stage({
            providerId: 'local', data, internalKey: 'assets/recover.png', mimeType: 'image/png',
        })
        service.cache.clear()
        fs.rmSync(path.join(providerRoot, staged.hash.slice(0, 2), staged.hash), { force: true })

        await expect(service.repairFromFallback(staged.uri)).resolves.toMatchObject({
            uri: staged.uri,
            hash: staged.hash,
            size: data.length,
            source: 'trash',
        })
        await expect(provider.get(staged.hash)).resolves.toEqual(data)
        expect(await store.get(staged.uri)).toMatchObject({
            status: 'verified',
            repairedAt: '2026-08-25T00:00:00.000Z',
        })
    })

    it('quarantines a corrupt filesystem object instead of deleting it during repair', async () => {
        const providerRoot = tempDir('external-provider')
        const trashDir = tempDir('external-trash')
        const provider = createFilesystemProvider({ id: 'local', rootDir: providerRoot })
        const data = Buffer.from('known healthy bytes')
        const internal = new Map([['assets/recover.png', data]])
        const { store } = memoryManifest()
        const service = createExternalAssetService({
            providers: [provider], manifestStore: store, trashDir, retry: { attempts: 1 },
            readInternal: async (key: string) => internal.get(key) ?? null,
        })
        const staged = await service.stage({
            providerId: 'local', data, internalKey: 'assets/recover.png',
        })
        service.cache.clear()
        const objectPath = path.join(providerRoot, staged.hash.slice(0, 2), staged.hash)
        fs.writeFileSync(objectPath, Buffer.from('corrupt but preserved'))

        const repaired = await service.repairFromFallback(staged.uri)
        expect(repaired.providerResult).toMatchObject({ repaired: true, quarantinePath: expect.any(String) })
        expect(fs.readFileSync(objectPath)).toEqual(data)
        expect(fs.readFileSync(repaired.providerResult.quarantinePath)).toEqual(Buffer.from('corrupt but preserved'))
    })

    it('refuses provider repair when every fallback fails hash validation', async () => {
        const providerRoot = tempDir('external-provider')
        const provider = createFilesystemProvider({ id: 'local', rootDir: providerRoot })
        const trashDir = tempDir('external-trash')
        const good = Buffer.from('expected bytes')
        const { store } = memoryManifest()
        const service = createExternalAssetService({
            providers: [provider], manifestStore: store, trashDir, retry: { attempts: 1 },
        })
        const staged = await service.stage({
            providerId: 'local', data: good, internalKey: 'assets/recover.png',
        })
        service.cache.clear()
        fs.rmSync(path.join(providerRoot, staged.hash.slice(0, 2), staged.hash), { force: true })
        const manifestEntry = await store.get(staged.uri)
        fs.writeFileSync(path.join(trashDir, manifestEntry.fallbacks[0].trashPath), Buffer.from('corrupt'))

        await expect(service.repairFromFallback(staged.uri)).rejects.toMatchObject({ code: 'FALLBACK_UNAVAILABLE' })
    })

    it('requires explicit user verification before purging verified trash', async () => {
        const providerRoot = tempDir('external-provider')
        const trashDir = tempDir('external-trash')
        const provider = createFilesystemProvider({ id: 'local', rootDir: providerRoot })
        const { store } = memoryManifest()
        const legacyStore = { get: store.get, upsert: store.upsert }
        const service = createExternalAssetService({
            providers: [provider], manifestStore: legacyStore, trashDir, retry: { attempts: 1 },
        })
        const staged = await service.stage({
            providerId: 'local', data: Buffer.from('purge me later'), internalKey: 'assets/purge.png',
        })
        await expect(service.purgeTrash(staged.uri, { userVerified: true }))
            .rejects.toMatchObject({ code: 'ASSET_NOT_VERIFIED' })
        await expect(service.verify(staged.uri)).resolves.toMatchObject({ hash: staged.hash, size: staged.size })
        await expect(service.purgeTrash(staged.uri)).rejects.toMatchObject({ code: 'USER_VERIFICATION_REQUIRED' })
        expect(await allFiles(trashDir)).toHaveLength(1)
        await expect(service.purgeTrash(staged.uri, { userVerified: true })).resolves.toMatchObject({ files: 1 })
        expect(await allFiles(trashDir)).toHaveLength(0)
        expect(await store.get(staged.uri)).toMatchObject({ trashPurgedAt: expect.any(String) })
    })

    it('batch-verifies external bytes and writes successful statuses once', async () => {
        const providerRoot = tempDir('external-provider')
        const provider = createFilesystemProvider({ id: 'local', rootDir: providerRoot })
        const trashDir = tempDir('external-trash')
        const values = new Map<string, Buffer>()
        let writes = 0
        const store = createManifestStore({
            getValue: async (key: string) => values.get(key) ?? null,
            setValue: async (key: string, value: Buffer) => {
                writes++
                values.set(key, Buffer.from(value))
            },
        })
        const service = createExternalAssetService({
            providers: [provider], manifestStore: store, trashDir, retry: { attempts: 1 },
        })
        const first = await service.stage({
            providerId: 'local', data: Buffer.from('verify-many-first'), internalKey: 'assets/first.png',
        })
        const second = await service.stage({
            providerId: 'local', data: Buffer.from('verify-many-second'), internalKey: 'assets/second.png',
        })
        await store.upsert(first.uri, (current: any) => {
            const { lastVerifiedAt: _lastVerifiedAt, ...entry } = current
            return { ...entry, status: 'indexed', size: 0, sizeKnown: false }
        })
        fs.rmSync(path.join(providerRoot, second.hash.slice(0, 2), second.hash), { force: true })

        const writesBefore = writes
        const results = await service.verifyMany([first.uri, second.uri])
        expect(results.map((result: any) => result.ok)).toEqual([true, false])
        expect(writes - writesBefore).toBe(1)
        expect(await store.get(first.uri)).toMatchObject({
            status: 'verified',
            size: Buffer.byteLength('verify-many-first'),
            sizeKnown: true,
        })
        expect(await store.get(second.uri)).toMatchObject({ status: 'staged' })
    })

    it('preflights every selected purge target and commits manifest cleanup as one batch', async () => {
        const provider = createFilesystemProvider({ id: 'local', rootDir: tempDir('external-provider') })
        const trashDir = tempDir('external-trash')
        const values = new Map<string, Buffer>()
        let writes = 0
        const store = createManifestStore({
            getValue: async (key: string) => values.get(key) ?? null,
            setValue: async (key: string, value: Buffer) => {
                writes++
                values.set(key, Buffer.from(value))
            },
        })
        const service = createExternalAssetService({
            providers: [provider], manifestStore: store, trashDir, retry: { attempts: 1 },
        })
        const first = await service.stage({
            providerId: 'local', data: Buffer.from('first purge target'), internalKey: 'assets/first.png',
        })
        const second = await service.stage({
            providerId: 'local', data: Buffer.from('second purge target'), internalKey: 'assets/second.png',
        })
        await service.verify(first.uri)

        await expect(service.purgeTrashMany([first.uri, second.uri], { userVerified: true }))
            .rejects.toMatchObject({ code: 'ASSET_NOT_VERIFIED' })
        expect(await allFiles(trashDir)).toHaveLength(2)

        await service.verify(second.uri)
        const writesBeforePurge = writes
        await expect(service.purgeTrashMany([first.uri, second.uri], { userVerified: true }))
            .resolves.toMatchObject({ files: 2, targets: 2 })
        expect(writes - writesBeforePurge).toBe(1)
        expect(await allFiles(trashDir)).toHaveLength(0)
        const firstEntry = await store.get(first.uri)
        expect(firstEntry).toMatchObject({
            trashPurgedAt: expect.any(String),
            fallbacks: [{ internalKey: 'assets/first.png' }],
        })
        expect(firstEntry.fallbacks[0]).not.toHaveProperty('trashPath')
        expect(await store.get(second.uri)).toMatchObject({ trashPurgedAt: expect.any(String) })
    })
})
