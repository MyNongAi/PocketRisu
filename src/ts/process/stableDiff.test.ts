import { describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({ alertError: vi.fn(), notifyError: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({ fetchNative: vi.fn(), globalFetch: vi.fn(), readImage: vi.fn() }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: vi.fn() }))
vi.mock('../stores.svelte', () => ({ CharEmotion: { set: vi.fn() } }))
vi.mock('./processzip', () => ({ processZip: vi.fn() }))
vi.mock('./request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('../requestLog', () => ({ recordRequestLog: vi.fn() }))

import { applyImageOrientation, generateAIImage } from './stableDiff'
import { globalFetch } from '../globalApi.svelte'
import { getDatabase } from '../storage/database.svelte'
import { processZip } from './processzip'

describe('applyImageOrientation', () => {
  test('keeps configured dimensions without an orientation', () => {
    expect(applyImageOrientation(1024, 640)).toEqual({ height: 640, width: 1024 })
  })

  test('places the longer edge on the width for landscape', () => {
    expect(applyImageOrientation(640, 1024, 'landscape')).toEqual({ height: 640, width: 1024 })
  })

  test('places the longer edge on the height for portrait', () => {
    expect(applyImageOrientation(1024, 640, 'portrait')).toEqual({ height: 1024, width: 640 })
  })
})

// A style preset may draw with its own model (the user's request, 2026-10-28).
describe("NovelAI with a preset own values", () => {
  test("sends the preset model and steps over the settings ones", async () => {
    vi.mocked(getDatabase).mockReturnValue({
      sdProvider: 'novelai', NAIImgUrl: 'https://image.novelai.net/ai/generate-image', NAIApiKey: 'test',
      NAIImgModel: 'nai-diffusion-4-5-full',
      NAIImgConfig: { width: 832, height: 1216, sampler: 'k_euler_ancestral', noise_schedule: 'karras', steps: 28, scale: 5, cfg_rescale: 0, sm: true, sm_dyn: false, decrisp: false, variety_plus: false, legacy_uc: false },
    } as any)
    vi.mocked(globalFetch).mockResolvedValue({ ok: true, data: new Uint8Array() } as any)
    vi.mocked(processZip).mockResolvedValue('img')
    await generateAIImage('1girl', {} as any, 'lowres', 'inlay', { nai: { model: 'nai-diffusion-3', steps: 20 } })
    const body = (vi.mocked(globalFetch).mock.calls[0][1] as any).body
    expect(body.model).toBe('nai-diffusion-3')
    expect(body.parameters.steps).toBe(20)
    // SMEA follows the model drawn with: the settings' V4.5 would drop it.
    expect(body.parameters.sm).toBe(true)
  })
})
