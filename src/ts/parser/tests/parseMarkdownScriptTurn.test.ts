import { describe, it, expect, vi } from 'vitest'
import { writable } from 'svelte/store'
import { ParseMarkdown } from '../parser.svelte'

//#region module mocks

vi.mock(
  import('../../storage/database.svelte'),
  () =>
    ({
      appVer: '1234.5.67',
      getCurrentCharacter: () => ({}),
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
            chats: [{}],
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
  } as typeof import('../../stores.svelte')
})

const scriptCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock(import('../../process/scripts'), () => ({
  processScriptFull: async (_char: unknown, data: string) => {
    scriptCalls.count++
    return { data, emoChanged: false }
  },
}) as unknown as typeof import('../../process/scripts'))

//#endregion

const char = { type: 'simple', chaId: 'c1', customscript: [], triggerscript: [] } as any

describe('ParseMarkdown display scripts', () => {
  // A body drawn without assets is parsed inside a $derived (ChatBody). Run
  // in that turn, the Lua display threw state_unsafe_mutation and was dropped,
  // so a folded scene showed unfolded until it came near the screen.
  it('starts the display scripts in a later turn when assets are not resolved', async () => {
    scriptCalls.count = 0
    const parsing = ParseMarkdown('hello', char, 'notrim', 3, {}, { resolveAssets: false })
    expect(scriptCalls.count).toBe(0)
    await parsing
    expect(scriptCalls.count).toBe(1)
  })
})
