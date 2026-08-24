// ── NodeOnly: server-side JWT ────────────────────────────────────────────────
// Upstream uses client-side ECDSA JWT (crypto.subtle) which requires Secure
// Context (HTTPS/localhost). NodeOnly needs HTTP remote access, so JWT
// signing is moved to the server. The client only caches and forwards
// server-issued tokens. If upstream changes its auth flow, sync manually.
// Server counterpart: server/node/server.cjs (createServerJwt, checkAuth,
// /api/login, /api/token/refresh)
import { language } from "src/lang"
import { alertInput, waitAlert, notifyError } from "../alert"
import { decodeRisuSave, encodeRisuSaveLegacy } from "./risuSave"
import { normalizeChat } from "./database.svelte"

// ── User-gesture recency for the write lock ─────────────────────────────────
// The server moves the single-writer lock only on writes that follow a real
// user gesture (x-user-active header). The app also writes automatically —
// boot housekeeping, the flush-on-hide keepalive — and those must never move
// the lock: a phone tab going to background fires a flush, and without this
// distinction it silently stole the lock from the device actually in use.
const USER_GESTURE_WINDOW_MS = 15_000
let lastUserGestureAt = 0
if (typeof window !== 'undefined') {
    const markGesture = () => { lastUserGestureAt = Date.now() }
    window.addEventListener('pointerdown', markGesture, { capture: true, passive: true })
    window.addEventListener('keydown', markGesture, { capture: true, passive: true })
}
function isUserActive(): boolean {
    return Date.now() - lastUserGestureAt < USER_GESTURE_WINDOW_MS
}

// Custom error class for database conflict detection
export class ConflictError extends Error {
    currentEtag: string
    constructor(message: string, currentEtag: string) {
        super(message)
        this.name = 'ConflictError'
        this.currentEtag = currentEtag
    }
}

// Warning the server attaches to /api/patch responses when the most recent
// debounced persist failed (Stage 1 visibility — see issues.md).
export interface PersistWarning {
    timestamp: number
    message: string
    attemptedSize: number | null
    source: string
}

export interface PatchItemResult {
    success: boolean
    etag?: string
    persistWarning?: PersistWarning
    /** Hash-baseline 409. Must rebase; never reuse its ETag for a blind full write. */
    conflict?: boolean
    /** Set when the server's chat-internal-field guard rejected the patch. */
    chatGuardRejected?: boolean
}

export interface ExportBackupOptions {
    /** Strip NodeOnly-only inlay namespaces so upstream RisuAI can import it. */
    target?: 'upstream'
    /** Drop characters, chats and inlay images — a seed for a fresh instance. */
    mode?: 'settings'
    /**
     * Carry asset-pack module images. Defaults to true; set false to leave out
     * what is usually the bulk of a settings backup. Only meaningful with
     * `mode: 'settings'`.
     */
    moduleAssets?: boolean
}

/** Size breakdown backing the settings-only confirm dialog. */
export interface SettingsBackupEstimate {
    dbBytes: number
    baseAssets: { count: number, bytes: number }
    moduleAssets: { count: number, bytes: number, moduleCount: number }
}

export type ExternalAssetProviderConfig =
    | { type: 'filesystem', root: string }
    | {
        type: 'http'
        baseUrl: string
        headers?: Record<string, string>
        hasCredentials?: boolean
        readOnly?: boolean
        timeoutMs?: number
    }
    | { type: 'android-saf', treeUri?: string }

export interface ExternalAssetConfig {
    version?: number
    enabled: boolean
    activeProvider: string
    trashRoot: string
    cacheMaxBytes: number
    retryCount: number
    providers: Record<string, ExternalAssetProviderConfig>
}

export interface ExternalAssetStatus {
    config: ExternalAssetConfig
    providerCapabilities: Record<string, {
        read: boolean
        write: boolean
        available: boolean
        reason?: string
    }>
    manifest: {
        count: number
        bytes: number
        verified: number
        fallback: number
        migrations: Array<Record<string, unknown>>
        missingProviders?: string[]
    }
    cache: { entries: number, bytes: number, maxBytes: number }
}

export interface ExternalAssetMigrationScan {
    references: number
    uniqueAssets: number
    bytes: number
    missing: string[]
    alreadyExternal: number
}

export type ExternalAssetMigrationJobStatus =
    | 'planning' | 'queued' | 'running' | 'paused' | 'staged' | 'finalizing'
    | 'published' | 'verified' | 'cleaned' | 'canceled' | 'failed'

export interface ExternalAssetMigrationJob {
    id: string
    providerId: string
    databaseHash: string | null
    status: ExternalAssetMigrationJobStatus
    totalItems: number
    totalBytes: number
    stagedItems: number
    stagedBytes: number
    failedItems: number
    staleItems: number
    publishedItems: number
    cleanedItems: number
    createdAt: number
    updatedAt: number
    error: string | null
    safetyBackupKey: string | null
    progress: number
    metadata?: {
        references?: number
        alreadyExternal?: number
        uniqueAssets?: number
        missingCount?: number
        missingSamples?: string[]
        databaseBytes?: number
        [key: string]: unknown
    } | null
    planning?: {
        phase?: string
        current?: number
        total?: number
        databaseBytes?: number
        uniqueAssets?: number
        items?: number
        bytes?: number
    }
}

export interface ExternalAssetRestoreHealth {
    references: number
    mapped: number
    missingManifest: number
    missingManifestSamples?: string[]
    missingProviders: string[]
    unavailableProviders?: string[]
    unavailableAssets?: number
    unavailableSamples?: Array<{ uri?: string, error: string }>
    availabilityChecked?: number
    healthCheckError?: string
    requiresConfiguration?: boolean
}

export type AssetDoctorJobStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface AssetDoctorIssue {
    id: string
    code: 'internal-missing' | 'manifest-missing' | 'provider-missing' | 'provider-unavailable'
        | 'size-mismatch' | 'hash-mismatch' | 'cache-corrupt' | 'decode-failed' | 'invalid-external-reference'
        | 'internal-read-failed'
    message: string
    reference: string
    kind: 'internal' | 'external' | 'invalid-external'
    occurrences: number
    owners: Array<{ ownerType: string, ownerId: string | null, field: string | null, path: string | null }>
    providerId?: string
    expectedSize?: number | null
    actualSize?: number | null
    expectedHash?: string
    actualHash?: string
    fallbackAvailable?: boolean
    fallbackSource?: 'trash' | 'internal' | null
    servingFallback?: boolean
    repairable: boolean
    repairAction?: 'invalidate-cache' | 'restore-exact-hash' | null
    error?: { code?: string | null, message: string }
}

export interface AssetDoctorResult {
    summary: {
        references: number
        uniqueAssets: number
        internalAssets: number
        externalAssets: number
        invalidExternalAssets: number
        healthy: number
        problems: number
        missing: number
        cacheProblems: number
        providerProblems: number
        integrityProblems: number
        fallbackCandidates: number
        hashVerifiedSamples: number
        decodedSamples: number
        decodeFailures: number
        skippedLargeSamples: number
    }
    issues: AssetDoctorIssue[]
    issuesTruncated: number
    samplePolicy: { maxSamples: number, maxBytesPerSample: number, note: string }
}

export interface AssetDoctorJob {
    id: string
    status: AssetDoctorJobStatus
    createdAt: number
    updatedAt: number
    progress: { phase: string, current: number, total: number }
    result: AssetDoctorResult | null
    error: string | null
    repair?: {
        id: string
        status: string
        manifestBackupKey: string | null
        repaired: number
        failed: number
        results: Array<Record<string, unknown>>
    } | null
}

export interface BackupImportResult {
    ok: boolean
    assetsRestored: number
    coldStorageFailed?: number
    externalAssets?: ExternalAssetRestoreHealth
}

export class NodeStorage{
    private static readonly BULK_WRITE_CLIENT_BATCH = 20

    // Cross-device single-writer lock identity. Persisted in sessionStorage so
    // a reload or an OS tab restore of the SAME tab keeps the same identity —
    // a phone tab resurrected in the background must not look like a new
    // device (which used to silently steal the write lock from a PC
    // mid-session). Still per-tab: a genuinely new tab gets a new id, and
    // same-device multi-tab is handled by the BroadcastChannel lock.
    private static sessionId: string = (() => {
        const KEY = 'risu-writer-session-id'
        const minted = crypto?.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2))
        try {
            const stored = sessionStorage.getItem(KEY)
            if (stored) return stored
            sessionStorage.setItem(KEY, minted)
        } catch { /* storage unavailable (rare privacy modes) — per-load id */ }
        return minted
    })()

    _lastDbEtag: string | null = null
    authChecked = false
    private cachedJwt: { token: string; expiresAt: number } | null = null
    private static sessionInitialized = false
    private static sessionPending: Promise<void> | null = null
    private refreshPending: Promise<string> | null = null

    async createAuth(){
        const now = Date.now()
        if (this.cachedJwt && this.cachedJwt.expiresAt - now > 30_000) {
            return this.cachedJwt.token
        }
        const token = await this._refreshToken()
        return token
    }

    // Called once after JWT auth is confirmed. Issues a session cookie so that
    // <img src="/api/asset/..."> can be served without JS-injected headers.
    private async initSession() {
        if (NodeStorage.sessionInitialized) return
        if (NodeStorage.sessionPending) return NodeStorage.sessionPending
        NodeStorage.sessionPending = this._doInitSession()
        return NodeStorage.sessionPending
    }

    private async _doInitSession() {
        try {
            const res = await fetch('/api/session', {
                method: 'POST',
                headers: {
                    'risu-auth': await this.createAuth(),
                    'x-session-id': NodeStorage.sessionId,
                },
            })
            if (res.ok) {
                NodeStorage.sessionInitialized = true
            }
            // Non-ok (400/401/500): will retry on next checkAuth() call.
        } catch {
            // Network error: will retry on next checkAuth() call.
        } finally {
            NodeStorage.sessionPending = null
        }
    }

    private async _refreshToken(): Promise<string> {
        if (this.refreshPending) return this.refreshPending
        this.refreshPending = this._doRefreshToken()
        try { return await this.refreshPending }
        finally { this.refreshPending = null }
    }

    private async _doRefreshToken(): Promise<string> {
        const res = await fetch('/api/token/refresh', {
            method: 'POST',
            headers: { 'risu-auth': this.cachedJwt?.token ?? '' }
        })
        if (res.ok) {
            const data = await res.json()
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
            return data.token
        }
        return this.cachedJwt?.token ?? ''
    }

    private async loginWithPassword(password: string) {
        const response = await fetch('/api/login', {
            method: "POST",
            body: JSON.stringify({ password }),
            headers: {
                'content-type': 'application/json'
            }
        })

        if(response.status === 429){
            notifyError(`Too many attempts. Please wait and try again later.`)
            await waitAlert()
            throw new Error('Too many login attempts')
        }

        if(response.status < 200 || response.status >= 300){
            let message = 'Node login failed'
            try {
                const data = await response.json()
                message = data.error ?? message
            } catch {
                // noop
            }
            throw new Error(message)
        }

        const data = await response.json()
        if (data.token) {
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
        }
        this.authChecked = true
    }

    private async shouldRetryAuth(response: Response) {
        if(response.status !== 400 && response.status !== 401){
            return false
        }

        try {
            const data = await response.clone().json()
            return [
                'No auth header',
                'Invalid Signature',
                'Token Expired'
            ].includes(data?.error)
        } catch {
            return false
        }
    }

    private async authFetch(input: RequestInfo | URL, init: RequestInit = {}, retry = true) {
        await this.checkAuth()
        const headers = new Headers(init.headers)
        headers.set('risu-auth', await this.createAuth())
        headers.set('x-session-id', NodeStorage.sessionId)
        if (isUserActive()) headers.set('x-user-active', '1')

        const response = await fetch(input, {
            ...init,
            headers
        })

        if (response.status === 423) {
            window.dispatchEvent(new CustomEvent('risu-session-deactivated'))
        }

        if(retry && await this.shouldRetryAuth(response)){
            this.authChecked = false
            this.cachedJwt = null
            await this.checkAuth()
            return this.authFetch(input, init, false)
        }

        return response
    }

    async setItem(key:string, value:Uint8Array, etag?:string) {
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }
        if (etag) {
            headers['x-if-match'] = etag
        }
        const da = await this.authFetch('/api/write', {
            method: "POST",
            body: value as any,
            headers
        })
        if(da.status === 409){
            const data = await da.json()
            throw new ConflictError(data.error, data.currentEtag)
        }
        if(da.status < 200 || da.status >= 300){
            throw "setItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
    }
    async getItem(key:string):Promise<Buffer> {
        const headers: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }

        const da = await this.authFetch('/api/read', { method: "GET", headers })
        if(da.status < 200 || da.status >= 300){
            throw "getItem Error"
        }

        // Capture ETag for database.bin
        const etag = da.headers.get('x-db-etag')
        if (etag) {
            this._lastDbEtag = etag
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length === 0){
            return null
        }

        return data
    }
    async keys(prefix: string = ''):Promise<string[]>{
        const headers: Record<string, string> = {
        }
        if (prefix) {
            headers['key-prefix'] = prefix
        }
        const da = await this.authFetch('/api/list', {
            method: "GET",
            headers
        })
        if(da.status < 200 || da.status >= 300){
            throw "listItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        return data.content
    }
    async removeItem(key:string){
        const da = await this.authFetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "removeItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    private async checkAuth(){

        if(!this.authChecked){
            const data = await (await fetch('/api/test_auth',{
                headers: {
                    'risu-auth': this.cachedJwt?.token ?? ''
                }
            })).json()

            if(data.status === 'unset'){
                const input = await digestPassword(await alertInput(language.setNodePassword))
                const response = await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })

                if(response.status < 200 || response.status >= 300){
                    throw new Error('Failed to set node password')
                }

                await this.loginWithPassword(input)
                await this.initSession()
                return
            }
            else if(data.status === 'incorrect'){
                const input = await digestPassword(await alertInput(language.inputNodePassword))
                await this.loginWithPassword(input)
                await this.initSession()
                return
            }
            else{
                if (data.token) {
                    this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
                }
                this.authChecked = true
            }
        }
        await this.initSession()
    }

    listItem = this.keys

    /** Set cached ETag for database.bin */
    setDbEtag(etag: string | null) {
        this._lastDbEtag = etag
    }

    /** Writer-lock state of THIS session (side-effect free; reload-on-return
     *  check). 'stale' = another device wrote after this page booted — our
     *  in-memory copy is outdated and must reload before writing again. */
    async getWriterLockState(): Promise<'free' | 'active' | 'fresh' | 'stale' | 'unknown'> {
        try {
            const res = await this.authFetch('/api/session/lock-status')
            if (!res.ok) return 'unknown'
            const data = await res.json()
            return data?.state ?? 'unknown'
        } catch {
            return 'unknown'
        }
    }

    async patchItem(key: string, patchData: { patch: any[], expectedHash: string }): Promise<PatchItemResult> {
        const da = await this.authFetch('/api/patch', {
            method: "POST",
            body: JSON.stringify(patchData),
            headers: {
                'content-type': 'application/json',
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            }
        })

        if (da.status === 409) {
            const data = await da.json()
            const currentEtag = data.currentEtag as string | undefined
            if (key === 'database/database.bin' && currentEtag) {
                this._lastDbEtag = currentEtag
            }
            // Server signals chat-guard rejection via explicit fields. The
            // error string fallback is kept for forward-compat with deployed
            // servers that haven't shipped the explicit fields yet.
            const rejectedByChatGuard = data.chatGuardRejected === true
                || data.code === 'CHAT_GUARD_REJECTED'
                || (typeof data.error === 'string' && data.error.includes('chat-internal field ops'))
            return {
                success: false,
                etag: currentEtag,
                conflict: !rejectedByChatGuard,
                chatGuardRejected: rejectedByChatGuard,
            }
        }
        if (da.status < 200 || da.status >= 300) {
            // Surface the server's error detail — without this the browser
            // console shows nothing while every save silently falls back to
            // a full write.
            const body = await da.text().catch(() => '')
            console.error(`[Patch] Server rejected patch (${da.status}):`, body)
            return { success: false }
        }
        const data = await da.json()
        if (data.error) {
            return { success: false }
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
        const persistWarning = data.persistWarning as PersistWarning | undefined
        return { success: true, etag: nextEtag, persistWarning }
    }

    // ── Bulk asset operations (3-2-B) ──────────────────────────────────────────
    async getItems(keys: string[]): Promise<{key: string, value: Buffer}[]> {
        const da = await this.authFetch('/api/assets/bulk-read', {
            method: 'POST',
            body: JSON.stringify(keys),
            headers: {
                'content-type': 'application/json',
                'accept': 'application/octet-stream'
            }
        })
        if (da.status < 200 || da.status >= 300) throw 'getItems Error'

        const ct = da.headers.get('content-type') || ''
        if (ct.includes('application/octet-stream')) {
            // Binary protocol: [count(4)] then per entry: [keyLen(4)][key][valLen(4)][value]
            const buf = Buffer.from(await da.arrayBuffer())
            let offset = 0
            const count = buf.readUInt32BE(offset); offset += 4
            const results: {key: string, value: Buffer}[] = []
            for (let i = 0; i < count; i++) {
                const keyLen = buf.readUInt32BE(offset); offset += 4
                const key = buf.subarray(offset, offset + keyLen).toString('utf-8'); offset += keyLen
                const valLen = buf.readUInt32BE(offset); offset += 4
                const value = buf.subarray(offset, offset + valLen) as Buffer; offset += valLen
                results.push({ key, value })
            }
            return results
        }

        // Fallback: JSON+base64
        const results: {key: string, value: string}[] = await da.json()
        return results.map(r => ({ key: r.key, value: Buffer.from(r.value, 'base64') }))
    }

    async setItems(entries: {key: string, value: Uint8Array}[]) {
        for (let i = 0; i < entries.length; i += NodeStorage.BULK_WRITE_CLIENT_BATCH) {
            const batch = entries.slice(i, i + NodeStorage.BULK_WRITE_CLIENT_BATCH)
            const body = batch.map(e => ({
                key: e.key,
                value: Buffer.from(e.value).toString('base64')
            }))
            const da = await this.authFetch('/api/assets/bulk-write', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: {
                    'content-type': 'application/json'
                }
            })
            if (da.status < 200 || da.status >= 300) throw 'setItems Error'
        }
    }

    // ─── External asset store ───────────────────────────────────────────────
    async readExternalAsset(uri: string): Promise<Buffer> {
        const encoded = Buffer.from(uri, 'utf-8').toString('hex')
        const response = await this.authFetch(`/api/external-assets/content/${encoded}`, {
            headers: { 'cache-control': 'no-cache' },
        })
        if (!response.ok) {
            let message = `external asset read failed: ${response.status}`
            try { message = (await response.json())?.error ?? message } catch {}
            throw new Error(message)
        }
        return Buffer.from(await response.arrayBuffer())
    }

    async externalAssetStatus(): Promise<ExternalAssetStatus> {
        const response = await this.authFetch('/api/external-assets/status')
        if (!response.ok) throw new Error(`external asset status failed: ${response.status}`)
        return await response.json()
    }

    async updateExternalAssetConfig(config: Partial<ExternalAssetConfig>): Promise<ExternalAssetStatus> {
        const response = await this.authFetch('/api/external-assets/config', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(config),
        })
        if (!response.ok) {
            const body = await response.json().catch(() => ({}))
            throw new Error(body.error || `external asset config failed: ${response.status}`)
        }
        return await response.json()
    }

    async scanExternalAssetMigration(providerId?: string): Promise<ExternalAssetMigrationJob> {
        const response = await this.authFetch('/api/external-assets/migrate/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providerId }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `external asset migration scan failed: ${response.status}`)
        return body.job
    }

    async startAssetDiagnosis(options: { sampleLimit?: number, maxSampleBytes?: number } = {}): Promise<AssetDoctorJob> {
        const response = await this.authFetch('/api/external-assets/doctor/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(options),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `asset diagnosis failed to start: ${response.status}`)
        return body.job
    }

    async listAssetDiagnosisJobs(): Promise<AssetDoctorJob[]> {
        const response = await this.authFetch('/api/external-assets/doctor/jobs')
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `asset diagnosis list failed: ${response.status}`)
        return body.jobs ?? []
    }

    async getAssetDiagnosisJob(jobId: string): Promise<AssetDoctorJob> {
        const response = await this.authFetch(`/api/external-assets/doctor/jobs/${encodeURIComponent(jobId)}`)
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `asset diagnosis status failed: ${response.status}`)
        return body.job
    }

    async repairAssetDiagnosis(jobId: string, issueIds?: string[]): Promise<{
        ok: boolean
        repair: NonNullable<AssetDoctorJob['repair']>
    }> {
        const response = await this.authFetch(`/api/external-assets/doctor/jobs/${encodeURIComponent(jobId)}/repair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirmed: true, issueIds }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `asset repair failed: ${response.status}`)
        return body
    }

    async migrateExternalAssets(providerId?: string): Promise<{ migrationId: string, job: ExternalAssetMigrationJob }> {
        const response = await this.authFetch('/api/external-assets/migrate/execute', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providerId }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `external asset migration failed: ${response.status}`)
        return body
    }

    async listExternalAssetMigrationJobs(limit = 20): Promise<ExternalAssetMigrationJob[]> {
        const response = await this.authFetch(`/api/external-assets/migrate/jobs?limit=${encodeURIComponent(limit)}`)
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `external asset migration jobs failed: ${response.status}`)
        return body.jobs ?? []
    }

    async getExternalAssetMigrationJob(jobId: string): Promise<ExternalAssetMigrationJob> {
        const response = await this.authFetch(`/api/external-assets/migrate/jobs/${encodeURIComponent(jobId)}`)
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `external asset migration job failed: ${response.status}`)
        return body.job
    }

    private async externalAssetMigrationAction(jobId: string, action: 'pause'|'resume'|'cancel'|'finalize'): Promise<Record<string, any>> {
        const response = await this.authFetch(`/api/external-assets/migrate/jobs/${encodeURIComponent(jobId)}/${action}`, {
            method: 'POST',
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `external asset migration ${action} failed: ${response.status}`)
        return body
    }

    async pauseExternalAssetMigration(jobId: string): Promise<ExternalAssetMigrationJob> {
        return (await this.externalAssetMigrationAction(jobId, 'pause')).job
    }

    async resumeExternalAssetMigration(jobId: string): Promise<ExternalAssetMigrationJob> {
        return (await this.externalAssetMigrationAction(jobId, 'resume')).job
    }

    async cancelExternalAssetMigration(jobId: string): Promise<ExternalAssetMigrationJob> {
        return (await this.externalAssetMigrationAction(jobId, 'cancel')).job
    }

    async finalizeExternalAssetMigration(jobId: string): Promise<Record<string, any>> {
        return await this.externalAssetMigrationAction(jobId, 'finalize')
    }

    async verifyExternalAssets(migrationId?: string): Promise<Record<string, any>> {
        const response = await this.authFetch('/api/external-assets/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ migrationId }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `external asset verification failed: ${response.status}`)
        return body
    }

    async purgeExternalAssetTrash(migrationId?: string): Promise<Record<string, any>> {
        const response = await this.authFetch('/api/external-assets/trash/purge', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ migrationId, userVerified: true }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `external asset trash purge failed: ${response.status}`)
        return body
    }

    async exportBackup(opts?: ExportBackupOptions): Promise<Response> {
        const params = new URLSearchParams()
        if (opts?.target === 'upstream') params.set('target', 'upstream')
        if (opts?.mode === 'settings') params.set('mode', 'settings')
        if (opts?.moduleAssets === false) params.set('moduleAssets', '0')
        const query = params.toString()
        const url = query ? `/api/backup/export?${query}` : '/api/backup/export'
        const da = await this.authFetch(url)
        if (da.status < 200 || da.status >= 300) throw `backup export error: ${da.status}`
        return da
    }

    async settingsBackupEstimate(): Promise<SettingsBackupEstimate> {
        const da = await this.authFetch('/api/backup/export/settings-estimate')
        if (da.status < 200 || da.status >= 300) throw `settings estimate error: ${da.status}`
        return await da.json()
    }

    async prepareImport(size: number): Promise<void> {
        const da = await this.authFetch('/api/backup/import/prepare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ size }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status === 413) throw new Error('Backup file is too large')
        if (da.status === 507) {
            const body = await da.json().catch(() => ({}))
            const avail = body.available != null ? ` (available: ${Math.round(body.available / 1024 / 1024)} MB)` : ''
            throw new Error(`Insufficient disk space${avail}`)
        }
        if (da.status < 200 || da.status >= 300) throw new Error(`backup prepare error: ${da.status}`)
    }

    async importBackup(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<BackupImportResult> {
        await this.prepareImport(file.size)
        const authHeader = await this.createAuth()

        return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/backup/import')
            xhr.setRequestHeader('content-type', 'application/x-risu-backup')
            xhr.setRequestHeader('risu-auth', authHeader)
            xhr.setRequestHeader('x-session-id', NodeStorage.sessionId)
            if (isUserActive()) xhr.setRequestHeader('x-user-active', '1')
            // Opt into NDJSON streaming so the server keeps the response socket
            // alive during long post-upload work — prevents reverse-proxy 502s.
            xhr.setRequestHeader('accept', 'application/x-ndjson')

            let uploadComplete = false
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }
            xhr.upload.onload = () => { uploadComplete = true }

            let parsedIndex = 0
            let leftover = ''
            let result: BackupImportResult | null = null
            let serverErrorMsg: string | null = null

            const drainNdjson = () => {
                const text = xhr.responseText
                if (text.length <= parsedIndex) return
                leftover += text.slice(parsedIndex)
                parsedIndex = text.length
                const lines = leftover.split('\n')
                leftover = lines.pop() ?? ''
                for (const line of lines) {
                    if (!line) continue
                    let msg: any
                    try { msg = JSON.parse(line) } catch { continue }
                    if (msg.type === 'progress' && uploadComplete) {
                        // After upload finishes, surface server-side processing
                        // progress through the same callback for UI continuity.
                        onProgress?.(msg.bytes, msg.totalBytes)
                    } else if (msg.type === 'done') {
                        result = msg
                    } else if (msg.type === 'error') {
                        serverErrorMsg = typeof msg.message === 'string' ? msg.message : 'backup import failed'
                    }
                    // Ignore 'heartbeat' and unknown event types.
                }
            }

            xhr.onprogress = drainNdjson
            xhr.onerror = () => reject(new Error('backup import request failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    let msg = `backup import error: ${xhr.status}`
                    try {
                        const body = JSON.parse(xhr.responseText)
                        if (body?.error) msg = String(body.error)
                    } catch {}
                    reject(new Error(msg))
                    return
                }
                drainNdjson()
                if (serverErrorMsg) reject(new Error(serverErrorMsg))
                else if (result) resolve(result)
                else reject(new Error('backup import: no result received'))
            }

            xhr.send(file)
        })
    }

    // ── Server-side backup ─────────────────────────────────────────────────────

    async saveServerBackup(
        onProgress?: (current: number, total: number, bytes: number, totalBytes: number) => void
    ): Promise<{ok: boolean, filename: string, size: number}> {
        const da = await this.authFetch('/api/backup/server/save', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-session-id': NodeStorage.sessionId,
            },
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup save error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {ok: boolean, filename: string, size: number} | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.current, msg.total, msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup: no result received')
        return result
    }

    async listServerBackups(): Promise<{backups: Array<{filename: string, size: number, createdAt: number}>}> {
        const da = await this.authFetch('/api/backup/server/list')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup list error: ${da.status}`)
        return da.json()
    }

    async restoreServerBackup(
        filename: string,
        onProgress?: (bytes: number, totalBytes: number) => void
    ): Promise<BackupImportResult> {
        const da = await this.authFetch('/api/backup/server/restore', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-session-id': NodeStorage.sessionId,
            },
            body: JSON.stringify({ filename }),
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup restore error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: BackupImportResult | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup restore: no result received')
        return result
    }

    async deleteServerBackup(filename: string): Promise<void> {
        const da = await this.authFetch(`/api/backup/server/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup delete error: ${da.status}`)
    }

    async downloadServerBackup(filename: string): Promise<Response> {
        const da = await this.authFetch(`/api/backup/server/download/${encodeURIComponent(filename)}`)
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup download error: ${da.status}`)
        return da
    }

    // ── Chat content (runtime lazy load) ────────────────────────────────────

    async fetchChatContent(chaId: string, chatIndex: number, chatId: string): Promise<any | null> {
        const da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
            headers: { 'x-chat-id': chatId },
        })
        if (da.status === 404) return null
        if (da.status < 200 || da.status >= 300) throw new Error(`fetchChatContent error: ${da.status}`)
        const buffer = new Uint8Array(await da.arrayBuffer())
        return normalizeChat(await decodeRisuSave(buffer))
    }

    async saveChatContent(chaId: string, chatIndex: number, chatId: string, chat: any): Promise<void> {
        const encoded = encodeRisuSaveLegacy(chat)
        const da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-chat-id': chatId,
            },
            body: encoded,
        })
        if (da.status < 200 || da.status >= 300) throw new Error(`saveChatContent error: ${da.status}`)
    }

    // ── Save-folder migration ─────────────────────────────────────────────────

    async scanSaveFolder(folderPath?: string): Promise<{count: number, totalSize: number, hasDatabase: boolean}> {
        const da = await this.authFetch('/api/migrate/save-folder/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: folderPath }),
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `scan error: ${da.status}`)
        }
        return da.json()
    }

    async executeSaveFolderImport(folderPath?: string): Promise<{ok: boolean, imported: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/execute', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: folderPath }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `import error: ${da.status}`)
        }
        return da.json()
    }

    async uploadSaveFolderZip(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<{ok: boolean, imported: number}> {
        const authHeader = await this.createAuth()

        return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/migrate/save-folder/upload')
            xhr.setRequestHeader('content-type', 'application/zip')
            xhr.setRequestHeader('risu-auth', authHeader)
            xhr.setRequestHeader('x-session-id', NodeStorage.sessionId)
            if (isUserActive()) xhr.setRequestHeader('x-user-active', '1')

            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }

            xhr.onerror = () => reject(new Error('zip upload failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    let msg = `zip import error: ${xhr.status}`
                    try { msg = JSON.parse(xhr.responseText).error || msg } catch {}
                    reject(new Error(msg))
                    return
                }
                try {
                    resolve(JSON.parse(xhr.responseText))
                } catch (error) {
                    reject(error)
                }
            }

            xhr.send(file)
        })
    }

    async scanCleanup(): Promise<{count: number, totalSize: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/cleanup/scan', {
            method: 'POST',
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `cleanup scan error: ${da.status}`)
        }
        return da.json()
    }

    async executeCleanup(): Promise<{ok: boolean, removed: number, freedBytes: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/cleanup/execute', {
            method: 'POST',
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `cleanup error: ${da.status}`)
        }
        return da.json()
    }

}

async function digestPassword(message:string) {
    const res = await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })
    if(res.status < 200 || res.status >= 300){
        throw new Error(`Password hashing failed (${res.status})`)
    }
    return await res.text()
}
