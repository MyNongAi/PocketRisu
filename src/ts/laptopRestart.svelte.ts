// The sidebar's reload button on the laptop server. The laptop's remote switch
// (server/node/laptop-switch.cjs) runs the launcher: stop the server, pull,
// build if needed, start it again — the same run as the desktop's PocketRisu
// button. Meanwhile this page shows the laptop's progress lines, and once the
// server answers again it reloads into whatever the laptop now serves. With
// no switch (any other install) the button just reloads.

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

async function serverAnswers(deps: LaptopRestartDeps): Promise<boolean> {
    try {
        const res = await deps.fetch('/build-id.txt', { cache: 'no-store' })
        return res.ok
    } catch {
        return false
    }
}

/**
 * Follow the launcher run until the server is back. The switch's log says
 * when the run ends; when the page cannot read it, the server going down and
 * answering again marks the end instead.
 */
export async function watchLaptopRestart(logBase: string, deps: LaptopRestartDeps = defaultDeps()): Promise<void> {
    laptopRestart.phase = 'running'
    laptopRestart.lines = []
    laptopRestart.warnings = []
    laptopRestart.startedAt = deps.now()
    let from = 0
    let sawRunning = false
    let sawDown = false
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
        const up = await serverAnswers(deps)
        if (!up) sawDown = true
        const ended = running === false ? (sawRunning || from > 0) : running === null && sawDown
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
