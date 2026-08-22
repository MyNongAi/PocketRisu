// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

vi.mock('src/ts/globalApi.svelte', () => ({
  getFileSrc: vi.fn(async (path: string) => path),
}))

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
  document.body.replaceChildren()
  TestIntersectionObserver.latest = undefined
  vi.unstubAllGlobals()
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
})
