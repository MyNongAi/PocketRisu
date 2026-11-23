import { expect, test, vi } from 'vitest'
import { fingerprint } from 'src/ts/koView'
import { DBState } from 'src/ts/stores.svelte'
import { CharacterHandler } from '../characters'
import type { RPCToolCallTextContent } from '../../mcplib'

vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: { characters: [] } }, selIdState: { selId: undefined } }))
vi.mock('src/ts/alert', () => ({ alertConfirm: vi.fn() }))
vi.mock('katex', () => ({}))
vi.mock('src/ts/lite', () => ({}))

// KO-VIEW-AGENT (2026-11-23): synthetic bot content only.
const bot = () => ({
  chaId: 'ko-bot', name: 'Bot', desc: 'Hello', firstMessage: 'Hi', exampleMessage: '',
  systemPrompt: '', replaceGlobalNote: '', additionalText: '', personality: '', scenario: '', globalLore: [],
}) as any

test('character info accepts Korean in the same approved write and reports stale English', async () => {
  const character = bot()
  DBState.db.characters = [character]
  const approve = vi.fn(async () => true)
  const handler = new CharacterHandler(approve)
  const ko = { desc: '안녕', firstMessage: '반가워' }
  await handler.handle('risu-set-character-info', { id: 'ko-bot', data: { description: 'Hello', greeting: 'Hi' }, ko })
  expect(approve).toHaveBeenCalledTimes(1)
  expect(character.nodeOnlyKo.desc).toEqual({ text: '안녕', src: fingerprint('Hello') })
  const read = async () => JSON.parse(((await handler.handle('risu-get-character-info', { id: 'ko-bot', fields: ['description', 'greeting'] }))![0] as RPCToolCallTextContent).text)
  // Read back under the names asked for.
  expect(await read()).toMatchObject({ ko: { description: { text: '안녕', stale: false }, greeting: { text: '반가워', stale: false } } })
  await handler.handle('risu-set-character-info', { id: 'ko-bot', data: { desc: 'Changed' } })
  expect((await read()).ko.description.stale).toBe(true)
  // The tool's own field names work in ko too.
  await handler.handle('risu-set-character-info', { id: 'ko-bot', data: { description: 'Changed' }, ko: { description: '바뀜' } })
  expect(character.nodeOnlyKo.desc).toEqual({ text: '바뀜', src: fingerprint('Changed') })
  expect((await read()).ko.description.stale).toBe(false)
  await handler.handle('risu-set-character-info', { id: 'ko-bot', data: {}, ko: { desc: '' } })
  expect(character.nodeOnlyKo.desc).toBeUndefined()
})

test('character lorebook writes Korean on create and edit', async () => {
  const character = bot()
  DBState.db.characters = [character]
  const handler = new CharacterHandler(async () => true)
  await handler.handle('risu-set-character-lorebook', { id: 'ko-bot', name: 'entry', content: 'Hello {{user}}', koContent: '안녕 {{user}}' })
  expect(character.globalLore[0].nodeOnlyKo.content).toEqual({ text: '안녕 {{user}}', src: fingerprint('Hello {{user}}') })
  const read = async () => JSON.parse(((await handler.handle('risu-get-character-lorebook', { id: 'ko-bot', names: ['entry'] }))![0] as RPCToolCallTextContent).text)
  expect(await read()).toMatchObject([{ koContent: { stale: false } }])
  await handler.handle('risu-set-character-lorebook', { id: 'ko-bot', name: 'entry', content: 'Changed' })
  expect(await read()).toMatchObject([{ koContent: { stale: true } }])
  await handler.handle('risu-set-character-lorebook', { id: 'ko-bot', name: 'entry', koContent: '' })
  expect(character.globalLore[0].nodeOnlyKo).toBeUndefined()
})
