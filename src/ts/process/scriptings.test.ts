// @vitest-environment node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../parser/parser.svelte', () => ({
  hasher: vi.fn(),
  risuChatParser: vi.fn(),
}))

vi.mock('../alert', () => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertInput: vi.fn(),
  alertNormal: vi.fn(),
  alertSelect: vi.fn(),
}))

vi.mock('../globalApi.svelte', () => ({ fetchNative: vi.fn(), readImage: vi.fn() }))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn() }))
vi.mock('../util', () => ({
  asBuffer: vi.fn(),
  getPersonaPrompt: vi.fn(),
  getUserIcon: vi.fn(),
  getUserName: vi.fn(),
  parseKeyValue: (template?: string) =>
    template ? template.split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]) : [],
}))

vi.mock('../storage/database.svelte', () => ({
  getCurrentCharacter: vi.fn(() => ({})),
  getCurrentChat: vi.fn(() => ({ message: [] })),
  getDatabase: vi.fn(() => ({ characters: [] })),
  setDatabase: vi.fn(),
}))

vi.mock('../stores.svelte', () => ({
  DBState: { db: {} },
  ReloadChatPointer: { update: vi.fn() },
  ReloadGUIPointer: { update: vi.fn() },
  selectedCharID: { subscribe: (run: (value: number) => void) => (run(0), () => undefined) },
}))

vi.mock('./modules', () => ({
  getModuleLorebooks: vi.fn(() => []),
  getModuleTriggers: vi.fn(() => []),
}))

vi.mock('./files/inlays', () => ({ getInlayAsset: vi.fn(), writeInlayImage: vi.fn() }))
vi.mock('./lorebook.svelte', () => ({ loadLoreBookV3Prompt: vi.fn() }))
vi.mock('./memory/hypamemory', () => ({ HypaProcesser: vi.fn() }))
vi.mock('./request/request', () => ({ requestChatData: vi.fn(async () => ({ type: 'success', result: 'ok' })) }))
vi.mock('./stableDiff', () => ({ generateAIImage: vi.fn() }))
vi.mock('../parser/chatVar.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../parser/chatVar.svelte')>()),
  getGlobalChatVar: vi.fn(() => '1'),
}))

let runScripted: typeof import('./scriptings').runScripted
let runLuaInteractionTrigger: typeof import('./scriptings').runLuaInteractionTrigger

beforeAll(async () => {
  const jsonLua = await readFile(resolve(process.cwd(), 'public/lua/json.lua'), 'utf8')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(jsonLua, { status: 200 })))
  const scriptings = await import('./scriptings')
  runScripted = scriptings.runScripted
  runLuaInteractionTrigger = scriptings.runLuaInteractionTrigger
})

test('does not stop generation when setStateChanged is a no-op', async () => {
  const result = await runScripted(
    `
      function onStart(id)
        return setStateChanged(id, "unchanged", "value")
      end
    `,
    {
      char: {} as never,
      chat: { message: [] } as never,
      setVar: () => false,
      getVar: () => 'null',
      mode: 'start',
    }
  )

  expect(result.stopSending).toBe(false)
  expect(result.res).toBeNull()
})

test('keeps explicit false as the generation stop signal', async () => {
  const result = await runScripted('function onStart() return false end', {
    char: {} as never,
    chat: { message: [] } as never,
    mode: 'start',
  })

  expect(result.res).toBe(false)
  expect(result.stopSending).toBe(true)
})

test.each(['editDisplay', 'editInput', 'editOutput', 'editRequest'])(
  'skips %s without listeners after initializing the script once',
  async (mode) => {
    const getVar = vi.fn(() => 'initialized')
    const code = `
      getChatVar('', 'initialization')
      json.decode = function() error('Unexpected listener dispatch') end
      json.encode = function() error('Unexpected listener dispatch') end
    `
    const data = mode === 'editRequest' ? [{ content: 'hello', role: 'user' as const }] : 'hello'

    for (let index = 0; index < 2; index++) {
      const result = await runScripted(code, {
        char: {} as never,
        chat: { message: [] } as never,
        data,
        getVar,
        meta: {},
        mode,
      })

      expect(result.res).toBe(data)
      expect(result.stopSending).toBe(false)
    }
    expect(getVar).toHaveBeenCalledExactlyOnceWith('initialization')
  }
)

test.each(['editDisplay', 'editInput', 'editOutput', 'editRequest'])(
  'executes registered %s listeners',
  async (mode) => {
    const result = await runScripted(
      `
        local event = '${mode}'
        listenEdit(event, function(id, value, meta)
          return value .. meta.suffix
        end)
      `,
      {
        char: {} as never,
        chat: { message: [] } as never,
        data: 'hello',
        meta: { suffix: ' world' },
        mode,
      }
    )

    expect(result.res).toBe('hello world')
  }
)

test('runs editDisplay without JSON-encoding its value or result', async () => {
  const data = '"quoted"\nline'
  const result = await runScripted(
    `
      listenEdit('editDisplay', function(id, value)
        json.encode = function() error('Unexpected JSON encoding') end
        return value .. ' edited'
      end)
    `,
    {
      char: {} as never,
      chat: { message: [] } as never,
      data,
      meta: {},
      mode: 'editDisplay',
    }
  )

  expect(result.res).toBe(`${data} edited`)
})

test('clears listener registration when script replacement recreates the engine', async () => {
  const options = {
    char: {} as never,
    chat: { message: [] } as never,
    data: 'original',
    mode: 'editDisplay',
  }
  const registered = await runScripted(
    `
      listenEdit('editDisplay', function() return 'edited' end)
    `,
    options
  )
  expect(registered.res).toBe('edited')

  const unregistered = await runScripted(
    `
      json.decode = function() error('Stale listener registration') end
    `,
    options
  )
  expect(unregistered.res).toBe('original')
})

test('tracks a listener registered after initialization', async () => {
  let register: () => void = () => {
    throw new Error('Missing registration callback')
  }
  const code = `
    getChatVar('', function()
      listenEdit('editDisplay', function(id, value) return value .. ' edited' end)
    end)
  `
  const options = {
    char: {} as never,
    chat: { message: [] } as never,
    data: 'original',
    getVar: vi.fn((callback: unknown) => {
      register = callback as () => void
      return ''
    }),
    mode: 'editDisplay',
  }

  const before = await runScripted(code, options)
  expect(before.res).toBe('original')
  register()
  const after = await runScripted(code, options)
  expect(after.res).toBe('original edited')
})

test("getGlobalVar reads the toggles of the script's own chat, as CBS getglobalvar does", async () => {
  const { getGlobalChatVar } = await import('../parser/chatVar.svelte')
  const chat = { id: 'side-chat', message: [] }
  const result = await runScripted(
    `
      listenEdit('editDisplay', function(id, value)
        return value .. getGlobalVar(id, 'toggle_hud')
      end)
    `,
    {
      char: {} as never,
      chat: chat as never,
      data: 'hud:',
      meta: {},
      mode: 'editDisplay',
    }
  )

  expect(result.res).toBe('hud:1')
  expect(getGlobalChatVar).toHaveBeenCalledWith('toggle_hud', { chat })
})

test('passes API results to Lua as plain tables without JS constructors', async () => {
  const result = await runScripted(
    `
      onStart = async(function(id)
        local response = simpleLLM(id, "prompt"):await()
        return { type = type(response), hasConstructor = response.constructor ~= nil }
      end)
    `,
    {
      char: { type: 'character' } as never,
      chat: { message: [] } as never,
      lowLevelAccess: true,
      mode: 'start',
    }
  )

  expect(result.res).toEqual({ type: 'table', hasConstructor: false })
})

// Chat variables belong to the script's chat, not the selected one: display
// Lua of the split's other pane, or a send after a pane switch, read and
// wrote the selected chat's variables.
describe("chat variables follow the script's chat", () => {
  const code = `
    function onStart(id)
      local mood = getChatVar(id, 'mood')
      setChatVar(id, 'mood', 'w-' .. mood)
    end
  `
  let selected: any
  beforeEach(async () => {
    const { DBState } = await import('../stores.svelte')
    selected = { id: 'selected', message: [], scriptstate: { $mood: 'sel' } }
    ;(DBState as any).db = {
      characters: [{ chaId: 'S', type: 'character', chatPage: 0, chats: [selected], defaultVariables: '' }],
      templateDefaultVariables: '',
    }
  })

  test('the chat a send runs for', async () => {
    const sendChat = { id: 'send', message: [], scriptstate: { $mood: 'send' } }
    const char = { chaId: 'B', type: 'character', chatPage: 0, chats: [sendChat], defaultVariables: '' }
    await runScripted(code, { char: char as never, chat: sendChat as never, mode: 'start' })
    expect(sendChat.scriptstate.$mood).toBe('w-send')
    expect(selected.scriptstate.$mood).toBe('sel')
  })

  test('the live chat when the send holds a copy of it', async () => {
    const live = { id: 'send', message: [], scriptstate: { $mood: 'live' } as Record<string, string> }
    const copy = { id: 'send', message: [], scriptstate: { $mood: 'live' } as Record<string, string> }
    const char = { chaId: 'B', type: 'character', chatPage: 0, chats: [live], defaultVariables: '' }
    await runScripted(code, { char: char as never, chat: copy as never, mode: 'start' })
    expect(live.scriptstate.$mood).toBe('w-live')
    expect(copy.scriptstate.$mood).toBe('live')
  })

  test('the pane chat a display script is given with its module context', async () => {
    const paneChat = { id: 'pane', message: [], scriptstate: { $mood: 'pane' } }
    const paneChar = { chaId: 'P', type: 'character', chatPage: 0, chats: [paneChat], defaultVariables: '' }
    await runScripted(code, {
      char: { type: 'simple' } as never,
      moduleContext: { character: paneChar, chat: paneChat } as never,
      mode: 'start',
    })
    expect(paneChat.scriptstate.$mood).toBe('w-pane')
    expect(selected.scriptstate.$mood).toBe('sel')
  })

  test('the selected chat when nothing else is given', async () => {
    const database = await import('../storage/database.svelte')
    const { DBState } = await import('../stores.svelte')
    const selectedCharacter = (DBState as any).db.characters[0]
    vi.mocked(database.getCurrentCharacter).mockReturnValueOnce(selectedCharacter)
    vi.mocked(database.getCurrentChat).mockReturnValueOnce(selected)
    await runScripted(code, { mode: 'start' })
    expect(selected.scriptstate.$mood).toBe('w-sel')
  })
})

// A button's Lua runs on the button's chat, every trigger of it, even when
// the selection has moved by the time a later trigger starts.
test('every Lua trigger of a button runs on the chat it was given', async () => {
  const database = await import('../storage/database.svelte')
  const owner = { id: 'owner', message: [] }
  const elsewhere = { id: 'elsewhere', message: [] }
  vi.mocked(database.getCurrentChat).mockReturnValue(elsewhere as never)
  const lua = (code: string) => ({ comment: '', type: 'manual', conditions: [], effect: [{ type: 'triggerlua', code }] })
  const char = {
    type: 'character',
    chaId: 'c',
    chats: [owner],
    chatPage: 0,
    triggerscript: [lua('function onButtonClick(id, data) end'), lua('function onButtonClick(id, data) end')],
  }
  try {
    const result = await runLuaInteractionTrigger('button', char as never, 'press', undefined, owner as never)
    expect(result?.chat).toBe(owner)
  } finally {
    vi.mocked(database.getCurrentChat).mockReset()
    vi.mocked(database.getCurrentChat).mockImplementation(() => ({ message: [] }) as never)
  }
})

test.each(['button', 'form'] as const)('keeps a %s script on the chat it started on', async (type) => {
  const started = { message: [], scriptstate: {} }
  const opened = { message: [], scriptstate: {} }
  const { getCurrentChat } = await import('../storage/database.svelte')
  vi.mocked(getCurrentChat).mockReturnValue(opened as never)
  const code = `
    function onButtonClick(id, data)
      setChatVar(id, 'picked', data .. ':' .. getChatVar(id, 'fallback'))
      addChat(id, 'char', 'clicked')
    end
    function onFormSubmit(id, data)
      onButtonClick(id, data)
    end
  `
  const char = {
    type: 'character',
    defaultVariables: 'fallback=default',
    triggerscript: [{ comment: '', type: 'manual', conditions: [], effect: [{ type: 'triggerlua', code }] }],
  }

  const result = await runLuaInteractionTrigger(type, char as never, 'A', undefined, started as never)

  expect(started.scriptstate).toEqual({ $picked: 'A:default' })
  expect(started.message).toEqual([{ role: 'char', data: 'clicked' }])
  expect(opened).toEqual({ message: [], scriptstate: {} })
  expect(result.chat).toBe(started)
})
