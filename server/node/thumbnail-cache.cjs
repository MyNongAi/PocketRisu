const nodeCrypto = require('crypto')
const path = require('path')
const fs = require('fs/promises')

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
const DEFAULT_CONCURRENCY = 2

function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function cacheFileName(identity) {
    return `${nodeCrypto.createHash('sha256').update(String(identity)).digest('hex')}.webp`
}

function createThumbnailCache(options = {}) {
    const rootDir = path.resolve(String(options.rootDir || 'thumbnail-cache'))
    const maxBytes = normalizePositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES)
    const maxConcurrent = normalizePositiveInteger(options.maxConcurrent, DEFAULT_CONCURRENCY)
    const generate = options.generate
    const logger = options.logger || console

    if (typeof generate !== 'function') {
        throw new TypeError('createThumbnailCache requires a generate(buffer) function')
    }

    const inFlight = new Map()
    const waiters = []
    let active = 0
    let readyPromise = null
    let prunePromise = null

    function ensureRoot() {
        if (!readyPromise) readyPromise = fs.mkdir(rootDir, { recursive: true })
        return readyPromise
    }

    async function withGenerationSlot(operation) {
        if (active >= maxConcurrent) {
            await new Promise((resolve) => waiters.push(resolve))
        }
        active += 1
        try {
            return await operation()
        } finally {
            active -= 1
            waiters.shift()?.()
        }
    }

    async function readCached(filePath) {
        try {
            const data = await fs.readFile(filePath)
            const now = new Date()
            fs.utimes(filePath, now, now).catch(() => {})
            return data
        } catch (error) {
            if (error?.code === 'ENOENT') return null
            throw error
        }
    }

    async function writeAtomic(filePath, data) {
        const tempName = `.${path.basename(filePath)}.${process.pid}.${nodeCrypto.randomBytes(6).toString('hex')}.tmp`
        const tempPath = path.join(rootDir, tempName)
        try {
            await fs.writeFile(tempPath, data, { flag: 'wx' })
            await fs.rename(tempPath, filePath)
        } finally {
            await fs.unlink(tempPath).catch((error) => {
                if (error?.code !== 'ENOENT') throw error
            })
        }
    }

    async function pruneNow() {
        await ensureRoot()
        const entries = await fs.readdir(rootDir, { withFileTypes: true })
        const files = []
        let totalBytes = 0

        for (const entry of entries) {
            if (!entry.isFile() || !/^[a-f0-9]{64}\.webp$/.test(entry.name)) continue
            const filePath = path.join(rootDir, entry.name)
            try {
                const stat = await fs.stat(filePath)
                totalBytes += stat.size
                files.push({ filePath, size: stat.size, usedAt: stat.mtimeMs })
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error
            }
        }

        if (totalBytes <= maxBytes) return { totalBytes, removed: 0 }

        files.sort((a, b) => a.usedAt - b.usedAt)
        const targetBytes = Math.floor(maxBytes * 0.9)
        let removed = 0
        for (const file of files) {
            if (totalBytes <= targetBytes) break
            try {
                await fs.unlink(file.filePath)
                totalBytes -= file.size
                removed += 1
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error
            }
        }
        return { totalBytes, removed }
    }

    function schedulePrune() {
        if (prunePromise) return
        prunePromise = pruneNow()
            .catch((error) => logger.warn?.('[ThumbnailCache] prune failed', error))
            .finally(() => { prunePromise = null })
    }

    async function get(identity, loadSource) {
        if (!identity) throw new TypeError('Thumbnail cache identity is required')
        if (typeof loadSource !== 'function') throw new TypeError('Thumbnail source loader is required')
        await ensureRoot()

        const fileName = cacheFileName(identity)
        const filePath = path.join(rootDir, fileName)
        const cached = await readCached(filePath)
        if (cached) return { data: cached, source: 'cache', fileName }

        if (inFlight.has(fileName)) return inFlight.get(fileName)

        const pending = withGenerationSlot(async () => {
            const raced = await readCached(filePath)
            if (raced) return { data: raced, source: 'cache', fileName }

            const original = Buffer.from(await loadSource())
            const generated = Buffer.from(await generate(original))
            await writeAtomic(filePath, generated)
            schedulePrune()
            return { data: generated, source: 'generated', fileName }
        }).finally(() => inFlight.delete(fileName))

        inFlight.set(fileName, pending)
        return pending
    }

    return {
        rootDir,
        maxBytes,
        maxConcurrent,
        get,
        prune: pruneNow,
    }
}

module.exports = {
    DEFAULT_MAX_BYTES,
    DEFAULT_CONCURRENCY,
    cacheFileName,
    createThumbnailCache,
}
