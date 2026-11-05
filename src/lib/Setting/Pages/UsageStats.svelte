<script lang="ts">
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShBadge from 'src/lib/UI/GUI/ShBadge.svelte'
    import ShToggle from 'src/lib/UI/GUI/ShToggle.svelte'
    import { Collapsible } from 'bits-ui'
    import { ChevronDownIcon, FilterIcon, RefreshCwIcon, Trash2Icon, ChartColumnIcon } from '@lucide/svelte'
    import { alertConfirm, notifyError } from 'src/ts/alert'
    import { DBState } from 'src/ts/stores.svelte'
    import { bucketCost, costSummary, defaultCostSettings, type ModelRates } from 'src/ts/apiCost'
    import { language } from 'src/lang'
    import {
        fetchUsage, clearRequestLogs,
        type UsageReport, type RequestLogSource,
    } from 'src/ts/requestLog'

    const sourceLabel: Record<string, string> = {
        main: language.requestLogsSourceMain,
        translate: language.requestLogsSourceTranslate,
        memory: language.requestLogsSourceMemory,
        emotion: language.requestLogsSourceEmotion,
        sub: language.requestLogsSourceSub,
        preview: language.requestLogsSourcePreview,
        test: language.requestLogsSourceTest,
        tts: language.requestLogsSourceTts,
        image: language.requestLogsSourceImage,
        plugin: language.requestLogsSourcePlugin,
        other: language.requestLogsSourceOther,
    }

    const PERIODS = [
        { key: '7d', label: language.usagePeriod7d, days: 7 },
        { key: '30d', label: language.usagePeriod30d, days: 30 },
        { key: '90d', label: language.usagePeriod90d, days: 90 },
        { key: 'all', label: language.usagePeriodAll, days: 0 },
    ] as const

    let report = $state<UsageReport | null>(null)
    let costReport = $state<UsageReport | null>(null)
    let adjustmentDay = $state('')
    let adjustmentAmount = $state('')
    const settings = $derived(DBState.db.nodeOnlyCostSettings ?? defaultCostSettings())
    const today = $derived(new Date().toLocaleDateString('en-CA'))
    const cost = $derived(costReport ? costSummary(costReport.byModelDay, settings, today) : null)
    const models = $derived(costReport?.dimensions.models ?? [])

    function updateSettings(patch: Partial<typeof settings>) {
        // A new budget or start date warns again from the first step.
        const reset = 'budgetUsd' in patch || 'startDay' in patch ? { notifiedWarnings: [] } : {}
        DBState.db.nodeOnlyCostSettings = { ...settings, ...patch, ...reset }
    }
    function updateRate(model: string, field: keyof ModelRates, raw: string) {
        const value = raw.trim() === '' ? undefined : Number(raw)
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) return
        const next = { ...settings.rates[model], [field]: value }
        updateSettings({ rates: { ...settings.rates, [model]: next } })
    }
    function addAdjustment() {
        const amountUsd = Number(adjustmentAmount)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(adjustmentDay) || !adjustmentAmount.trim() || !Number.isFinite(amountUsd) || amountUsd < 0) return
        updateSettings({ adjustments: [...settings.adjustments.filter(a => a.day !== adjustmentDay), { day: adjustmentDay, amountUsd }] })
        adjustmentAmount = ''
    }
    let loading = $state(false)
    let loadError = $state<string | null>(null)

    let period = $state<'7d' | '30d' | '90d' | 'all'>('7d')
    let selectedSources = $state<Set<RequestLogSource>>(new Set())
    let filtersOpen = $state(false)

    function toggleSet<T>(set: Set<T>, key: T): Set<T> {
        const next = new Set(set)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    }

    const activeFilterCount = $derived(selectedSources.size > 0 ? 1 : 0)

    const since = $derived.by(() => {
        const days = PERIODS.find(p => p.key === period)?.days ?? 0
        if (!days) return undefined
        // Start of the calendar day N-1 days back, so a "7 days" window shows
        // seven whole day columns rather than a rolling 168-hour slice.
        const d = new Date()
        d.setHours(0, 0, 0, 0)
        d.setDate(d.getDate() - (days - 1))
        return d.getTime()
    })

    // Category is fixed: only LLM rows reach the usage table.
    const query = $derived({
        sources: Array.from(selectedSources),
        since,
    })

    let fetchGen = 0

    async function load() {
        const q = query
        const gen = ++fetchGen
        loading = true
        loadError = null
        try {
            const [data, all] = await Promise.all([fetchUsage(q), fetchUsage({ categories: ['llm'] })])
            if (gen !== fetchGen) return
            if (!data) throw new Error('request failed')
            report = data
            costReport = all
        } catch (err) {
            if (gen !== fetchGen) return
            loadError = err instanceof Error ? err.message : String(err)
        } finally {
            if (gen === fetchGen) loading = false
        }
    }

    async function handleClearUsage() {
        if (!await alertConfirm(language.usageClearConfirm)) return
        const ok = await clearRequestLogs(true)
        if (!ok) {
            notifyError(language.usageFailedLoad, { source: 'usage-page' })
            return
        }
        await load()
    }

    // ─── Chart ──────────────────────────────────────────────────────────────
    // Hand-rolled SVG rather than a chart library: a stacked bar plus a line is
    // a few lines of geometry, and the bundle stays as-is.
    const CHART_H = 180
    const BAR_MAX_W = 36

    // Fill in days with no traffic so the x-axis reads as a continuous calendar
    // instead of collapsing gaps.
    const chartDays = $derived.by(() => {
        if (!report) return []
        const buckets = new Map(report.daily.map(d => [d.day, d]))
        if (!since) {
            return report.daily.map(d => ({
                day: d.day,
                input: Math.max(d.inputTokens - d.cachedTokens, 0),
                cached: d.cachedTokens,
                output: d.outputTokens,
                requests: d.requests,
            }))
        }
        const out: { day: string, input: number, cached: number, output: number, requests: number }[] = []
        const cursor = new Date(since)
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        while (cursor.getTime() <= today.getTime()) {
            const pad = (n: number) => String(n).padStart(2, '0')
            const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`
            const bucket = buckets.get(key)
            out.push({
                day: key,
                // Cached prompt tokens are a subset of the reported input count,
                // so they are drawn as their own segment rather than added on top.
                input: bucket ? Math.max(bucket.inputTokens - bucket.cachedTokens, 0) : 0,
                cached: bucket?.cachedTokens ?? 0,
                output: bucket?.outputTokens ?? 0,
                requests: bucket?.requests ?? 0,
            })
            cursor.setDate(cursor.getDate() + 1)
        }
        return out
    })

    const chartMax = $derived(
        Math.max(1, ...chartDays.map(d => d.input + d.cached + d.output)),
    )

    function barHeight(value: number): number {
        return (value / chartMax) * CHART_H
    }

    function dayTick(day: string): string {
        const [, m, d] = day.split('-')
        return `${Number(m)}/${Number(d)}`
    }

    function formatTokens(n: number): string {
        return n.toLocaleString()
    }

    function formatDuration(ms: number | null): string {
        if (ms === null) return '—'
        return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`
    }

    $effect(() => {
        void query
        load()
    })
</script>

<p class="text-textcolor2 text-sm mb-4">{language.usageDesc}</p>

<div class="flex flex-col gap-3 mb-4">
    <div class="flex gap-2 items-stretch flex-wrap">
        <div class="flex flex-wrap gap-1 flex-1">
            <!-- ShButton, not ShToggle: the period is single-select, and
                 ShToggle's `pressed` is $bindable — re-clicking the active chip
                 un-presses it internally while the parent re-assigns the same
                 value, so the prop never changes and the selection would render
                 as cleared. A variant swap has no internal state to desync. -->
            {#each PERIODS as p (p.key)}
                <ShButton
                    size="xs"
                    variant={period === p.key ? 'default' : 'outline'}
                    onclick={() => period = p.key}
                >
                    {p.label}
                </ShButton>
            {/each}
        </div>
        <ShButton variant="outline" size="default" onclick={load}>
            <RefreshCwIcon size={16} />
            <span class="hidden sm:inline">{language.requestLogsRefresh}</span>
        </ShButton>
        <ShButton variant="destructive" size="default" onclick={handleClearUsage}>
            <Trash2Icon size={16} />
            <span class="hidden sm:inline">{language.usageClearAll}</span>
        </ShButton>
    </div>

    <Collapsible.Root bind:open={filtersOpen}>
        <Collapsible.Trigger class="flex items-center gap-1 text-textcolor2 hover:text-textcolor text-sm transition-colors group">
            <FilterIcon size={14} />
            <span>{language.requestLogsFilters}</span>
            {#if activeFilterCount > 0}
                <ShBadge variant="secondary" className="ml-1">{language.requestLogsFilterActive(activeFilterCount)}</ShBadge>
            {/if}
            <ChevronDownIcon size={14} class="transition-transform group-data-[state=closed]:-rotate-90" />
        </Collapsible.Trigger>
        <Collapsible.Content>
            <div class="flex flex-col gap-2 py-3 border-b border-darkborderc/50">
                {#if report && report.dimensions.sources.length > 0}
                    <div class="flex items-start gap-2">
                        <span class="text-textcolor2 text-xs shrink-0 w-16 pt-1">{language.requestLogsFilterSource}</span>
                        <div class="flex flex-wrap gap-1">
                            {#each report.dimensions.sources as src (src)}
                                <ShToggle size="xs" pressed={selectedSources.has(src as RequestLogSource)}
                                    onPressedChange={() => selectedSources = toggleSet(selectedSources, src as RequestLogSource)}>
                                    {sourceLabel[src] ?? src}
                                </ShToggle>
                            {/each}
                        </div>
                    </div>
                {/if}
            </div>
        </Collapsible.Content>
    </Collapsible.Root>
</div>

<section class="border border-darkborderc rounded-md bg-darkbg/30 p-3 mb-4 text-textcolor text-sm min-w-0">
    <h3 class="font-semibold mb-1">{language.apiCostTitle}</h3>
    <p class="text-textcolor2 text-xs mb-3">{language.apiCostEstimateNote}</p>
    <div class="grid grid-cols-2 gap-2 mb-3">
        <label class="min-w-0">{language.apiCostBudgetUsd}<input class="w-full min-w-0 bg-darkbg border border-darkborderc rounded p-1" type="number" min="0" step="any" value={settings.budgetUsd ?? ''} onchange={(e) => updateSettings({ budgetUsd: e.currentTarget.value ? Number(e.currentTarget.value) : undefined })} /></label>
        <label class="min-w-0">{language.apiCostStartDay}<input class="w-full min-w-0 bg-darkbg border border-darkborderc rounded p-1" type="date" value={settings.startDay ?? ''} onchange={(e) => updateSettings({ startDay: e.currentTarget.value || undefined })} /></label>
    </div>
    {#if cost}
        <div class="grid grid-cols-2 gap-2 mb-2 tabular-nums">
            <div>{language.apiCostSpent}: ${cost.spent.toFixed(4)}</div>
            <div>{language.apiCostRemaining}: {cost.remaining === null ? '—' : `$${cost.remaining.toFixed(4)}`}</div>
            <div>{language.apiCostPercent}: {cost.percent === null ? '—' : `${cost.percent.toFixed(1)}%`}</div>
            <div>{language.apiCostDailyAverage}: ${cost.dailyAverage.toFixed(4)}</div>
            <div class="col-span-2">{language.apiCostDepletionDay}: {cost.depletionDay ?? '—'}</div>
        </div>
        {#if cost.unpriced > 0}<p class="text-textcolor2">{language.apiCostUnpriced}: {cost.unpriced}</p>{/if}
        {#if cost.missingTokens > 0}<p class="text-textcolor2">{language.apiCostMissingTokens}: {cost.missingTokens}</p>{/if}
    {/if}
    <div class="grid grid-cols-2 gap-2 my-3">
        <label class="min-w-0">{language.apiCostWarnings}<input class="w-full min-w-0 bg-darkbg border border-darkborderc rounded p-1" value={settings.warnings.join(', ')} onchange={(e) => updateSettings({ warnings: e.currentTarget.value.split(',').map(Number).filter(n => Number.isFinite(n) && n > 0 && n < 100) })} /></label>
        <label class="flex items-center gap-2"><input type="checkbox" checked={settings.hardStop} onchange={(e) => updateSettings({ hardStop: e.currentTarget.checked })} />{language.apiCostHardStop}</label>
    </div>
    <div class="mb-3">
        <div class="font-semibold mb-1">{language.apiCostAdjustment}</div>
        <div class="flex flex-wrap gap-2 items-end">
            <label>{language.apiCostAdjustmentDay}<input class="block bg-darkbg border border-darkborderc rounded p-1" type="date" bind:value={adjustmentDay} /></label>
            <label>{language.apiCostActualUsd}<input class="block w-28 bg-darkbg border border-darkborderc rounded p-1" type="text" inputmode="decimal" bind:value={adjustmentAmount} /></label>
            <button class="border border-darkborderc rounded p-1" onclick={addAdjustment}>{language.apiCostAdd}</button>
        </div>
        {#each settings.adjustments as adjustment (adjustment.day)}
            <div class="flex gap-2 items-center mt-1"><span>{adjustment.day}: ${adjustment.amountUsd.toFixed(4)}</span><button class="underline" onclick={() => updateSettings({ adjustments: settings.adjustments.filter(a => a.day !== adjustment.day) })}>{language.apiCostRemove}</button></div>
        {/each}
    </div>
    <div class="font-semibold mb-1">{language.apiCostRates}</div>
    <p class="text-textcolor2 text-xs mb-2">{language.apiCostRatesUnit}</p>
    {#each models as model (model)}
        {@const modelRows = costReport?.byModelDay.filter(row => row.model === model) ?? []}
        {@const modelCost = modelRows.reduce((sum, row) => sum + (bucketCost(row, settings.rates).amount ?? 0), 0)}
        {@const modelUnpriced = modelRows.some(row => bucketCost(row, settings.rates).unpriced)}
        {@const modelMissing = modelRows.reduce((sum, row) => sum + row.missingTokenRequests, 0)}
        <div class="border-t border-darkborderc py-2 min-w-0">
            <div class="font-mono break-all">{model} · {modelUnpriced ? language.apiCostNoRate : modelMissing === modelRows.reduce((n, r) => n + r.requests, 0) ? '—' : `$${modelCost.toFixed(4)}`}</div>
            <div class="text-xs text-textcolor2 mb-1">{language.usageInputTokens}: {formatTokens(modelRows.reduce((n, r) => n + r.inputTokens, 0))} · {language.usageOutputTokens}: {formatTokens(modelRows.reduce((n, r) => n + r.outputTokens, 0))}</div>
            {#if modelMissing > 0}<div class="text-xs text-textcolor2">{language.apiCostMissingTokens}: {modelMissing}</div>{/if}
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {#each [['input', language.usageInputTokens], ['output', language.usageOutputTokens], ['cachedInput', language.usageCachedTokens], ['reasoning', language.apiCostReasoning], ['longInput', language.apiCostLongInput], ['longOutput', language.apiCostLongOutput], ['longCachedInput', language.apiCostLongCached], ['longReasoning', language.apiCostLongReasoning]] as field}
                    <label class="min-w-0 text-xs">{field[1]}<input class="w-full min-w-0 bg-darkbg border border-darkborderc rounded p-1" type="number" min="0" step="any" value={settings.rates[model]?.[field[0] as keyof ModelRates] ?? ''} onchange={(e) => updateRate(model, field[0] as keyof ModelRates, e.currentTarget.value)} /></label>
                {/each}
            </div>
        </div>
    {/each}
</section>

{#if loading && !report}
    <div class="text-textcolor2 text-sm py-8 text-center">{language.usageLoading}</div>
{:else if loadError}
    <div class="text-draculared text-sm py-8 text-center">{language.usageFailedLoad}: {loadError}</div>
{:else if report && report.total.requests === 0}
    <div class="flex flex-col items-center justify-center text-center py-16 border border-darkborderc rounded-md bg-darkbg/30">
        <ChartColumnIcon size={48} class="text-textcolor2 mb-3 opacity-50" />
        <div class="text-textcolor font-medium mb-1">{language.usageEmpty}</div>
        <div class="text-textcolor2 text-sm">{language.usageEmptyDesc}</div>
    </div>
{:else if report}
    <!-- Summary cards -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div class="border border-darkborderc rounded-md bg-darkbg/30 p-3">
            <div class="text-textcolor2 text-xs mb-1">{language.usageRequests}</div>
            <div class="text-textcolor text-2xl font-semibold tabular-nums">{formatTokens(report.total.requests)}</div>
            {#if report.total.failed > 0}
                <div class="text-draculared text-xs mt-1">{language.usageFailed} {report.total.failed}</div>
            {/if}
        </div>
        <div class="border border-darkborderc rounded-md bg-darkbg/30 p-3">
            <div class="text-textcolor2 text-xs mb-1">{language.usageInputTokens}</div>
            <div class="text-textcolor text-2xl font-semibold tabular-nums">{formatTokens(report.total.inputTokens)}</div>
        </div>
        <div class="border border-darkborderc rounded-md bg-darkbg/30 p-3">
            <div class="text-textcolor2 text-xs mb-1">{language.usageOutputTokens}</div>
            <div class="text-textcolor text-2xl font-semibold tabular-nums">{formatTokens(report.total.outputTokens)}</div>
        </div>
        <div class="border border-darkborderc rounded-md bg-darkbg/30 p-3">
            <div class="text-textcolor2 text-xs mb-1">{language.usageCachedTokens}</div>
            <div class="text-textcolor text-2xl font-semibold tabular-nums">{formatTokens(report.total.cachedTokens)}</div>
        </div>
    </div>

    <!-- Daily stacked bars -->
    {#if chartDays.length > 0}
        <div class="border border-darkborderc rounded-md bg-darkbg/30 p-4 mb-4">
            <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
                <span class="text-textcolor text-sm font-semibold">{language.usageChartTitle}</span>
                <div class="flex items-center gap-3 text-xs text-textcolor2">
                    <span class="flex items-center gap-1">
                        <span class="w-2 h-2 rounded-full inline-block bg-[oklch(0.63_0.19_295)]"></span>{language.usageInputTokens}
                    </span>
                    <span class="flex items-center gap-1">
                        <span class="w-2 h-2 rounded-full inline-block bg-[oklch(0.66_0.13_265)]"></span>{language.usageCachedTokens}
                    </span>
                    <span class="flex items-center gap-1">
                        <span class="w-2 h-2 rounded-full inline-block bg-[oklch(0.80_0.15_85)]"></span>{language.usageOutputTokens}
                    </span>
                </div>
            </div>
            <div class="overflow-x-auto">
                <div class="flex items-end gap-2 min-w-fit" style:height="{CHART_H + 24}px">
                    {#each chartDays as d (d.day)}
                        {@const total = d.input + d.cached + d.output}
                        <div class="flex flex-col items-center justify-end gap-1 flex-1" style:min-width="28px" style:max-width="{BAR_MAX_W}px">
                            <div
                                class="w-full flex flex-col justify-end rounded-sm overflow-hidden"
                                style:height="{CHART_H}px"
                                title="{d.day} · {language.usageRequests} {d.requests} · {formatTokens(total)}"
                            >
                                <div class="w-full bg-[oklch(0.80_0.15_85)]" style:height="{barHeight(d.output)}px"></div>
                                <div class="w-full bg-[oklch(0.66_0.13_265)]" style:height="{barHeight(d.cached)}px"></div>
                                <div class="w-full bg-[oklch(0.63_0.19_295)]" style:height="{barHeight(d.input)}px"></div>
                            </div>
                            <span class="text-textcolor2 text-[10px] tabular-nums">{dayTick(d.day)}</span>
                        </div>
                    {/each}
                </div>
            </div>
        </div>
    {/if}

    <!-- Per-model breakdown -->
    {#if report.byModel.length > 0}
        <div class="border border-darkborderc rounded-md bg-darkbg/30 mb-4 overflow-hidden">
            <div class="px-3 py-2 border-b border-darkborderc/50 text-textcolor text-sm font-semibold">
                {language.usageByModel}
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-xs">
                    <thead class="text-textcolor2">
                        <tr class="border-b border-darkborderc/50">
                            <th class="text-left font-normal px-3 py-2">{language.usageModel}</th>
                            <th class="text-right font-normal px-3 py-2">{language.usageRequests}</th>
                            <th class="text-right font-normal px-3 py-2">{language.usageInputTokens}</th>
                            <th class="text-right font-normal px-3 py-2">{language.usageOutputTokens}</th>
                            <th class="text-right font-normal px-3 py-2 hidden sm:table-cell">{language.usageCachedTokens}</th>
                            <th class="text-right font-normal px-3 py-2 hidden md:table-cell">{language.usageAvgDuration}</th>
                        </tr>
                    </thead>
                    <tbody class="text-textcolor">
                        {#each report.byModel as row (`${row.model}-${row.provider}`)}
                            <tr class="border-b border-darkborderc/30 last:border-0">
                                <td class="px-3 py-2 font-mono">
                                    {row.model ?? '—'}
                                    {#if row.provider}
                                        <span class="text-textcolor2 ml-1">({row.provider})</span>
                                    {/if}
                                </td>
                                <td class="px-3 py-2 text-right tabular-nums">{formatTokens(row.requests)}</td>
                                <td class="px-3 py-2 text-right tabular-nums">{formatTokens(row.inputTokens)}</td>
                                <td class="px-3 py-2 text-right tabular-nums">{formatTokens(row.outputTokens)}</td>
                                <td class="px-3 py-2 text-right tabular-nums hidden sm:table-cell">{formatTokens(row.cachedTokens)}</td>
                                <td class="px-3 py-2 text-right tabular-nums hidden md:table-cell">{formatDuration(row.avgDurationMs)}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        </div>
    {/if}

    <!-- Per-source breakdown -->
    {#if report.bySource.length > 1}
        <div class="border border-darkborderc rounded-md bg-darkbg/30 overflow-hidden">
            <div class="px-3 py-2 border-b border-darkborderc/50 text-textcolor text-sm font-semibold">
                {language.usageBySource}
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-xs">
                    <thead class="text-textcolor2">
                        <tr class="border-b border-darkborderc/50">
                            <th class="text-left font-normal px-3 py-2">{language.requestLogsFilterSource}</th>
                            <th class="text-right font-normal px-3 py-2">{language.usageRequests}</th>
                            <th class="text-right font-normal px-3 py-2">{language.usageInputTokens}</th>
                            <th class="text-right font-normal px-3 py-2">{language.usageOutputTokens}</th>
                        </tr>
                    </thead>
                    <tbody class="text-textcolor">
                        {#each report.bySource as row (row.source)}
                            <tr class="border-b border-darkborderc/30 last:border-0">
                                <td class="px-3 py-2">{sourceLabel[row.source] ?? row.source}</td>
                                <td class="px-3 py-2 text-right tabular-nums">{formatTokens(row.requests)}</td>
                                <td class="px-3 py-2 text-right tabular-nums">{formatTokens(row.inputTokens)}</td>
                                <td class="px-3 py-2 text-right tabular-nums">{formatTokens(row.outputTokens)}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        </div>
    {/if}
{/if}
