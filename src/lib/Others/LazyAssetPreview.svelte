<script lang="ts">
  import { onMount } from 'svelte'
  import { getFileSrc, getFileThumbnailSrc } from 'src/ts/globalApi.svelte'
  import { assetDragPrefetchQueue, type AssetDragPrefetchLease } from './assetDragPrefetch'

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
    thumbnail?: boolean
    draggableOriginal?: boolean
    dragFileName?: string
    originalIntentActive?: boolean
    resolveSrc?: (path: string) => Promise<string>
    resolveOriginalSrc?: (path: string) => Promise<string>
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
    thumbnail = true,
    draggableOriginal = false,
    dragFileName = '',
    originalIntentActive = false,
    resolveSrc,
    resolveOriginalSrc = getFileSrc,
  }: Props = $props()

  let observerTarget: HTMLDivElement = $state()
  let nearViewport = $state(false)
  let resolvedSrc = $state('')
  let previewUsingOriginal = $state(false)
  let dragPreparing = $state(false)
  let pointerIntent = $state(false)
  let dragActive = false
  let preparedDragFile: File | null = $state(null)
  let preparedDragPath = ''
  let dragPreparePromise: Promise<File | null> | null = null
  let dragPrefetchLease: AssetDragPrefetchLease<File> | null = null
  let dragIntentTimer: ReturnType<typeof setTimeout> | null = null
  let dragObjectUrl = ''
  let dragReleaseTimer: ReturnType<typeof setTimeout> | null = null
  let requestGeneration = 0
  let dragGeneration = 0

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
      ?? (thumbnail && mediaKind === 'image' ? getFileThumbnailSrc : getFileSrc)
    const shouldResolve = nearViewport && Boolean(currentPath) && mediaKind !== 'unsupported'
    const generation = ++requestGeneration
    resolvedSrc = ''
    previewUsingOriginal = false

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

  function fallbackPreviewToOriginal() {
    if (!thumbnail || resolveSrc || mediaKind !== 'image' || previewUsingOriginal) {
      resolvedSrc = ''
      return
    }

    previewUsingOriginal = true
    const currentPath = path
    const generation = ++requestGeneration
    Promise.resolve(getFileSrc(currentPath)).then((url) => {
      if (generation !== requestGeneration || !nearViewport || currentPath !== path) return
      resolvedSrc = url || ''
    }).catch((error) => {
      if (generation === requestGeneration) {
        resolvedSrc = ''
        console.warn('[LazyAssetPreview] failed to resolve original fallback:', error)
      }
    })
  }

  function dragMimeType() {
    const normalized = extension.trim().toLowerCase().replace(/^\./, '')
    const mimeByExtension: Record<string, string> = {
      png: 'image/png',
      webp: 'image/webp',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      avif: 'image/avif',
      bmp: 'image/bmp',
    }
    return mimeByExtension[normalized] || 'application/octet-stream'
  }

  function normalizedDragFileName() {
    const normalizedExtension = extension.trim().toLowerCase().replace(/^\./, '')
    let fileName = (dragFileName || alt || `asset.${normalizedExtension || 'png'}`)
      .split(/[\\/]/).pop()?.trim() || `asset.${normalizedExtension || 'png'}`
    if (normalizedExtension && !fileName.toLowerCase().endsWith(`.${normalizedExtension}`)) {
      fileName += `.${normalizedExtension}`
    }
    return fileName
  }

  function releasePreparedDrag() {
    dragGeneration += 1
    dragPrefetchLease?.cancel()
    dragPrefetchLease = null
    dragPreparePromise = null
    preparedDragFile = null
    preparedDragPath = ''
    dragPreparing = false
    if (dragIntentTimer) {
      clearTimeout(dragIntentTimer)
      dragIntentTimer = null
    }
    if (dragReleaseTimer) {
      clearTimeout(dragReleaseTimer)
      dragReleaseTimer = null
    }
    if (dragObjectUrl) {
      URL.revokeObjectURL(dragObjectUrl)
      dragObjectUrl = ''
    }
  }

  function schedulePreparedDragRelease(delayMs: number) {
    if (dragReleaseTimer) clearTimeout(dragReleaseTimer)
    dragReleaseTimer = setTimeout(releasePreparedDrag, delayMs)
  }

  async function prepareOriginalForDrag(event?: PointerEvent | MouseEvent) {
    if (!draggableOriginal || mediaKind !== 'image') return null
    if (event && event.button !== 0) return null
    if (preparedDragFile && preparedDragPath === path) return preparedDragFile
    if (dragPreparePromise) return dragPreparePromise

    if (preparedDragPath && preparedDragPath !== path) releasePreparedDrag()
    const currentPath = path
    const generation = ++dragGeneration
    dragPreparing = true

    const lease = assetDragPrefetchQueue.schedule(async (signal) => {
      const originalUrl = await resolveOriginalSrc(currentPath)
      if (signal.aborted) throw new DOMException('Drag prefetch canceled', 'AbortError')
      const response = await fetch(originalUrl, { credentials: 'include', signal })
      if (!response.ok) throw new Error(`Original asset request failed (${response.status})`)
      const blob = await response.blob()
      if (signal.aborted) throw new DOMException('Drag prefetch canceled', 'AbortError')
      if (generation !== dragGeneration || currentPath !== path) {
        throw new DOMException('Drag prefetch became stale', 'AbortError')
      }

      const file = new File([blob], normalizedDragFileName(), {
        type: blob.type || dragMimeType(),
        lastModified: Date.now(),
      })
      preparedDragFile = file
      preparedDragPath = currentPath
      schedulePreparedDragRelease(30_000)
      return file
    })
    dragPrefetchLease = lease

    let pending: Promise<File | null>
    pending = lease.promise.catch((error) => {
      if (generation === dragGeneration && !(error instanceof DOMException && error.name === 'AbortError')) {
        console.warn('[LazyAssetPreview] failed to prepare original drag file:', error)
      }
      return null
    }).finally(() => {
      if (generation === dragGeneration) dragPreparing = false
      if (dragPrefetchLease === lease) dragPrefetchLease = null
      if (dragPreparePromise === pending) dragPreparePromise = null
    })

    dragPreparePromise = pending
    return pending
  }

  function scheduleOriginalIntent(delayMs = 120) {
    if (!draggableOriginal || mediaKind !== 'image' || preparedDragPath === path || dragPreparePromise) return
    if (dragIntentTimer) clearTimeout(dragIntentTimer)
    dragIntentTimer = setTimeout(() => {
      dragIntentTimer = null
      if (!pointerIntent && !originalIntentActive) return
      void prepareOriginalForDrag()
    }, delayMs)
  }

  function enterOriginalIntent(event: PointerEvent) {
    if (event.pointerType === 'touch') return
    pointerIntent = true
    scheduleOriginalIntent()
  }

  function leaveOriginalIntent(event: PointerEvent) {
    if (event.pointerType === 'touch') return
    pointerIntent = false
    if (!originalIntentActive && !dragActive) releasePreparedDrag()
  }

  $effect(() => {
    const focusedIntent = originalIntentActive
    if (focusedIntent) scheduleOriginalIntent(0)
    else if (!pointerIntent && !dragActive) releasePreparedDrag()
  })

  function startOriginalDrag(event: DragEvent) {
    if (!draggableOriginal || mediaKind !== 'image') return
    const file = preparedDragPath === path ? preparedDragFile : null
    if (!file || !event.dataTransfer) {
      event.preventDefault()
      void prepareOriginalForDrag()
      return
    }

    event.dataTransfer.effectAllowed = 'copy'
    dragActive = true
    try { event.dataTransfer.clearData() } catch { /* keep browser defaults if unavailable */ }
    try { event.dataTransfer.items.add(file) } catch { /* URL fallbacks below */ }

    if (dragObjectUrl) URL.revokeObjectURL(dragObjectUrl)
    dragObjectUrl = URL.createObjectURL(file)
    try { event.dataTransfer.setData('text/uri-list', dragObjectUrl) } catch { /* optional */ }
    try { event.dataTransfer.setData('text/plain', dragObjectUrl) } catch { /* optional */ }
    try { event.dataTransfer.setData('DownloadURL', `${file.type}:${file.name}:${dragObjectUrl}`) } catch { /* Chromium only */ }
    schedulePreparedDragRelease(30_000)
  }

  function finishOriginalDrag() {
    dragActive = false
    // Keep the object URL alive briefly so a cross-tab drop target can finish
    // consuming it, then release both the Blob URL and the original File bytes.
    schedulePreparedDragRelease(10_000)
  }

  onMount(() => {
    let observer: IntersectionObserver | null = null
    if (eager || typeof IntersectionObserver === 'undefined') {
      nearViewport = true
    } else {
      observer = new IntersectionObserver((entries) => {
        const entry = entries.find((candidate) => candidate.target === observerTarget) ?? entries[0]
        if (entry) nearViewport = entry.isIntersecting
      }, { rootMargin })
      observer.observe(observerTarget)
    }

    return () => {
      observer?.disconnect()
      releasePreparedDrag()
    }
  })
</script>

<div
  bind:this={observerTarget}
  role="presentation"
  class={wrapperClass}
  data-lazy-asset-preview
  data-active={nearViewport ? 'true' : 'false'}
  data-drag-preparing={dragPreparing ? 'true' : 'false'}
  onpointerenter={enterOriginalIntent}
  onpointerleave={leaveOriginalIntent}
>
  {#if resolvedSrc}
    {#if mediaKind === 'video'}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={resolvedSrc} {controls} {loop} preload="metadata" class={mediaClass}></video>
    {:else if mediaKind === 'audio'}
      <audio src={resolvedSrc} {controls} {loop} preload="none" class={mediaClass}></audio>
    {:else if mediaKind === 'image'}
      <img
        src={resolvedSrc}
        {alt}
        loading="lazy"
        decoding="async"
        draggable={draggableOriginal}
        aria-busy={dragPreparing}
        title={dragPreparing ? 'Preparing original asset…' : undefined}
        class={mediaClass}
        onerror={fallbackPreviewToOriginal}
        onpointerdown={prepareOriginalForDrag}
        ondragstart={startOriginalDrag}
        ondragend={finishOriginalDrag}
      />
    {/if}
  {:else if mediaKind !== 'unsupported'}
    <div aria-hidden="true" class={`${mediaClass} bg-darkbg/40`}></div>
  {/if}
</div>
