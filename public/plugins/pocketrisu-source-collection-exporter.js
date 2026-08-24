//@name pocketrisu_source_collection_exporter
//@display-name PocketRisu 병합용 컬렉션 내보내기
//@api 3.0
//@version 1.0.0
//@arg source_label string 이 기기의 출처 이름 (예: 로컬리스, 모바일웹리스)
//@arg part_size_mb int 조각당 목표 크기(MB, 권장 12)

// PocketRisu Source Collection Exporter — served by PocketRisu for installation in source clients.
// Runs in upstream/local/web Risu through the public Plugin API v3.
(async () => {
  const FORMAT = 'pocketrisu-source-collection'
  const VERSION = 1
  const DEFAULT_PART_MB = 12
  const MAX_PART_BYTES = 32 * 1024 * 1024
  const MAX_SINGLE_ASSET_BYTES = 16 * 1024 * 1024
  const MAX_ENTRIES_PER_PART = 10_000
  const embeddedAssetPattern = /(^|[^a-zA-Z0-9_/])assets\/[^\s"'`()<>\\{}\[\],;]+/g

  function isSafeAssetPath(value) {
    if (typeof value !== 'string' || !value.startsWith('assets/') || value.length > 512) return false
    const name = value.slice('assets/'.length)
    return !!name && name !== '.' && name !== '..' && !/[\/\\\u0000-\u001f\u007f]/.test(name)
  }

  const root = document.createElement('main')
  root.innerHTML = `
    <style>
      :root { color-scheme: dark; font-family: system-ui, sans-serif; }
      body { margin: 0; background: #171717; color: #f4f4f5; }
      main { max-width: 720px; margin: 0 auto; padding: 24px; }
      .card { border: 1px solid #3f3f46; border-radius: 12px; padding: 16px; background: #202024; }
      label { display: block; margin: 12px 0 6px; color: #d4d4d8; }
      input { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #52525b; background: #18181b; color: inherit; }
      .buttons { display: grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap: 10px; margin-top: 16px; }
      button { padding: 12px; border: 0; border-radius: 9px; background: #16a34a; color: white; font-weight: 700; cursor: pointer; }
      button:disabled { opacity: .45; cursor: wait; }
      #status { white-space: pre-wrap; min-height: 44px; margin-top: 14px; color: #d4d4d8; }
      small { color: #a1a1aa; line-height: 1.5; display: block; }
    </style>
    <section class="card">
      <h2>PocketRisu 병합용 컬렉션</h2>
      <small>채팅과 플러그인은 제외하고 봇·모듈·페르소나를 각각 내보냅니다. 필요한 일반 에셋만 포함하며 큰 컬렉션은 여러 조각으로 나눕니다.</small>
      <label for="source">출처 표시 이름</label>
      <input id="source" maxlength="120" placeholder="모바일웹리스" />
      <label for="part-size">조각 목표 크기(MB)</label>
      <input id="part-size" type="number" min="4" max="24" value="12" />
      <div class="buttons">
        <button data-kind="characters">봇 백업</button>
        <button data-kind="modules">모듈 백업</button>
        <button data-kind="personas">페르소나 백업</button>
      </div>
      <div id="status" role="status" aria-live="polite"></div>
    </section>`
  document.body.replaceChildren(root)

  const sourceInput = root.querySelector('#source')
  const partSizeInput = root.querySelector('#part-size')
  const status = root.querySelector('#status')
  const buttons = [...root.querySelectorAll('button[data-kind]')]
  const configuredLabel = await risuai.getArgument('source_label')
  const configuredPartSize = Number(await risuai.getArgument('part_size_mb'))
  sourceInput.value = typeof configuredLabel === 'string' ? configuredLabel : ''
  if (Number.isFinite(configuredPartSize) && configuredPartSize >= 4 && configuredPartSize <= 24) {
    partSizeInput.value = String(Math.floor(configuredPartSize))
  }

  function setBusy(busy) {
    for (const button of buttons) button.disabled = busy
  }

  function setStatus(message) {
    status.textContent = message
  }

  function safeName(value) {
    return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'source'
  }

  function collectAssetPaths(value) {
    const output = new Set()
    const seen = new WeakSet()
    const stack = [value]
    while (stack.length > 0) {
      const item = stack.pop()
      if (typeof item === 'string') {
        if (isSafeAssetPath(item)) output.add(item)
        embeddedAssetPattern.lastIndex = 0
        for (const match of item.matchAll(embeddedAssetPattern)) {
          const token = match[0].slice((match[1] || '').length)
          if (isSafeAssetPath(token)) output.add(token)
        }
        continue
      }
      if (!item || typeof item !== 'object' || ArrayBuffer.isView(item) || item instanceof ArrayBuffer || seen.has(item)) continue
      seen.add(item)
      if (Array.isArray(item)) stack.push(...item)
      else stack.push(...Object.values(item))
    }
    return [...output].sort((a, b) => a.localeCompare(b))
  }

  function stripForExport(kind, value) {
    if (kind === 'characters') {
      // getDatabase() already returns a permission-safe snapshot. Never clone
      // histories a second time merely to discard them — that doubled peak
      // memory on mobile clients with large chat archives.
      const { chats: _chats, chatFolders: _chatFolders, coldstorage: _coldstorage, coldStoragedChats: _coldChats, ...withoutChats } = value
      const clone = withoutChats
      clone.chats = []
      clone.chatFolders = []
      clone.chatPage = 0
      delete clone.sourceInfo
      return clone
    }
    const clone = { ...value }
    delete clone.sourceInfo
    return clone
  }

  function base64ToBytes(value) {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  function bytesToBase64(bytes) {
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    }
    return btoa(binary)
  }

  function normalizeAsset(value) {
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if (typeof value === 'string') {
      const comma = value.indexOf(',')
      const encoded = comma >= 0 ? value.slice(comma + 1) : value
      if (encoded.length > Math.ceil(MAX_SINGLE_ASSET_BYTES / 3) * 4) {
        throw new Error('base64 에셋이 16MB 모바일 안전 한도를 초과합니다.')
      }
      return base64ToBytes(encoded)
    }
    if (value && typeof value === 'object' && 'data' in value) return normalizeAsset(value.data)
    throw new Error('지원하지 않는 에셋 응답 형식')
  }

  async function sha256(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  function downloadPart(payload, sourceLabel) {
    const kindExtension = {
      characters: 'risu-characters',
      modules: 'risu-modules',
      personas: 'risu-personas',
    }[payload.kind]
    const number = String(payload.partIndex + 1).padStart(4, '0')
    const fileName = `${safeName(sourceLabel)}-${payload.bundleId.slice(0, 8)}-part${number}.${kindExtension}`
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    if (blob.size > MAX_PART_BYTES) {
      throw new Error('한 part가 모바일 안전 한도 32MB를 초과했습니다. 조각 크기를 줄이십시오.')
    }
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    // Keep only a couple of recent part Blobs alive. A 15 second grace period
    // retained dozens of 12 MB parts during a large mobile export even though
    // the browser had already accepted each download.
    setTimeout(() => URL.revokeObjectURL(url), 2_000)
  }

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  async function exportKind(kind) {
    const sourceLabel = sourceInput.value.trim()
    if (!sourceLabel) throw new Error('출처 표시 이름을 입력하십시오.')
    if (sourceLabel.length > 120 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/i.test(sourceLabel)) {
      throw new Error('출처 이름은 제어문자 없이 120자 이하여야 합니다.')
    }
    await risuai.setArgument('source_label', sourceLabel)
    const targetBytes = Math.max(4, Math.min(24, Number(partSizeInput.value) || DEFAULT_PART_MB)) * 1024 * 1024
    await risuai.setArgument('part_size_mb', Math.round(targetBytes / 1024 / 1024))

    setStatus('데이터 접근 권한을 확인하는 중…')
    const db = await risuai.getDatabase([kind])
    if (!db || !Array.isArray(db[kind])) throw new Error(`${kind} 데이터를 읽을 수 없습니다.`)
    const entities = db[kind]
      .filter((entity) => kind !== 'characters' || (entity && entity.type !== 'group' && entity.chaId !== '§temp' && entity.chaId !== '§playground'))
      .map((entity) => stripForExport(kind, entity))
    const entitySizes = entities.map((entity, index) => {
      const size = new Blob([JSON.stringify(entity)]).size + 2
      if (size > MAX_PART_BYTES - (64 * 1024)) {
        throw new Error(`${index + 1}번째 ${kind} 항목 하나가 32MB part 한도를 초과합니다.`)
      }
      return size
    })
    const assetPaths = collectAssetPaths(entities)
    const bundleId = crypto.randomUUID()
    const createdAt = Date.now()
    let partIndex = 0
    let currentAssets = []
    let currentBytes = 0

    const emit = async (entitiesForPart, assetsForPart, last) => {
      downloadPart({
        format: FORMAT,
        version: VERSION,
        bundleId,
        kind,
        sourceLabel,
        createdAt,
        partIndex: partIndex++,
        last,
        entities: entitiesForPart,
        assets: assetsForPart,
      }, sourceLabel)
      // Browsers otherwise treat a burst of downloads as an accidental flood.
      await pause(300)
    }

    for (let i = 0; i < assetPaths.length; i++) {
      const path = assetPaths[i]
      setStatus(`에셋 읽는 중 ${i + 1}/${assetPaths.length}\n${path}`)
      const bytes = normalizeAsset(await risuai.readImage(path))
      if (bytes.byteLength > MAX_SINGLE_ASSET_BYTES) {
        throw new Error(`${path}가 16MB를 넘어 모바일 안전 한도를 초과합니다.`)
      }
      const encoded = bytesToBase64(bytes)
      const entry = { path, data: encoded, size: bytes.byteLength, sha256: await sha256(bytes) }
      const estimatedBytes = encoded.length + path.length + 160
      if (currentAssets.length > 0 && (
        currentAssets.length >= MAX_ENTRIES_PER_PART ||
        currentBytes + estimatedBytes > targetBytes
      )) {
        await emit([], currentAssets, false)
        currentAssets = []
        currentBytes = 0
      }
      currentAssets.push(entry)
      currentBytes += estimatedBytes
    }
    if (currentAssets.length > 0) await emit([], currentAssets, false)

    // Entity data comes last. If asset export failed, no final marker exists,
    // so PocketRisu refuses the incomplete bundle instead of importing it.
    let currentEntities = []
    let entityBytes = 0
    for (let entityIndex = 0; entityIndex < entities.length; entityIndex++) {
      const entity = entities[entityIndex]
      const estimatedBytes = entitySizes[entityIndex]
      if (currentEntities.length > 0 && (
        currentEntities.length >= MAX_ENTRIES_PER_PART ||
        entityBytes + estimatedBytes > targetBytes
      )) {
        await emit(currentEntities, [], false)
        currentEntities = []
        entityBytes = 0
      }
      currentEntities.push(entity)
      entityBytes += estimatedBytes
    }
    await emit(currentEntities, [], true)
    setStatus(`완료: ${entities.length}개 항목, ${assetPaths.length}개 에셋, ${partIndex}개 파일\n모든 part 파일을 함께 보관하십시오.`)
  }

  for (const button of buttons) {
    button.addEventListener('click', async () => {
      setBusy(true)
      try {
        await exportKind(button.dataset.kind)
      } catch (error) {
        console.error(error)
        setStatus(`실패: ${error && error.message ? error.message : String(error)}\n이미 내려받은 조각은 마지막 표시가 없어 포켓리스가 거부합니다.`)
      } finally {
        setBusy(false)
      }
    })
  }

  await risuai.registerSetting(
    'PocketRisu 병합용 백업',
    async () => risuai.showContainer('fullscreen'),
    '📦',
    'html',
    'pocketrisu-source-collection-exporter',
  )
})().catch((error) => console.error('[PocketRisu Source Collection Exporter]', error))
