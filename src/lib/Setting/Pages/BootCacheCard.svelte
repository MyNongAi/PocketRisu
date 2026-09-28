<script lang="ts">
    // Delta boot segment cache of this device (src/ts/storage/bootPayloadCache.ts):
    // what it holds, how the last start went, and a button to clear it.
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import { DatabaseZapIcon } from '@lucide/svelte'
    import { notifyError, notifySuccess } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { language } from 'src/lang'
    import type { BootCacheStatus } from 'src/ts/storage/bootPayloadCache'

    let status = $state<BootCacheStatus | null>(null)
    let clearing = $state(false)
    const lastLoad = forageStorage.realStorage?.lastDbLoad ?? null

    const statusLine = $derived.by(() => {
        if (!status) return ''
        if (status.suspended) return language.storageBootCacheSuspended(status.suspended)
        if (status.userDisabled) return language.storageBootCacheOff
        if (!status.supported) return language.storageBootCacheUnsupported
        if (!status.segments || !status.cachedBytes) return language.storageBootCacheEmpty
        return language.storageBootCacheSize(status.cachedBytes, status.segments)
    })
    const lastLoadLine = $derived(
        !lastLoad ? ''
            : lastLoad.mode === 'boot' ? language.storageBootCacheLastDelta(lastLoad.received, lastLoad.total)
                : language.storageBootCacheLastFull(lastLoad.total)
    )

    async function refresh() {
        try {
            status = await forageStorage.realStorage.bootCache.status()
        } catch {
            status = null
        }
    }

    async function clearCache() {
        clearing = true
        try {
            await forageStorage.realStorage.clearBootCache()
            notifySuccess(language.storageBootCacheCleared)
            await refresh()
        } catch (err) {
            notifyError(language.storageBootCacheClearFailed + ': ' + (err instanceof Error ? err.message : String(err)))
        } finally {
            clearing = false
        }
    }

    $effect(() => { refresh() })
</script>

<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
        <div class="flex items-center gap-2 text-textcolor">
            <DatabaseZapIcon size={16} />
            <span class="font-medium">{language.storageBootCache}</span>
        </div>
        <span class="text-textcolor2 text-sm tabular-nums">{statusLine}</span>
    </div>
    <p class="text-textcolor2 text-xs leading-relaxed mb-2">{language.storageBootCacheDesc}</p>
    {#if lastLoadLine}
        <p class="text-textcolor2 text-sm tabular-nums mb-1">{lastLoadLine}</p>
    {/if}
    {#if status?.etag}
        <p class="text-textcolor2 text-xs font-mono truncate opacity-70 mb-1">etag {status.etag}</p>
    {/if}
    <div class="flex justify-end mt-2">
        <ShButton variant="outline" onclick={clearCache} disabled={clearing || !status || (!status.segments && !status.cachedBytes)}>
            <DatabaseZapIcon size={16} />
            {language.storageBootCacheClear}
        </ShButton>
    </div>
</div>
