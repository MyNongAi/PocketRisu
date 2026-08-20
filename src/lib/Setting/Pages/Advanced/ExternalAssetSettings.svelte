<script lang="ts">
    import { onMount } from 'svelte'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import type { ExternalAssetStatus } from 'src/ts/storage/nodeStorage'

    let status: ExternalAssetStatus | null = $state(null)
    let loading = $state(false)
    let message = $state('')
    let enabled = $state(true)
    let providerId = $state('local')
    let providerType: 'filesystem'|'http'|'android-saf' = $state('filesystem')
    let filesystemRoot = $state('')
    let httpBaseUrl = $state('')
    let httpHeaders = $state('')
    let httpReadOnly = $state(false)
    let cacheMb = $state(64)
    let retryCount = $state(2)

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
        const result = await run('Scanning character and module references…', () => forageStorage.scanExternalAssetMigration())
        if (result) {
            message = `${result.uniqueAssets} unique assets / ${(result.bytes / 1024 / 1024).toFixed(1)} MB; ${result.missing.length} missing.`
        }
    }

    async function migrate() {
        if (!await alertConfirm('Copy and verify character/module assets in the configured external store, then move internal originals to recoverable trash? References are changed only after every staging step succeeds.')) return
        const result = await run('Migrating and verifying external assets…', () => forageStorage.migrateExternalAssets(providerId))
        if (result) {
            message = `Migration ${result.migrationId}: ${result.migrated ?? 0} assets, ${result.bytes ?? 0} bytes.`
            notifySuccess('External asset migration completed. Reloading the updated database; originals remain in recoverable trash.')
            // The server has atomically published rewritten references. Reload
            // so the in-memory client cannot keep writing the pre-migration DB.
            setTimeout(() => location.reload(), 500)
        }
    }

    async function verify() {
        const result = await run('Re-downloading and verifying external assets…', () => forageStorage.verifyExternalAssets())
        if (result) {
            message = result.ok ? 'All external assets passed hash and size verification.' : 'Some external assets failed verification.'
            if (result.ok) notifySuccess(message)
            await refresh()
        }
    }

    async function purge() {
        if (!await alertConfirm('Permanently delete verified external-asset trash copies? This cannot be undone and is blocked unless verification has succeeded.')) return
        const result = await run('Purging verified trash…', () => forageStorage.purgeExternalAssetTrash())
        if (result) {
            message = `Purged ${result.removed ?? 0} verified trash files.`
            notifySuccess(message)
            await refresh()
        }
    }

    onMount(() => { void refresh() })
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
        <Button styled="outlined" onclick={scan} disabled={loading}>Scan</Button>
        <Button onclick={migrate} disabled={loading || !enabled || providerType === 'android-saf'}>Migrate safely</Button>
        <Button styled="outlined" onclick={verify} disabled={loading}>Verify again</Button>
        <Button styled="danger" onclick={purge} disabled={loading}>Purge verified trash</Button>
    </div>

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
    {#if message}<p class="mt-2 text-xs text-textcolor2">{message}</p>{/if}
</section>
