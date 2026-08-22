<script lang="ts">
  import { onMount } from 'svelte'
  import { getFileSrc } from 'src/ts/globalApi.svelte'

  type MediaKind = 'image' | 'video' | 'audio' | 'unsupported'

  interface Props {
    path: string
    extension?: string
    kind?: MediaKind
    alt?: string
    mediaClass?: string
    wrapperClass?: string
    controls?: boolean
    loop?: boolean
    eager?: boolean
    rootMargin?: string
    resolveSrc?: (path: string) => Promise<string>
  }

  let {
    path,
    extension = '',
    kind,
    alt = '',
    mediaClass = 'w-16 h-16 m-1 rounded-md object-cover',
    wrapperClass = '',
    controls = false,
    loop = false,
    eager = false,
    rootMargin = '240px 120px',
    resolveSrc = getFileSrc,
  }: Props = $props()

  let observerTarget: HTMLDivElement = $state()
  let nearViewport = $state(false)
  let resolvedSrc = $state('')
  let requestGeneration = 0

  const mediaKind = $derived.by<MediaKind>(() => {
    if (kind) return kind

    const normalized = extension.trim().toLowerCase().replace(/^\./, '')
    if (['png', 'webp', 'jpeg', 'jpg', 'gif', 'svg', 'avif', 'bmp'].includes(normalized)) return 'image'
    if (['mp4', 'webm', 'mov', 'm4v'].includes(normalized)) return 'video'
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(normalized)) return 'audio'
    return 'unsupported'
  })

  $effect(() => {
    const currentPath = path
    const currentResolver = resolveSrc
    const shouldResolve = nearViewport && Boolean(currentPath) && mediaKind !== 'unsupported'
    const generation = ++requestGeneration
    resolvedSrc = ''

    if (!shouldResolve) return

    Promise.resolve(currentResolver(currentPath)).then((url) => {
      if (generation !== requestGeneration || !nearViewport || currentPath !== path) return
      resolvedSrc = url || ''
    }).catch((error) => {
      if (generation === requestGeneration) {
        console.warn('[LazyAssetPreview] failed to resolve asset preview:', error)
      }
    })

    return () => {
      requestGeneration += 1
      resolvedSrc = ''
    }
  })

  onMount(() => {
    if (eager) {
      nearViewport = true
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      nearViewport = true
      return
    }

    const observer = new IntersectionObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === observerTarget) ?? entries[0]
      if (entry) nearViewport = entry.isIntersecting
    }, { rootMargin })

    observer.observe(observerTarget)
    return () => observer.disconnect()
  })
</script>

<div bind:this={observerTarget} class={wrapperClass} data-lazy-asset-preview data-active={nearViewport ? 'true' : 'false'}>
  {#if resolvedSrc}
    {#if mediaKind === 'video'}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={resolvedSrc} {controls} {loop} preload="metadata" class={mediaClass}></video>
    {:else if mediaKind === 'audio'}
      <audio src={resolvedSrc} {controls} {loop} preload="none" class={mediaClass}></audio>
    {:else if mediaKind === 'image'}
      <img src={resolvedSrc} {alt} loading="lazy" decoding="async" draggable="false" class={mediaClass} />
    {/if}
  {:else if mediaKind !== 'unsupported'}
    <div aria-hidden="true" class={`${mediaClass} bg-darkbg/40`}></div>
  {/if}
</div>
