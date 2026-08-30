'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Database = require('better-sqlite3')

function argument(name, fallback = '') {
    const index = process.argv.indexOf(name)
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const jobId = argument('--job')
const dbPath = path.resolve(argument('--db'))
const jwtSecretPath = path.resolve(argument('--jwt-secret'))
const baseUrl = argument('--base-url', 'http://127.0.0.1:6001').replace(/\/$/, '')
const logPath = path.resolve(argument('--log', 'external-asset-finalize-monitor.log'))
const pollMs = Math.max(5_000, Number(argument('--poll-ms', '30000')) || 30_000)

if (!jobId || !argument('--db') || !argument('--jwt-secret')) {
    throw new Error('Usage: node external-asset-finalize-monitor.cjs --job ID --db FILE --jwt-secret FILE [--base-url URL] [--log FILE]')
}

fs.mkdirSync(path.dirname(logPath), { recursive: true })

function log(event, detail = {}) {
    const record = { at: new Date().toISOString(), event, ...detail }
    const line = JSON.stringify(record)
    fs.appendFileSync(logPath, `${line}\n`)
    console.log(line)
}

function readJob() {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
        return db.prepare(`
            SELECT id, status, total_items, verified_staged_items,
                   verification_failed_items, published_items, cleaned_items,
                   error, updated_at
            FROM external_asset_migration_jobs
            WHERE id = ?
        `).get(jobId)
    } finally {
        db.close()
    }
}

function createToken() {
    const secret = fs.readFileSync(jwtSecretPath, 'utf8').trim()
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const header = encode({ alg: 'HS256', typ: 'JWT' })
    const now = Math.floor(Date.now() / 1000)
    const payload = encode({ iat: now, exp: now + 5 * 60 })
    const signature = crypto.createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url')
    return `${header}.${payload}.${signature}`
}

async function post(endpoint) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'risu-auth': createToken(),
        },
        body: '{}',
    })
    const body = await response.text()
    let parsed = null
    try { parsed = body ? JSON.parse(body) : null } catch { parsed = { raw: body.slice(0, 1000) } }
    if (!response.ok) {
        const error = new Error(parsed?.error || `HTTP ${response.status}`)
        error.status = response.status
        error.body = parsed
        throw error
    }
    return parsed
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
    log('monitor-started', { jobId, dbPath, baseUrl })
    let lastProgressLogAt = 0
    let verificationRequested = false
    let finalizeRequested = false

    while (true) {
        const job = readJob()
        if (!job) throw new Error(`Migration job not found: ${jobId}`)

        const failed = Number(job.verification_failed_items || 0)
        const verified = Number(job.verified_staged_items || 0)
        const total = Number(job.total_items || 0)
        const now = Date.now()
        if (now - lastProgressLogAt >= 5 * 60 * 1000) {
            log('progress', { status: job.status, verified, total, failed, error: job.error || null })
            lastProgressLogAt = now
        }

        if (['published', 'verified', 'cleaned'].includes(job.status)) {
            log('already-finalized', {
                status: job.status,
                publishedItems: Number(job.published_items || 0),
                cleanedItems: Number(job.cleaned_items || 0),
            })
            return
        }

        if (job.status === 'staged-verified') {
            if (!finalizeRequested) {
                finalizeRequested = true
                log('finalize-requested', { verified, total })
                const result = await post(`/api/external-assets/migrate/jobs/${encodeURIComponent(jobId)}/finalize`)
                log('finalize-completed', {
                    removedInternalAssets: Number(result?.removedInternalAssets || 0),
                    retainedInternalAssets: Number(result?.retainedInternalAssets || 0),
                    staleItems: Number(result?.staleItems || 0),
                    safetyBackupKey: result?.safetyBackupKey || null,
                })
                return
            }
        } else if (job.status === 'staged' || job.status === 'verification-failed') {
            if (failed > 0) {
                throw new Error(`Verification stopped with ${failed} failed asset(s): ${job.error || 'repair required'}`)
            }
            if (!verificationRequested) {
                verificationRequested = true
                log('verification-requested', { verified, total })
                await post(`/api/external-assets/migrate/jobs/${encodeURIComponent(jobId)}/verify-staged`)
            }
        } else if (job.status === 'verifying') {
            verificationRequested = true
        } else if (job.status === 'finalizing') {
            finalizeRequested = true
        } else if (['failed', 'canceled'].includes(job.status)) {
            throw new Error(`Migration cannot continue from ${job.status}: ${job.error || 'no detail'}`)
        }

        await sleep(pollMs)
    }
}

main().catch((error) => {
    log('monitor-failed', {
        message: error?.message || String(error),
        status: error?.status || null,
        body: error?.body || null,
    })
    process.exitCode = 1
})
