// The sidebar's reload button on the laptop server. The laptop's remote switch
// (server/node/laptop-switch.cjs) runs the launcher: pull and build with the
// server left running, and restart it only when its own code changed (since
// 2026-10-20; before, it stopped for the whole run) — the same run as the
// desktop's PocketRisu button. Meanwhile this page shows the laptop's progress
// lines, and once the run is over and the server answers it reloads into
// whatever the laptop now serves. With no switch (any other install) the
// button just reloads.

import { forageStorage } from './globalApi.svelte'

export type LaptopRestartPhase = 'idle' | 'running' | 'warned' | 'failed'

class LaptopRestartState {
    phase = $state<LaptopRestartPhase>('idle')
    /** The launcher's timestamped lines, as the laptop's own window shows them. */
    lines = $state<string[]>([])
    warnings = $state<string[]>([])
    startedAt = $state(0)
}

export const laptopRestart = new LaptopRestartState()

const POLL_MS = 1000
const GIVE_UP_MS = 15 * 60_000
const LOG_LINE = /^\d{2}:\d{2}:\d{2} /

export interface LaptopRestartDeps {
    fetch: typeof fetch
    now: () => number
    sleep: (ms: number) => Promise<void>
    reload: () => void
}

const defaultDeps = (): LaptopRestartDeps => ({
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    reload: () => location.reload(),
})

/** Where to read the launcher's progress, or null when this server has no switch. */
async function askForRestart(deps: LaptopRestartDeps): Promise<string | null> {
    try {
        const auth = await forageStorage.createAuth()
        const res = await deps.fetch('/api/laptop/restart', { method: 'POST', headers: { 'risu-auth': auth } })
        if (res.status !== 202) return null
        const body = await res.json()
        return typeof body?.log === 'string' ? body.log : null
    } catch {
        return null
    }
}

/** The build the server serves ('' when it has none), or null when it does not answer. */
async function servedBuild(deps: LaptopRestartDeps): Promise<string | null> {
    try {
        const res = await deps.fetch('/build-id.txt', { cache: 'no-store' })
        if (!res.ok) return null
        return (await res.text()).trim()
    } catch {
        return null
    }
}

/**
 * Follow the launcher run until the server is back. The switch's log says
 * when the run ends; when the page cannot read it, the server going down and
 * answering again, or serving another build, marks the end instead.
 */
export async function watchLaptopRestart(logBase: string, deps: LaptopRestartDeps = defaultDeps()): Promise<void> {
    laptopRestart.phase = 'running'
    laptopRestart.lines = []
    laptopRestart.warnings = []
    laptopRestart.startedAt = deps.now()
    let from = 0
    let sawRunning = false
    let sawDown = false
    let firstBuild: string | null = null
    let sawNewBuild = false
    while (deps.now() - laptopRestart.startedAt < GIVE_UP_MS) {
        await deps.sleep(POLL_MS)
        let running: boolean | null = null
        try {
            const res = await deps.fetch(`${logBase}/log?from=${from}`, { cache: 'no-store' })
            if (res.ok) {
                const body = await res.json()
                for (const line of String(body?.text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
                    if (!LOG_LINE.test(line)) continue
                    laptopRestart.lines = [...laptopRestart.lines, line]
                    if (line.includes('[Warning]')) laptopRestart.warnings = [...laptopRestart.warnings, line]
                }
                if (Number.isFinite(body?.next)) from = body.next
                running = !!body?.running
                if (running) sawRunning = true
            }
        } catch {
            // The switch is out of reach from this page; go by the server.
        }
        const build = await servedBuild(deps)
        const up = build !== null
        if (!up) sawDown = true
        else if (firstBuild === null) firstBuild = build
        else if (build !== firstBuild) sawNewBuild = true
        const ended = running === false ? (sawRunning || from > 0) : running === null && (sawDown || sawNewBuild)
        if (!ended || !up) continue
        if (laptopRestart.warnings.length > 0) {
            laptopRestart.phase = 'warned'
            return
        }
        deps.reload()
        return
    }
    laptopRestart.phase = 'failed'
}

/**
 * The reload button's reload: restart the laptop server first when there is a
 * switch for it, else reload at once. The caller has already saved.
 */
export async function reloadThroughLaptop(deps: LaptopRestartDeps = defaultDeps()): Promise<void> {
    const logBase = await askForRestart(deps)
    if (logBase === null) {
        deps.reload()
        return
    }
    await watchLaptopRestart(logBase, deps)
}

export function dismissLaptopRestart(): void {
    laptopRestart.phase = 'idle'
}
