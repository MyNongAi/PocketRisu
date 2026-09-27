// @vitest-environment happy-dom

// Module toggles in the two sidebar panels that render Toggles.svelte: the
// chat tab (SideChatList) and the character tab's basic page (CharConfig).
//
// The real stores module is used on purpose. Its root effect runs
// moduleUpdate() -> getModules() whenever module ids change, which warms the
// module-level getModules() cache before Toggles reads it, as in the app.
// With a warm cache, replacing a module or a bound persona's embedded module
// used to leave the toggle list stale (the last two groups below).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { language } from 'src/lang'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'
import { refreshModules } from 'src/ts/process/modules'
import CharConfig from './CharConfig.svelte'
import SideChatList from './SideChatList.svelte'
import ModuleChatMenu from '../Setting/Pages/Module/ModuleChatMenu.svelte'
import {
    PERVENTIA_ID,
    PERVENTIA_LABEL,
    PERVENTIA_NAME,
    PERVENTIA_TOGGLES,
    saveModuleLikeEditor,
    startModuleTreeTracker,
    useTogglesTestDb,
} from './togglesTestDb.svelte'

type Panel = 'CharConfig' | 'SideChatList'
type Scope = 'chat' | 'character' | 'global'

const mounted: Record<string, any>[] = []
let stopTracker: (() => void) | null = null

beforeEach(() => {
    selectedCharID.set(0)
    stopTracker = startModuleTreeTracker()
})

afterEach(() => {
    for (const component of mounted.splice(0).reverse()) unmount(component)
    document.body.replaceChildren()
    stopTracker?.()
    stopTracker = null
    refreshModules()
})

async function settle() {
    flushSync()
    await tick()
    flushSync()
}

function mountInto<Props extends Record<string, any>>(component: any, props: Props) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const instance = mount(component, { target, props })
    mounted.push(instance)
    return { target, instance }
}

function mountPanel(panel: Panel) {
    return panel === 'CharConfig'
        ? mountInto(CharConfig, {})
        : mountInto(SideChatList, { chara: DBState.db.characters[0] })
}

/** Clicks the same control in the chat module menu that a user would. */
async function enableInModuleMenu(scope: Scope) {
    const { target } = mountInto(ModuleChatMenu, { close: () => {} })
    await settle()
    let button: HTMLButtonElement | null | undefined
    if (scope === 'global') {
        // Globally enabling from this menu goes through the folder's globe.
        button = target.querySelector<HTMLButtonElement>('button[aria-label^="폴더 모듈 전체 활성화"]')
    } else {
        // Searching opens every folder, so the module row is rendered.
        const search = target.querySelector<HTMLInputElement>('input')!
        search.value = PERVENTIA_NAME
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await settle()
        const label = scope === 'chat' ? language.moduleScopeChat : language.moduleScopeCharacter
        button = [...target.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)]
            .find((candidate) => candidate.parentElement?.textContent?.includes(PERVENTIA_NAME))
    }
    expect(button).toBeTruthy()
    button!.click()
    await settle()
}

function expectScopeApplied(scope: Scope) {
    const character = DBState.db.characters[0]
    if (scope === 'chat') expect(character.chats[0].modules).toContain(PERVENTIA_ID)
    if (scope === 'character') expect(character.modules).toContain(PERVENTIA_ID)
    if (scope === 'global') expect(DBState.db.enabledModules).toContain(PERVENTIA_ID)
}

describe.each<Panel>(['CharConfig', 'SideChatList'])('%s module toggles', (panel) => {
    describe.each<Scope>(['chat', 'character', 'global'])('enabled at %s scope', (scope) => {
        it('appear while the panel is mounted', async () => {
            useTogglesTestDb()
            await settle()
            const { target } = mountPanel(panel)
            await settle()
            expect(target.textContent).not.toContain(PERVENTIA_LABEL)

            await enableInModuleMenu(scope)

            expectScopeApplied(scope)
            expect(target.textContent).toContain(PERVENTIA_LABEL)
        })

        it('appear when the panel is mounted afterwards', async () => {
            useTogglesTestDb()
            await settle()

            await enableInModuleMenu(scope)
            const { target } = mountPanel(panel)
            await settle()

            expectScopeApplied(scope)
            expect(target.textContent).toContain(PERVENTIA_LABEL)
        })
    })

    describe('module definition replaced (module editor save)', () => {
        async function saveToggleLinesInEditor() {
            saveModuleLikeEditor(PERVENTIA_ID, { customModuleToggle: PERVENTIA_TOGGLES })
            await settle()
        }

        function enabledModuleWithoutToggles() {
            const db = useTogglesTestDb({ chatModules: [PERVENTIA_ID] })
            db.modules.find((module) => module.id === PERVENTIA_ID)!.customModuleToggle = ''
        }

        it('updates a mounted panel', async () => {
            enabledModuleWithoutToggles()
            await settle()
            const { target } = mountPanel(panel)
            await settle()
            expect(target.textContent).not.toContain(PERVENTIA_LABEL)

            await saveToggleLinesInEditor()

            expect(target.textContent).toContain(PERVENTIA_LABEL)
        })

        it('shows in a panel mounted afterwards', async () => {
            enabledModuleWithoutToggles()
            await settle()

            await saveToggleLinesInEditor()
            const { target } = mountPanel(panel)
            await settle()

            expect(target.textContent).toContain(PERVENTIA_LABEL)
        })
    })

    describe('bound persona embedded module replaced', () => {
        function personaWithEmbeddedToggle(label: string) {
            return {
                id: 'persona-1', name: 'Persona', note: '', icon: '', personaPrompt: '',
                embeddedModule: {
                    id: '$embedded', name: 'Persona module', description: '',
                    customModuleToggle: `persona_toggle=${label}`,
                },
            }
        }

        async function replaceEmbeddedModule() {
            DBState.db.personas[0].embeddedModule = personaWithEmbeddedToggle('Persona second').embeddedModule
            await settle()
        }

        it('updates a mounted panel', async () => {
            useTogglesTestDb({ personas: [personaWithEmbeddedToggle('Persona first')], bindedPersona: 'persona-1' })
            await settle()
            const { target } = mountPanel(panel)
            await settle()
            expect(target.textContent).toContain('Persona first')

            await replaceEmbeddedModule()

            expect(target.textContent).toContain('Persona second')
            expect(target.textContent).not.toContain('Persona first')
        })

        it('shows in a panel mounted afterwards', async () => {
            useTogglesTestDb({ personas: [personaWithEmbeddedToggle('Persona first')], bindedPersona: 'persona-1' })
            await settle()

            await replaceEmbeddedModule()
            const { target } = mountPanel(panel)
            await settle()

            expect(target.textContent).toContain('Persona second')
            expect(target.textContent).not.toContain('Persona first')
        })
    })
})
