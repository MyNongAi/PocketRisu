import { describe, expect, test } from 'vitest'
import { classifyPatchWriteResult, mergeTrackedDatabaseChanges } from './saveConflict'
import type { toSaveType } from './risuSave'

const tracked = (overrides: Partial<toSaveType> = {}): toSaveType => ({
    character: [],
    chat: [],
    root: false,
    botPreset: false,
    modules: false,
    moduleIds: [],
    plugins: false,
    pluginCustomStorage: false,
    ...overrides,
})

describe('classifyPatchWriteResult', () => {
    test('hash 409 rebases instead of authorizing a full write', () => {
        expect(classifyPatchWriteResult({ success: false, conflict: true })).toBe('rebase')
    })

    test('chat guard remains on the guarded full-write recovery path', () => {
        expect(classifyPatchWriteResult({
            success: false,
            conflict: false,
            chatGuardRejected: true,
        })).toBe('full-write')
    })

    test('successful patch is committed', () => {
        expect(classifyPatchWriteResult({ success: true })).toBe('saved')
    })
})

describe('mergeTrackedDatabaseChanges', () => {
    const latest = () => ({
        theme: 'remote-theme',
        language: 'remote-language',
        characters: [{ chaId: 'remote-char', value: 'remote' }],
        botPresets: [{ id: 'remote-preset' }],
        botPresetsId: 0,
        modules: [{ id: 'module', value: 'remote' }],
        plugins: [{ name: 'remote-plugin' }],
        pluginCustomStorage: { remote: true },
    })
    const local = () => ({
        theme: 'local-theme',
        language: 'local-language',
        characters: [{ chaId: 'remote-char', value: 'local' }],
        botPresets: [{ id: 'local-preset' }],
        botPresetsId: 1,
        modules: [{ id: 'module', value: 'local' }],
        plugins: [{ name: 'local-plugin' }],
        pluginCustomStorage: { local: true },
    })

    test('module-only conflict preserves unrelated remote root and plugin changes', () => {
        const merged = mergeTrackedDatabaseChanges(
            structuredClone(latest()),
            structuredClone(local()),
            tracked({ modules: true, moduleIds: ['module'] }),
        )
        expect(merged.modules).toEqual([{ id: 'module', value: 'local' }])
        expect(merged.theme).toBe('remote-theme')
        expect(merged.language).toBe('remote-language')
        expect(merged.plugins).toEqual([{ name: 'remote-plugin' }])
        expect(merged.pluginCustomStorage).toEqual({ remote: true })
    })

    test('each coarse block is local-wins only when its tracker is set', () => {
        const merged = mergeTrackedDatabaseChanges(
            structuredClone(latest()),
            structuredClone(local()),
            tracked({ root: true, plugins: true, pluginCustomStorage: true }),
        )
        expect(merged.theme).toBe('local-theme')
        expect(merged.language).toBe('local-language')
        expect(merged.plugins).toEqual([{ name: 'local-plugin' }])
        expect(merged.pluginCustomStorage).toEqual({ local: true })
        expect(merged.modules).toEqual([{ id: 'module', value: 'remote' }])
        expect(merged.botPresets).toEqual([{ id: 'remote-preset' }])
    })

    test('root deletion is preserved only for a tracked root conflict', () => {
        const remote = { ...latest(), remoteOnlySetting: true }
        const localDb: any = local()
        const untracked = mergeTrackedDatabaseChanges(
            structuredClone(remote),
            structuredClone(localDb),
            tracked(),
        )
        expect(untracked.remoteOnlySetting).toBe(true)

        const rootTracked = mergeTrackedDatabaseChanges(
            structuredClone(remote),
            structuredClone(localDb),
            tracked({ root: true }),
        )
        expect(rootTracked).not.toHaveProperty('remoteOnlySetting')
    })
})
