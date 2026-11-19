// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import type { ModelPreset, RegistryFieldSchema, RegistryUiField } from 'src/ts/preset/types'

vi.mock('src/ts/preset/apiKeyPool', () => ({
    listApiKeys: () => [],
    getApiKey: () => undefined,
    addApiKey: vi.fn(),
}))

import CredentialField from './CredentialField.svelte'
import { language } from 'src/lang'

const mounted: unknown[] = []

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
    document.body.replaceChildren()
})

test('plus and minus update the preset rotation references', () => {
    const preset = $state({
        apiKeyRef: undefined,
        rotationKeyRefs: ['existing'],
        profileSnapshot: { providerBaseId: 'example', auth: { kind: 'api-key' } },
    }) as unknown as ModelPreset
    const schemaField = { key: 'apiKey', type: 'string', label: 'API key', mapsTo: { target: 'auth' } } as RegistryFieldSchema
    const uiField = { key: 'apiKey', widget: 'secret', visibility: 'basic' } as RegistryUiField
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(CredentialField, { target, props: { preset, schemaField, uiField, userValues: {} } }))
    flushSync()

    expect(target.querySelectorAll(`[aria-label="${language.presetKeyRotationRemove}"]`)).toHaveLength(1)
    ;(target.querySelector(`[aria-label="${language.presetKeyRotationAdd}"]`) as HTMLButtonElement).click()
    flushSync()
    expect(preset.rotationKeyRefs).toEqual(['existing', ''])
    expect(target.querySelectorAll(`[aria-label="${language.presetKeyRotationRemove}"]`)).toHaveLength(2)

    ;(target.querySelectorAll(`[aria-label="${language.presetKeyRotationRemove}"]`)[0] as HTMLButtonElement).click()
    flushSync()
    expect(preset.rotationKeyRefs).toEqual([''])
})
