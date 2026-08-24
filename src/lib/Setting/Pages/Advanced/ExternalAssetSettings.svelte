<script lang="ts">
    import { onMount } from 'svelte'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import type { AssetDoctorJob, ExternalAssetMigrationJob, ExternalAssetStatus } from 'src/ts/storage/nodeStorage'

    let status: ExternalAssetStatus | null = $state(null)
    let loading = $state(false)
    let message = $state('')
    let enabled = $state(true)
    let providerId = $state('local')
    let providerType: 'filesystem'|'http'|'android-saf' = $state('filesystem')
    let filesystemRoot = $state('')
    let trashRoot = $state('')
    let httpBaseUrl = $state('')
    let httpHeaders = $state('')
    let httpReadOnly = $state(false)
    let cacheMb = $state(64)
    let retryCount = $state(2)
    let migrationJob: ExternalAssetMigrationJob | null = $state(null)
    let doctorJob: AssetDoctorJob | null = $state(null)
    let doctorSampleLimit = $state(12)
    let pollTimer: number | null = null

    const terminalMigrationStatuses = new Set(['published', 'verified', 'cleaned', 'canceled'])

    function formatBytes(value: number) {
        if (!Number.isFinite(value) || value <= 0) return '0 B'
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
        return `${(value / 1024 ** unit).toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`
    }

    async function refreshMigrationJob() {
        if (!migrationJob) return
        try {
            migrationJob = await forageStorage.getExternalAssetMigrationJob(migrationJob.id)
        } catch { /* the next manual action will surface a useful error */ }
    }

    async function refreshDoctorJob() {
        if (!doctorJob || ['completed', 'failed'].includes(doctorJob.status)) return
        try { doctorJob = await forageStorage.getAssetDiagnosisJob(doctorJob.id) }
        catch { /* keep the last visible progress; a manual retry surfaces the error */ }
    }

    function hasSavedHttpCredentials() {
        const provider = status?.config.providers[providerId]
        return provider?.type === 'http' && provider.hasCredentials === true
    }

    function syncForm(next: ExternalAssetStatus) {
        status = next
        const config = next.config
        enabled = config.enabled
        providerId = config.activeProvider || 'local'
        cacheMb = Math.round(config.cacheMaxBytes / 1024 / 1024)
        retryCount = config.retryCount
        trashRoot = config.trashRoot || 'save/external-assets/trash'
        const provider = config.providers[providerId]
        if (!provider) return
        providerType = provider.type
        if (provider.type === 'filesystem') filesystemRoot = provider.root
        if (provider.type === 'http') {
            httpBaseUrl = provider.baseUrl
            // Credential values stay server-side and are never returned by
            // the status API. Blank means preserve the currently saved value.
            httpHeaders = ''
            httpReadOnly = provider.readOnly ?? false
        }
    }

    async function run<T>(label: string, operation: () => Promise<T>): Promise<T | null> {
        loading = true
        message = label
        try {
            return await operation()
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error)
            message = text
            notifyError(text)
            return null
        } finally {
            loading = false
        }
    }

    async function refresh() {
        const next = await run('Loading external asset status…', () => forageStorage.externalAssetStatus())
        if (next) {
            syncForm(next)
            message = ''
        }
    }

    async function saveConfig() {
        let provider: any
        if (providerType === 'filesystem') {
            provider = { type: 'filesystem', root: filesystemRoot }
        } else if (providerType === 'http') {
            let headers: Record<string, string> | undefined
            if (httpHeaders.trim()) {
                try { headers = JSON.parse(httpHeaders) }
                catch {
                    notifyError('HTTP headers must be a JSON object.')
                    return
                }
            }
            provider = { type: 'http', baseUrl: httpBaseUrl, headers, readOnly: httpReadOnly }
            if (headers === undefined) delete provider.headers
        } else {
            provider = { type: 'android-saf' }
        }

        const next = await run('Saving external asset configuration…', () => forageStorage.updateExternalAssetConfig({
            enabled,
            activeProvider: providerId,
            trashRoot,
            cacheMaxBytes: Math.max(0, cacheMb) * 1024 * 1024,
            retryCount,
            providers: { ...(status?.config.providers ?? {}), [providerId]: provider },
        }))
        if (next) {
            syncForm(next)
            message = 'Configuration saved.'
            notifySuccess('External asset configuration saved.')
        }
    }

    async function scan() {
        const job = await run('Starting a background character/module scan…', () => forageStorage.scanExternalAssetMigration(providerId))
        if (job) {
            migrationJob = job
            message = 'The scan is running in a background worker. Chat remains available.'
        }
    }

    async function migrate() {
        if (migrationJob && ['queued', 'paused', 'failed'].includes(migrationJob.status)) {
            const job = await run('Resuming external asset copies…', () => forageStorage.resumeExternalAssetMigration(migrationJob!.id))
            if (job) {
                migrationJob = job
                message = 'Copying resumed. Failed items alone will be retried.'
            }
            return
        }
        if (!await alertConfirm('Plan, copy, re-download verify, and preserve recoverable trash for character/module assets? Chat remains usable, and references are not changed until you explicitly finalize.')) return
        const result = await run('Starting resumable external asset migration…', () => forageStorage.migrateExternalAssets(providerId))
        if (result?.job) {
            migrationJob = result.job
            message = `Migration ${result.migrationId} started in the background.`
        }
    }

    async function pauseMigration() {
        if (!migrationJob) return
        const job = await run('Pausing after the current small batch…', () => forageStorage.pauseExternalAssetMigration(migrationJob!.id))
        if (job) migrationJob = job
    }

    async function cancelMigration() {
        if (!migrationJob) return
        if (!await alertConfirm('Cancel this unpublished migration? Existing Risu references and internal originals stay unchanged. Already verified external/trash copies may remain as safe orphans.')) return
        const job = await run('Canceling migration…', () => forageStorage.cancelExternalAssetMigration(migrationJob!.id))
        if (job) migrationJob = job
    }

    async function finalizeMigration() {
        if (!migrationJob || migrationJob.status !== 'staged') return
        if (!await alertConfirm('Atomically switch current character/module references to their verified external mappings? A safety DB snapshot and recoverable trash remain; permanent deletion is still a separate step.')) return
        const result = await run('Publishing external mappings and rewriting current references…', () => forageStorage.finalizeExternalAssetMigration(migrationJob!.id))
        if (result?.job) {
            migrationJob = result.job
            notifySuccess(`Published ${result.referencesRewritten ?? 0} references. Reloading the current database.`)
            setTimeout(() => location.reload(), 500)
        }
    }

    async function verify() {
        const result = await run('Re-downloading and verifying external assets…', () => forageStorage.verifyExternalAssets(migrationJob?.id))
        if (result) {
            message = result.ok ? 'All external assets passed hash and size verification.' : 'Some external assets failed verification.'
            if (result.ok) notifySuccess(message)
            await refresh()
        }
    }

    async function purge() {
        if (!await alertConfirm('Permanently delete verified external-asset trash copies? This cannot be undone and is blocked unless verification has succeeded.')) return
        const result = await run('Purging verified trash…', () => forageStorage.purgeExternalAssetTrash(migrationJob?.id))
        if (result) {
            message = `Purged ${result.removed ?? 0} verified trash files.`
            notifySuccess(message)
            await refresh()
        }
    }

    async function diagnoseAssets() {
        const job = await run('Starting a read-only asset diagnosis…', () => forageStorage.startAssetDiagnosis({
            sampleLimit: Math.max(0, Math.min(100, doctorSampleLimit)),
            maxSampleBytes: 16 * 1024 * 1024,
        }))
        if (job) {
            doctorJob = job
            message = 'Reference collection and stat/HEAD checks are running in the background. Chat remains available.'
        }
    }

    async function repairDiagnosedAssets() {
        if (!doctorJob?.result) return
        const repairable = doctorJob.result.issues.filter((issue) => issue.repairable)
        if (repairable.length === 0) {
            notifyError('No sampled issue has a safe automatic repair. Missing originals remain listed for manual recovery.')
            return
        }
        if (!await alertConfirm(`Repair ${repairable.length} sampled asset problem(s)? Cache entries are invalidated or exact-hash objects are restored from verified trash/internal fallbacks. No Risu references are changed and no original is deleted.`)) return
        const result = await run('Repairing selected exact-hash assets with a manifest backup and journal…', () => (
            forageStorage.repairAssetDiagnosis(doctorJob!.id, repairable.map((issue) => issue.id))
        ))
        if (result) {
            doctorJob = await forageStorage.getAssetDiagnosisJob(doctorJob.id)
            const repair = result.repair
            message = `Repair finished: ${repair.repaired} restored, ${repair.failed} failed. Run diagnosis again to verify current storage.`
            if (repair.failed === 0) notifySuccess(message)
        }
    }

    onMount(() => {
        void (async () => {
            await refresh()
            try {
                const jobs = await forageStorage.listExternalAssetMigrationJobs()
                migrationJob = jobs.find((job) => !terminalMigrationStatuses.has(job.status)) ?? jobs[0] ?? null
            } catch { /* status remains usable even if the journal is unavailable */ }
            try {
                const jobs = await forageStorage.listAssetDiagnosisJobs()
                doctorJob = jobs.find((job) => !['completed', 'failed'].includes(job.status)) ?? jobs[0] ?? null
            } catch { /* external storage controls remain usable */ }
        })()
        pollTimer = window.setInterval(() => {
            void refreshMigrationJob()
            void refreshDoctorJob()
        }, 1000)
        return () => {
            if (pollTimer !== null) window.clearInterval(pollTimer)
        }
    })
</script>

<section class="mt-6 rounded-md border border-darkborderc p-4 text-textcolor">
    <h3 class="font-semibold">External asset storage (PocketRisu core)</h3>
    <p class="mt-1 text-xs text-textcolor2">
        Character and module binaries can live outside Risu DB. Normal chat rendering receives only a lazy content URL; exports request original bytes on demand.
    </p>

    <label class="mt-4 flex items-center gap-2 text-sm">
        <input type="checkbox" bind:checked={enabled} /> Enable migration to external storage
    </label>

    <div class="mt-3 grid gap-2 md:grid-cols-2">
        <label class="text-xs text-textcolor2">Provider ID
            <TextInput className="mt-1 w-full" bind:value={providerId} />
        </label>
        <label class="text-xs text-textcolor2">Provider type
            <select class="mt-1 w-full rounded-md border border-darkborderc bg-bgcolor p-2 text-textcolor" bind:value={providerType}>
                <option value="filesystem">Filesystem / Termux-accessible folder</option>
                <option value="http">HTTP GET + PUT store</option>
                <option value="android-saf">Android SAF (bridge unavailable)</option>
            </select>
        </label>
    </div>

    {#if providerType === 'filesystem'}
        <label class="mt-3 block text-xs text-textcolor2">External folder path
            <TextInput className="mt-1 w-full" bind:value={filesystemRoot} placeholder="D:\PocketRisu-assets or /storage/emulated/0/PocketRisu-assets" />
        </label>
    {:else if providerType === 'http'}
        <label class="mt-3 block text-xs text-textcolor2">HTTP base URL
            <TextInput className="mt-1 w-full" bind:value={httpBaseUrl} placeholder="https://storage.example/assets" />
        </label>
        <label class="mt-3 block text-xs text-textcolor2">Request headers (JSON; stored server-side, blank keeps the saved value)
            <textarea class="mt-1 min-h-24 w-full rounded-md border border-darkborderc bg-transparent p-2 font-mono text-xs text-textcolor" bind:value={httpHeaders} placeholder={hasSavedHttpCredentials() ? 'Credentials are saved. Enter JSON only to replace them.' : '{\n  "Authorization": "Bearer …"\n}'}></textarea>
        </label>
        <label class="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={httpReadOnly} /> Read-only HTTP provider</label>
    {:else}
        <p class="mt-3 rounded-md border border-yellow-700 p-2 text-xs text-yellow-400">
            PocketRisu Android currently runs as a Termux Node server plus browser, so it has no native SAF document-provider bridge. Use a Termux-accessible shared folder for now.
        </p>
    {/if}

    <div class="mt-3 grid gap-2 md:grid-cols-2">
        <label class="text-xs text-textcolor2">Memory LRU limit (MB)
            <NumberInput className="mt-1 w-full" min={0} max={2048} bind:value={cacheMb} />
        </label>
        <label class="text-xs text-textcolor2">External request retries
            <NumberInput className="mt-1 w-full" min={0} max={10} bind:value={retryCount} />
        </label>
    </div>

    <div class="mt-4 flex flex-wrap gap-2">
        <Button onclick={saveConfig} disabled={loading}>Save provider</Button>
        <Button styled="outlined" onclick={scan} disabled={loading || !!migrationJob && ['planning', 'running', 'finalizing'].includes(migrationJob.status)}>Analyze</Button>
        <Button onclick={migrate} disabled={loading || !enabled || providerType === 'android-saf' || migrationJob?.status === 'planning' || migrationJob?.status === 'running' || migrationJob?.status === 'finalizing' || migrationJob?.status === 'staged'}>
            {migrationJob && ['queued', 'paused', 'failed'].includes(migrationJob.status) ? 'Resume copies' : 'Start migration'}
        </Button>
        {#if migrationJob?.status === 'running'}
            <Button styled="outlined" onclick={pauseMigration} disabled={loading}>Pause</Button>
        {/if}
        {#if migrationJob?.status === 'staged'}
            <Button onclick={finalizeMigration} disabled={loading}>Publish mappings</Button>
        {/if}
        {#if migrationJob && ['planning', 'queued', 'running', 'paused', 'failed'].includes(migrationJob.status)}
            <Button styled="danger" onclick={cancelMigration} disabled={loading}>Cancel</Button>
        {/if}
        <Button styled="outlined" onclick={verify} disabled={loading || migrationJob?.status !== 'published'}>Verify again</Button>
        <Button styled="danger" onclick={purge} disabled={loading || migrationJob?.status !== 'verified'}>Purge verified trash</Button>
    </div>

    {#if migrationJob}
        <div class="mt-3 rounded-md border border-darkborderc p-3 text-xs text-textcolor2">
            <div class="flex flex-wrap justify-between gap-2">
                <span>Migration {migrationJob.id}</span>
                <span class="font-semibold text-textcolor">{migrationJob.status}</span>
            </div>
            <div class="mt-2 h-2 overflow-hidden rounded bg-bgcolor">
                <div class="h-full bg-green-600 transition-[width] duration-300" style={`width: ${Math.max(0, Math.min(100, migrationJob.progress * 100))}%`}></div>
            </div>
            <p class="mt-2">
                {migrationJob.stagedItems.toLocaleString()} / {migrationJob.totalItems.toLocaleString()} assets ·
                {formatBytes(migrationJob.stagedBytes)} / {formatBytes(migrationJob.totalBytes)}
                {#if migrationJob.failedItems > 0} · failed {migrationJob.failedItems.toLocaleString()}{/if}
            </p>
            {#if migrationJob.planning?.phase}<p class="mt-1">Planning: {migrationJob.planning.phase}</p>{/if}
            {#if migrationJob.metadata?.missingCount}<p class="mt-1 text-yellow-400">Missing internal references skipped: {migrationJob.metadata.missingCount}</p>{/if}
            {#if migrationJob.error}<p class="mt-1 text-red-400">{migrationJob.error}</p>{/if}
            {#if migrationJob.status === 'staged'}
                <p class="mt-1 text-green-400">Every queued asset has an upload, re-download hash check, and recoverable trash copy. Publishing is still explicit.</p>
            {/if}
        </div>
    {/if}

    <label class="mt-3 block text-xs text-textcolor2">Recoverable migration trash path
        <TextInput className="mt-1 w-full" bind:value={trashRoot} placeholder="D:\PocketRisu-assets-trash or save/external-assets/trash" />
        <span class="mt-1 block">When a filesystem provider and trash share a volume, PocketRisu uses hard links so recovery copies consume almost no additional data space.</span>
    </label>

    {#if status}
        <p class="mt-3 text-xs text-textcolor2">
            Manifest: {status.manifest.count} assets / {(status.manifest.bytes / 1024 / 1024).toFixed(1)} MB ·
            verified {status.manifest.verified} · fallbacks {status.manifest.fallback} ·
            LRU {(status.cache.bytes / 1024 / 1024).toFixed(1)} / {(status.cache.maxBytes / 1024 / 1024).toFixed(1)} MB
        </p>
        {#if status.manifest.missingProviders?.length}
            <p class="mt-2 rounded-md border border-yellow-700 p-2 text-xs text-yellow-400">
                This manifest references unconfigured providers: {status.manifest.missingProviders.join(', ')}. Configure the same provider IDs after moving to another computer.
            </p>
        {/if}
    {/if}

    <div class="mt-4 rounded-md border border-darkborderc p-3">
        <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
                <h4 class="text-sm font-semibold">Asset diagnosis and safe recovery</h4>
                <p class="mt-1 max-w-3xl text-xs text-textcolor2">
                    Read-only by default. Every character, module, persona and embedded chat/text asset reference receives a size/availability check. Only a bounded sample is downloaded sequentially for SHA-256 and real image decoding, so a 45 GB library is never loaded into memory at once.
                </p>
            </div>
            <label class="w-32 text-xs text-textcolor2">Hash/decode samples
                <NumberInput className="mt-1 w-full" min={0} max={100} bind:value={doctorSampleLimit} />
            </label>
        </div>

        <div class="mt-3 flex flex-wrap gap-2">
            <Button
                styled="outlined"
                onclick={diagnoseAssets}
                disabled={loading || !!doctorJob && ['queued', 'running'].includes(doctorJob.status) || !!migrationJob && ['planning', 'running', 'finalizing'].includes(migrationJob.status)}
            >Run read-only diagnosis</Button>
            {#if doctorJob?.status === 'completed' && doctorJob.result?.issues.some((issue) => issue.repairable)}
                <Button onclick={repairDiagnosedAssets} disabled={loading}>Repair safe sampled issues</Button>
            {/if}
        </div>

        {#if doctorJob}
            <div class="mt-3 rounded-md bg-bgcolor p-3 text-xs text-textcolor2">
                <div class="flex flex-wrap justify-between gap-2">
                    <span>Diagnosis {doctorJob.id}</span>
                    <span class="font-semibold text-textcolor">{doctorJob.status}</span>
                </div>
                {#if ['queued', 'running'].includes(doctorJob.status)}
                    <div class="mt-2 h-2 overflow-hidden rounded bg-darkborderc">
                        <div
                            class="h-full bg-green-600 transition-[width] duration-300"
                            style={`width: ${doctorJob.progress.total > 0 ? Math.max(2, Math.min(100, doctorJob.progress.current / doctorJob.progress.total * 100)) : 2}%`}
                        ></div>
                    </div>
                    <p class="mt-2">{doctorJob.progress.phase}: {doctorJob.progress.current.toLocaleString()} / {doctorJob.progress.total.toLocaleString()}</p>
                {/if}
                {#if doctorJob.error}<p class="mt-2 text-red-400">{doctorJob.error}</p>{/if}
                {#if doctorJob.result}
                    {@const summary = doctorJob.result.summary}
                    <p class="mt-2 text-textcolor">
                        {summary.references.toLocaleString()} references · {summary.uniqueAssets.toLocaleString()} unique ·
                        {summary.healthy.toLocaleString()} healthy · {summary.problems.toLocaleString()} problem records
                    </p>
                    <p class="mt-1">
                        Missing {summary.missing.toLocaleString()} · provider/size {summary.providerProblems.toLocaleString()} · integrity/hash {summary.integrityProblems.toLocaleString()} ·
                        malformed external {summary.invalidExternalAssets.toLocaleString()} · cache {summary.cacheProblems.toLocaleString()} · decodes failed {summary.decodeFailures.toLocaleString()} ·
                        verified sample hashes {summary.hashVerifiedSamples.toLocaleString()}
                    </p>
                    <p class="mt-1">{doctorJob.result.samplePolicy.note}</p>

                    {#if doctorJob.result.issues.length > 0}
                        <div class="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                            {#each doctorJob.result.issues as issue (issue.id)}
                                <div class="rounded border border-darkborderc p-2">
                                    <div class="flex flex-wrap justify-between gap-2">
                                        <span class={issue.repairable ? 'text-yellow-300' : 'text-red-400'}>{issue.code}</span>
                                        <span>{issue.occurrences.toLocaleString()} reference(s)</span>
                                    </div>
                                    <p class="mt-1 break-all font-mono text-[11px] text-textcolor">{issue.reference}</p>
                                    <p class="mt-1">{issue.message}</p>
                                    {#if issue.fallbackAvailable}
                                        <p class="mt-1 text-green-400">Verified-size fallback candidate: {issue.fallbackSource}{issue.repairable ? ' · safe repair available' : ' · used for serving only'}</p>
                                    {/if}
                                    {#if issue.error?.message}<p class="mt-1 text-red-400">{issue.error.message}</p>{/if}
                                </div>
                            {/each}
                        </div>
                        {#if doctorJob.result.issuesTruncated > 0}
                            <p class="mt-2 text-yellow-400">{doctorJob.result.issuesTruncated.toLocaleString()} additional issues are omitted from this screen. Repair remains limited to the displayed, explicitly confirmed sample.</p>
                        {/if}
                    {/if}
                    {#if doctorJob.repair}
                        <p class="mt-2 text-green-400">
                            Last repair: {doctorJob.repair.repaired} restored, {doctorJob.repair.failed} failed · manifest backup {doctorJob.repair.manifestBackupKey ?? 'not required'}
                        </p>
                    {/if}
                {/if}
            </div>
        {/if}
    </div>
    {#if message}<p class="mt-2 text-xs text-textcolor2">{message}</p>{/if}
</section>
