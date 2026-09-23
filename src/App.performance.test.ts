import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8')

describe('App startup bundle boundaries', () => {
    it('keeps settings and catalogue managers out of the initial bundle', () => {
        expect(source).not.toContain("import Settings from './lib/Setting/Settings.svelte'")
        expect(source).not.toContain("import CharacterManager from './lib/CharacterManager/CharacterManager.svelte'")
        expect(source).toContain("const settingsLoader = () => import('./lib/Setting/Settings.svelte')")
        expect(source).toContain("const characterManagerLoader = () => import('./lib/CharacterManager/CharacterManager.svelte')")
        expect(source).toContain('<LazyComponent loader={settingsLoader}')
    })
})
