import fc from 'fast-check'
import { writable } from 'svelte/store'
import { beforeEach, expect, test, vi } from 'vitest'
import { DBState } from '../../stores.svelte'
import { getChatVar, getGlobalChatVar, setChatVar } from '../chatVar.svelte'
import { resetChatVariables } from './cbs/lib'

//#region module mocks

vi.mock(
  import('../../storage/database.svelte'),
  () =>
    ({
      appVer: '1234.5.67',
      getCurrentCharacter: () => ({}),
      getCurrentChat: () => ({}),
      getDatabase: () => ({}),
    } as typeof import('../../storage/database.svelte'))
)

vi.mock(import('../../globalApi.svelte'), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: () => Promise.resolve(''),
}))

vi.mock(import('../../stores.svelte'), () => {
  return {
    DBState: {
      db: {
        characters: [
          {
            chatPage: 0,
            chats: [
              {
                scriptstate: {},
              },
            ],
            defaultVariables: '',
          },
        ],
        globalChatVariables: {},
        templateDefaultVariables: '',
      },
    },
    selIdState: {
      selId: 0,
    },
    selectedCharID: writable(0),
    MobileGUI: writable(false),
  } as typeof import('../../stores.svelte')
})

//#endregion

const anyValidDefaultVarKey = fc.string({ minLength: 1, unit: 'grapheme' }).filter((s) => !/[=\n]/.test(s))
const anyValidDefaultVarValue = fc
  .anything()
  .map(JSON.stringify)
  .filter((s) => s !== undefined && !/[=\n]/.test(s))

beforeEach(() => {
  vi.resetAllMocks()
  resetChatVariables()
})

test('can get a character default variable', () => {
  fc.assert(
    fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
      DBState.db.characters[0].defaultVariables = `${key}=${value}`
      expect(getChatVar(key)).toBe(value)
    })
  )
})

test('can get a template default variable', () => {
  fc.assert(
    fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
      DBState.db.templateDefaultVariables = `${key}=${value}`
      expect(getChatVar(key)).toBe(value)
    })
  )
})

test('can set and get a chat variable', () => {
  fc.assert(
    fc.property(
      fc.string({ unit: 'grapheme' }),
      fc
        .anything()
        .filter((v) => v !== undefined)
        .map(JSON.stringify),
      (key, value) => {
        setChatVar(key, value)
        expect(getChatVar(key)).toBe(value)
      }
    )
  )
})

test('can set a chat variable over its default value', () => {
  DBState.db.characters[0].defaultVariables = 'char=default'
  DBState.db.templateDefaultVariables = 'template=default'

  setChatVar('char', 'overridden')
  setChatVar('template', 'overridden')

  expect(getChatVar('char')).toBe('overridden')
  expect(getChatVar('template')).toBe('overridden')
})

test('can get a global chat variable', () => {
  fc.assert(
    fc.property(
      fc.string({ unit: 'grapheme' }),
      fc
        .anything()
        .filter((v) => v !== undefined)
        .map(JSON.stringify),
      (key, value) => {
        DBState.db.globalChatVariables[`toggle_${key}`] = value

        expect(getGlobalChatVar(`toggle_${key}`)).toBe(value)
      }
    )
  )
})

test('returns "null" for undefined variables', () => {
  fc.assert(
    fc.property(fc.string({ unit: 'grapheme' }), (key) => {
      expect(getChatVar(key)).toBe('null')
      expect(getGlobalChatVar(`toggle_${key}`)).toBe('null')
    })
  )
})

test("a toggle of a chat in the split's other pane reads that chat's own value", async () => {
  const { paneState, paneToggles } = await import('../../chatPanes.svelte')
  const { splitChatOpen } = await import('../../chatSplitPane')
  splitChatOpen.set(true)
  paneState.active = 'main'
  paneState.held = { main: null, side: { chaId: 'x', chatId: 'other-chat' } }
  try {
    DBState.db.globalChatVariables.toggle_panesw = '1'
    const selected = DBState.db.characters[0].chats[0] as any
    selected.id = 'selected-chat'
    const other = { id: 'other-chat', message: [] } as any
    paneToggles['other-chat'] = { toggle_panesw: '0' }
    expect(getGlobalChatVar('toggle_panesw', { chat: other })).toBe('0')
    // the selected chat reads the app's live value
    expect(getGlobalChatVar('toggle_panesw', { chat: selected })).toBe('1')
    // without values its pane kept: its pin, else the app's
    delete paneToggles['other-chat']
    other.savedToggleValues = { toggle_panesw: '2' }
    expect(getGlobalChatVar('toggle_panesw', { chat: other })).toBe('2')
    delete other.savedToggleValues
    expect(getGlobalChatVar('toggle_panesw', { chat: other })).toBe('1')
    // other variables stay global
    DBState.db.globalChatVariables.plain = 'x'
    paneToggles['other-chat'] = { plain: 'y' }
    expect(getGlobalChatVar('plain', { chat: other })).toBe('x')
    // the same chat shown in both panes reads the live value
    paneState.held.side = { chaId: 'x', chatId: 'selected-chat' }
    paneToggles['selected-chat'] = { toggle_panesw: '0' }
    expect(getGlobalChatVar('toggle_panesw', { chat: selected })).toBe('1')
  } finally {
    splitChatOpen.set(false)
    paneState.held = { main: null, side: null }
    for (const key of Object.keys(paneToggles)) delete paneToggles[key]
  }
})

test("a calc expression reads the toggles of the chat it is parsed for", async () => {
  const { paneState, paneToggles } = await import('../../chatPanes.svelte')
  const { splitChatOpen } = await import('../../chatSplitPane')
  const { calcString } = await import('../../process/infunctions')
  splitChatOpen.set(true)
  paneState.active = 'main'
  paneState.held = { main: null, side: { chaId: 'x', chatId: 'calc-chat' } }
  try {
    DBState.db.globalChatVariables.toggle_calc = '1'
    const other = { id: 'calc-chat', message: [] } as any
    paneToggles['calc-chat'] = { toggle_calc: '5' }
    expect(calcString('@toggle_calc + 1', { chat: other })).toBe(6)
    expect(calcString('@toggle_calc + 1')).toBe(2)
  } finally {
    splitChatOpen.set(false)
    paneState.held = { main: null, side: null }
    for (const key of Object.keys(paneToggles)) delete paneToggles[key]
  }
})

test('a chat no pane shows beside the selection reads the live toggles, pinned or not', async () => {
  const { paneState, paneToggles } = await import('../../chatPanes.svelte')
  const { splitChatOpen } = await import('../../chatSplitPane')
  DBState.db.globalChatVariables.toggle_hud = '0'
  ;(DBState.db.characters[0].chats[0] as any).id = 'selected-chat'
  // A pinned chat whose reply is still streaming after the user went Home
  // or opened another chat: its pin is a snapshot the user may not have updated.
  const left = { id: 'left-chat', message: [], savedToggleValues: { toggle_hud: '1' }, savedToggleUnsetKeys: ['toggle_unset'] } as any
  expect(getGlobalChatVar('toggle_hud', { chat: left })).toBe('0')
  DBState.db.globalChatVariables.toggle_unset = '1'
  expect(getGlobalChatVar('toggle_unset', { chat: left })).toBe('1')
  // nor do values a closed split still keeps for the chat its side pane held
  paneState.held = { main: null, side: { chaId: 'x', chatId: 'left-chat' } }
  paneToggles['left-chat'] = { toggle_hud: '1' }
  try {
    expect(getGlobalChatVar('toggle_hud', { chat: left })).toBe('0')
    // the active pane's own chat, deselected (Home), is no other pane's
    splitChatOpen.set(true)
    paneState.held = { main: { chaId: 'x', chatId: 'left-chat' }, side: null }
    expect(getGlobalChatVar('toggle_hud', { chat: left })).toBe('0')
  } finally {
    splitChatOpen.set(false)
    paneState.held = { main: null, side: null }
    for (const key of Object.keys(paneToggles)) delete paneToggles[key]
  }
})
