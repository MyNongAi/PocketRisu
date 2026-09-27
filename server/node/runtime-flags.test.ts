import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pkg from './runtime-flags.cjs'

const { createRuntimeFlags, flagEnvName, STAT_INTERVAL_MS } = pkg as {
    createRuntimeFlags: (opts: Record<string, unknown>) => {
        get: (name: string) => unknown
        all: () => Record<string, unknown>
        file: string
    }
    flagEnvName: (name: string) => string
    STAT_INTERVAL_MS: number
}

let dir: string
let file: string
let clock: number
let warnings: string[]
const defaults = { incrementalPersist: true, bootDelta: false, sliceMs: 8 }

function flags(env: Record<string, string> = {}) {
    return createRuntimeFlags({
        file,
        defaults,
        env,
        now: () => clock,
        logger: { warn: (message: string) => warnings.push(message) },
    })
}

function writeFlags(content: string) {
    fs.writeFileSync(file, content)
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-flags-'))
    file = path.join(dir, 'pocketrisu-flags.json')
    clock = 1_000_000
    warnings = []
})

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

describe('runtime flags', () => {
    it('uses the defaults when the file is missing', () => {
        const f = flags()
        expect(f.get('incrementalPersist')).toBe(true)
        expect(f.get('unknown')).toBeUndefined()
        expect(f.all()).toEqual(defaults)
        expect(warnings).toEqual([])
    })

    it('reads the file over the defaults and lists its extra flags', () => {
        writeFlags(JSON.stringify({ incrementalPersist: false, extra: 'on' }))
        const f = flags()
        expect(f.get('incrementalPersist')).toBe(false)
        expect(f.get('sliceMs')).toBe(8)
        expect(f.all()).toEqual({ incrementalPersist: false, bootDelta: false, sliceMs: 8, extra: 'on' })
    })

    it('re-stats the file at most every interval', () => {
        writeFlags(JSON.stringify({ incrementalPersist: false }))
        const f = flags()
        expect(f.get('incrementalPersist')).toBe(false)

        writeFlags(JSON.stringify({ incrementalPersist: true, bootDelta: true }))
        clock += STAT_INTERVAL_MS - 1
        expect(f.get('incrementalPersist')).toBe(false)
        clock += 1
        expect(f.get('incrementalPersist')).toBe(true)
        expect(f.get('bootDelta')).toBe(true)

        // Deleting the file goes back to the defaults.
        fs.rmSync(file)
        clock += STAT_INTERVAL_MS
        expect(f.all()).toEqual(defaults)
    })

    it('keeps the last values when an edit does not parse', () => {
        writeFlags(JSON.stringify({ incrementalPersist: false }))
        const f = flags()
        expect(f.get('incrementalPersist')).toBe(false)

        writeFlags('{"incrementalPersist": tr')
        clock += STAT_INTERVAL_MS
        expect(f.get('incrementalPersist')).toBe(false)
        clock += STAT_INTERVAL_MS
        expect(f.get('incrementalPersist')).toBe(false)
        expect(warnings).toHaveLength(1)

        writeFlags('[1, 2]')
        clock += STAT_INTERVAL_MS
        expect(f.get('incrementalPersist')).toBe(false)
        expect(warnings).toHaveLength(2)

        writeFlags(JSON.stringify({ incrementalPersist: true }))
        clock += STAT_INTERVAL_MS
        expect(f.get('incrementalPersist')).toBe(true)
    })

    it('lets POCKETRISU_FLAGS_JSON and then one-flag env vars override the file', () => {
        writeFlags(JSON.stringify({ incrementalPersist: false, bootDelta: true, sliceMs: 4 }))
        const f = flags({
            POCKETRISU_FLAGS_JSON: JSON.stringify({ bootDelta: false, sliceMs: 16 }),
            POCKETRISU_FLAG_SLICE_MS: '32',
            POCKETRISU_FLAG_INCREMENTAL_PERSIST: 'true',
        })
        expect(f.get('incrementalPersist')).toBe(true)
        expect(f.get('bootDelta')).toBe(false)
        expect(f.get('sliceMs')).toBe(32)
        expect(flags({ POCKETRISU_FLAG_BOOT_DELTA: 'yes' }).get('bootDelta')).toBe('yes')
        // An empty variable counts as unset: the file's value applies.
        expect(flags({ POCKETRISU_FLAG_BOOT_DELTA: '' }).get('bootDelta')).toBe(true)
    })

    it('ignores a POCKETRISU_FLAGS_JSON that is not a JSON object', () => {
        const f = flags({ POCKETRISU_FLAGS_JSON: 'incrementalPersist=false' })
        expect(f.get('incrementalPersist')).toBe(true)
        expect(warnings).toHaveLength(1)
    })

    it('names env vars in upper snake case', () => {
        expect(flagEnvName('incrementalPersist')).toBe('POCKETRISU_FLAG_INCREMENTAL_PERSIST')
        expect(flagEnvName('boot-delta')).toBe('POCKETRISU_FLAG_BOOT_DELTA')
        expect(flagEnvName('slice2Ms')).toBe('POCKETRISU_FLAG_SLICE2_MS')
    })

    it('defaults to save/pocketrisu-flags.json under the working directory', () => {
        expect(createRuntimeFlags({}).file).toBe(path.join(process.cwd(), 'save', 'pocketrisu-flags.json'))
    })
})
