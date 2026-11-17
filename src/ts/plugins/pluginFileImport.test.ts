import { beforeEach, describe, expect, it, vi } from 'vitest'

const importPlugin = vi.hoisted(() => vi.fn())
vi.mock('./plugins.svelte', () => ({ importPlugin }))

import { importPluginFile } from './pluginFileImport'

describe('importPluginFile', () => {
    beforeEach(() => importPlugin.mockReset())

    it('strips a BOM and enables TypeScript for an uppercase extension', async () => {
        importPlugin.mockResolvedValue(true)
        const file = new File(['\uFEFF//@name Example\n'], 'plugin.TS')

        expect(await importPluginFile(file)).toBe(true)
        expect(importPlugin).toHaveBeenCalledWith('//@name Example\n', { isTypescript: true })
    })

    it('does not count a cancelled replacement as installed', async () => {
        importPlugin.mockResolvedValue(undefined)

        expect(await importPluginFile(new File(['//@name Example'], 'plugin.js'))).toBe(false)
        expect(importPlugin).toHaveBeenCalledWith('//@name Example', { isTypescript: false })
    })
})
