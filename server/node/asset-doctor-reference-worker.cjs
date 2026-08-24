'use strict'

const Database = require('better-sqlite3')
const { isMainThread, parentPort, workerData } = require('worker_threads')
const { createChunkStore } = require('./chunkStore.cjs')
const { decodeRisuSave } = require('./utils.cjs')
const {
    collectAssetReferences,
    collectEmbeddedAssetReferenceCounts,
    collectExternalAssetReferences,
    collectMalformedExternalAssetReferences,
} = require('./external-asset-references.cjs')
const { groupReferences } = require('./asset-doctor.cjs')

const DB_BLOB_KEY = 'database/database.bin'
const MAX_DOCTOR_UNIQUE_REFERENCES = 250_000

function postProgress(phase, detail = {}) {
    parentPort?.postMessage({ type: 'progress', phase, ...detail })
}

function collectDoctorReferences(dbObj) {
    const direct = [
        ...collectAssetReferences(dbObj),
        ...collectExternalAssetReferences(dbObj),
        ...collectMalformedExternalAssetReferences(dbObj),
    ]
    const directCounts = new Map()
    for (const reference of direct) {
        directCounts.set(reference.value, (directCounts.get(reference.value) || 0) + 1)
    }
    const embedded = []
    for (const [value, totalOccurrences] of collectEmbeddedAssetReferenceCounts(dbObj)) {
        // The generic traversal also sees every exact structured field. Only
        // add the surplus so structured owner metadata is retained once while
        // chat/HTML/CSS uses of the same value are not discarded.
        const occurrences = totalOccurrences - (directCounts.get(value) || 0)
        if (occurrences <= 0) continue
        embedded.push({
            ownerType: 'embedded',
            ownerId: null,
            field: 'macro-or-text',
            path: null,
            value,
            occurrences,
        })
    }

    // Collapse duplicate occurrences in the worker before structured-cloning
    // the result back to the server. The main process receives only small
    // mapping records even for a database with hundreds of thousands of refs.
    const grouped = groupReferences([...direct, ...embedded])
    if (grouped.length > MAX_DOCTOR_UNIQUE_REFERENCES) {
        throw new Error(`Asset diagnosis exceeds the ${MAX_DOCTOR_UNIQUE_REFERENCES.toLocaleString('en-US')} unique-reference safety limit`)
    }
    return grouped.map((item) => ({
        value: item.reference,
        occurrences: item.occurrences,
        owners: item.owners,
    }))
}

async function runWorker(input) {
    if (typeof input?.dbPath !== 'string' || !input.dbPath) throw new Error('worker dbPath is required')
    const db = new Database(input.dbPath, { fileMustExist: true, readonly: true })
    try {
        db.pragma('busy_timeout = 30000')
        postProgress('reading-database')
        const raw = createChunkStore(db).getValue(DB_BLOB_KEY)
        if (!raw) throw new Error('database.bin is missing')
        postProgress('decoding-database', { databaseBytes: raw.length })
        const dbObj = await decodeRisuSave(raw)
        postProgress('collecting-references')
        const references = collectDoctorReferences(dbObj)
        return { references }
    } finally {
        db.close()
    }
}

if (!isMainThread) {
    runWorker(workerData)
        .then((result) => parentPort.postMessage({ type: 'done', result }))
        .catch((error) => {
            parentPort.postMessage({
                type: 'error',
                error: error?.message || String(error),
                stack: error?.stack,
            })
            process.exitCode = 1
        })
        .finally(() => parentPort?.close())
}

module.exports = { MAX_DOCTOR_UNIQUE_REFERENCES, collectDoctorReferences, runWorker }
