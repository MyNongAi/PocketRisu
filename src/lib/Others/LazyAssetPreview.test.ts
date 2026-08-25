// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

const apiMocks = vi.hoisted(() => ({
  getFileSrc: vi.fn(async (path: string) => `/original/${path}`),
  getFileThumbnailSrc: vi.fn(async (path: string) => `/thumbnail/${path}`),
}))

vi.mock('src/ts/globalApi.svelte', () => apiMocks)

import LazyAssetPreview from './LazyAssetPreview.svelte'

class TestIntersectionObserver {
  static latest: TestIntersectionObserver | undefined
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: IntersectionObserverCallback) {
    TestIntersectionObserver.latest = this
  }

  setIntersecting(isIntersecting: boolean) {
    const target = this.observe.mock.calls[0]?.[0] as Element
    this.callback([{ isIntersecting, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }

  unobserve() {}
  takeRecords() { return [] }
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds = []
}

const mounted: unknown[] = []

afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
  vi.useRealTimers()
  document.body.replaceChildren()
  TestIntersectionObserver.latest = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('LazyAssetPreview', () => {
  it('resolves only near the viewport and releases the media element after leaving', async () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    const resolveSrc = vi.fn(async () => '/api/external-assets/content/test')
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(LazyAssetPreview, {
      target,
      props: { path: 'external://local/test', kind: 'image', resolveSrc },
    }))

    await tick()
    expect(resolveSrc).not.toHaveBeenCalled()
    expect(target.querySelector('img')).toBeNull()

    TestIntersectionObserver.latest?.setIntersecting(true)
    await tick()
    await Promise.resolve()
    await tick()

    expect(resolveSrc).toHaveBeenCalledOnce()
    expect(target.querySelector('img')?.getAttribute('src')).toBe('/api/external-assets/content/test')

    TestIntersectionObserver.latest?.setIntersecting(false)
    await tick()

    expect(target.querySelector('img')).toBeNull()

    TestIntersectionObserver.latest?.setIntersecting(true)
    await tick()
    await Promise.resolve()
    await tick()

    expect(resolveSrc).toHaveBeenCalledTimes(2)
  })

  it('does not resolve unsupported files', async () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    const resolveSrc = vi.fn(async () => '/font.ttf')
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(LazyAssetPreview, {
      target,
      props: { path: 'external://local/font', extension: 'ttf', resolveSrc },
    }))

    TestIntersectionObserver.latest?.setIntersecting(true)
    await tick()

    expect(resolveSrc).not.toHaveBeenCalled()
    expect(target.querySelector('img,video,audio')).toBeNull()
  })

  it('uses a real thumbnail URL for an image preview by default', async () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(LazyAssetPreview, {
      target,
      props: { path: 'assets/large.png', extension: 'png' },
    }))

    await tick()
    TestIntersectionObserver.latest?.setIntersecting(true)
    await tick()
    await Promise.resolve()
    await tick()

    expect(apiMocks.getFileThumbnailSrc).toHaveBeenCalledWith('assets/large.png')
    expect(apiMocks.getFileSrc).not.toHaveBeenCalled()
    expect(target.querySelector('img')?.getAttribute('src')).toBe('/thumbnail/assets/large.png')
  })

  it('does not fetch an original merely because a draggable thumbnail is visible', async () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(LazyAssetPreview, {
      target,
      props: {
        path: 'assets/large.png',
        extension: 'png',
        eager: true,
        draggableOriginal: true,
      },
    }))

    await vi.waitFor(() => expect(target.querySelector('img')).not.toBeNull())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prefetches on hover intent so the first drag can carry the original File', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    const fetchMock = vi.fn(async () => new Response(
      new Blob(['original-pixels'], { type: 'image/png' }),
      { status: 200 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:original-file')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(LazyAssetPreview, {
      target,
      props: {
        path: 'assets/reference.png',
        extension: 'png',
        eager: true,
        draggableOriginal: true,
        dragFileName: 'NAI reference.png',
      },
    }))

    await vi.waitFor(() => expect(target.querySelector('img')).not.toBeNull())
    const image = target.querySelector('img') as HTMLImageElement
    const wrapper = target.querySelector('[data-lazy-asset-preview]') as HTMLDivElement
    expect(image.getAttribute('draggable')).toBe('true')

    wrapper.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(119)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    await tick()
    expect(fetchMock).toHaveBeenCalledOnce()

    const add = vi.fn()
    const setData = vi.fn()
    const clearData = vi.fn()
    const dataTransfer = { effectAllowed: 'none', items: { add }, setData, clearData }
    const dragEvent = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(dragEvent, 'dataTransfer', { value: dataTransfer })
    image.dispatchEvent(dragEvent)

    expect(add).toHaveBeenCalledOnce()
    expect(clearData).toHaveBeenCalledOnce()
    const originalFile = add.mock.calls[0][0] as File
    expect(originalFile.name).toBe('NAI reference.png')
    expect(originalFile.type).toBe('image/png')
    expect(originalFile.size).toBeGreaterThan(0)
    expect(setData).toHaveBeenCalledWith('DownloadURL', 'image/png:NAI reference.png:blob:original-file')

    image.dispatchEvent(new Event('dragend', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:original-file')
  })

  it('cancels a hover prefetch and releases its state when pointer intent leaves', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(LazyAssetPreview, {
      target,
      props: {
        path: 'assets/cancel.png',
        extension: 'png',
        eager: true,
        draggableOriginal: true,
      },
    }))

    await vi.waitFor(() => expect(target.querySelector('img')).not.toBeNull())
    const wrapper = target.querySelector('[data-lazy-asset-preview]') as HTMLDivElement
    wrapper.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(120)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledOnce()

    wrapper.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }))
    await Promise.resolve()
    await tick()

    expect(requestSignal?.aborted).toBe(true)
    expect(wrapper.dataset.dragPreparing).toBe('false')
  })
})
