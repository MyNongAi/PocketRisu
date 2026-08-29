//@name pocketrisu_source_collection_exporter
//@display-name PocketRisu 병합용 컬렉션 내보내기
//@api 3.0
//@version 1.2.1
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

  class OversizedAssetError extends Error {
    constructor(size) {
      super(`에셋이 ${Math.ceil(size / 1024 / 1024)}MB라서 16MB 모바일 안전 한도를 초과합니다.`)
      this.name = 'OversizedAssetError'
      this.size = size
    }
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

  let databasePermissionReady = false

  async function ensureDatabasePermission() {
    if (databasePermissionReady) return true
    setStatus('데이터 접근 권한을 확인하는 중…')
    // Ask while the plugin iframe is still hidden. Older Risu builds place a
    // fullscreen plugin above the host permission dialog, which made the
    // exporter appear to wait forever even though a confirmation was hidden
    // behind it. An empty projection grants access without cloning the DB.
    try {
      const probe = await risuai.getDatabase([])
      databasePermissionReady = !!probe
    } catch (error) {
      console.error('[PocketRisu Source Collection Exporter] permission probe failed', error)
      databasePermissionReady = false
    }
    return databasePermissionReady
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
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
      const decodedSize = Math.max(0, Math.floor(encoded.length * 3 / 4) - padding)
      if (decodedSize > MAX_SINGLE_ASSET_BYTES) throw new OversizedAssetError(decodedSize)
      return base64ToBytes(encoded)
    }
    if (value && typeof value === 'object' && 'data' in value) return normalizeAsset(value.data)
    throw new Error('지원하지 않는 에셋 응답 형식')
  }

  const SHA256_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ])

  function rotateRight(value, amount) {
    return (value >>> amount) | (value << (32 - amount))
  }

  // Constant-memory fallback for HTTP LAN WebViews where SubtleCrypto is hidden.
  function sha256Portable(input) {
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
    const schedule = new Uint32Array(64)
    const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64
    const bitLength = input.byteLength * 8
    const bitLengthHigh = Math.floor(bitLength / 0x100000000) >>> 0
    const bitLengthLow = bitLength >>> 0
    const paddedByte = (index) => {
      if (index < input.byteLength) return input[index]
      if (index === input.byteLength) return 0x80
      if (index < paddedLength - 8) return 0
      const fromEnd = paddedLength - 1 - index
      if (fromEnd < 4) return (bitLengthLow >>> (fromEnd * 8)) & 0xff
      return (bitLengthHigh >>> ((fromEnd - 4) * 8)) & 0xff
    }
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let word = 0; word < 16; word++) {
        const index = offset + word * 4
        schedule[word] = ((paddedByte(index) << 24) | (paddedByte(index + 1) << 16) |
          (paddedByte(index + 2) << 8) | paddedByte(index + 3)) >>> 0
      }
      for (let word = 16; word < 64; word++) {
        const x = schedule[word - 15], y = schedule[word - 2]
        const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)
        const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)
        schedule[word] = (schedule[word - 16] + sigma0 + schedule[word - 7] + sigma1) >>> 0
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
      for (let round = 0; round < 64; round++) {
        const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
        const choose = (e & f) ^ (~e & g)
        const temp1 = (h + sum1 + choose + SHA256_CONSTANTS[round] + schedule[round]) >>> 0
        const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
        const majority = (a & b) ^ (a & c) ^ (b & c)
        const temp2 = (sum0 + majority) >>> 0
        h = g; g = f; f = e; e = (d + temp1) >>> 0
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map((word) => word.toString(16).padStart(8, '0')).join('')
  }

  async function sha256(bytes) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle
    if (subtle && typeof subtle.digest === 'function') {
      try {
        const digest = await subtle.digest('SHA-256', bytes)
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      } catch (_) {}
    }
    return sha256Portable(bytes)
  }

  function validSecureBytes(value, length) {
    if (value instanceof Uint8Array && value.byteLength === length) return value
    if (Array.isArray(value) && value.length === length && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      return new Uint8Array(value)
    }
    throw new Error('호스트가 올바른 보안 난수를 반환하지 않았습니다.')
  }

  async function secureRandomBytes(length) {
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      const bytes = new Uint8Array(length)
      globalThis.crypto.getRandomValues(bytes)
      return bytes
    }
    try {
      return validSecureBytes(await risuai.getSecureRandomBytes(length), length)
    } catch (error) {
      throw new Error(`이 HTTP 환경에는 안전한 난수 공급원이 없습니다: ${error && error.message ? error.message : String(error)}`)
    }
  }

  async function secureUuid() {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
    const bytes = await secureRandomBytes(16)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  const collectionIds = new Map()
  let collectionStoragePromise
  async function getCollectionId(sourceLabel) {
    const cached = collectionIds.get(sourceLabel)
    if (cached) return cached
    try {
      collectionStoragePromise ??= risuai.getLocalPluginStorage()
      const storage = await collectionStoragePromise
      const key = 'pocketrisu-source-collection-exporter/source-identities-v1'
      const saved = await storage.getItem(key)
      const entries = saved && Array.isArray(saved.entries) ? saved.entries : []
      const existing = entries.find((entry) => entry && entry.label === sourceLabel && /^[a-zA-Z0-9._-]{8,128}$/.test(entry.id))
      if (existing) {
        const result = { id: existing.id, persistent: true }
        collectionIds.set(sourceLabel, result)
        return result
      }
      const id = await secureUuid()
      const nextEntries = entries
        .filter((entry) => entry && typeof entry.label === 'string' && entry.label !== sourceLabel && /^[a-zA-Z0-9._-]{8,128}$/.test(entry.id))
        .slice(-49)
      nextEntries.push({ label: sourceLabel, id })
      await storage.setItem(key, { version: 1, entries: nextEntries })
      const result = { id, persistent: true }
      collectionIds.set(sourceLabel, result)
      return result
    } catch (error) {
      // Never use the label itself as an identity: two devices often use the
      // same visible label. A random session id is safe but cannot reconnect a
      // later export after this plugin page is closed.
      const result = { id: await secureUuid(), persistent: false }
      collectionIds.set(sourceLabel, result)
      return result
    }
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

    if (!await ensureDatabasePermission()) throw new Error('데이터 접근 권한이 거부되었습니다.')
    setStatus(`${kind} 목록을 복사하는 중… 데이터가 많으면 잠시 걸릴 수 있습니다.`)
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
    const collectionIdentity = await getCollectionId(sourceLabel)
    const collectionId = collectionIdentity.id
    const bundleId = await secureUuid()
    const createdAt = Date.now()
    let partIndex = 0
    let currentAssets = []
    let currentOmittedAssets = []
    let currentBytes = 0
    let omittedCount = 0

    const emit = async (entitiesForPart, assetsForPart, omittedAssetsForPart, last) => {
      downloadPart({
        format: FORMAT,
        version: VERSION,
        bundleId,
        collectionId,
        kind,
        sourceLabel,
        createdAt,
        partIndex: partIndex++,
        last,
        entities: entitiesForPart,
        assets: assetsForPart,
        omittedAssets: omittedAssetsForPart,
      }, sourceLabel)
      // Browsers otherwise treat a burst of downloads as an accidental flood.
      await pause(300)
    }

    for (let i = 0; i < assetPaths.length; i++) {
      const path = assetPaths[i]
      setStatus(`에셋 읽는 중 ${i + 1}/${assetPaths.length}\n${path}`)
      let bytes
      try {
        bytes = normalizeAsset(await risuai.readImage(path))
        if (bytes.byteLength > MAX_SINGLE_ASSET_BYTES) throw new OversizedAssetError(bytes.byteLength)
      } catch (error) {
        const omission = error instanceof OversizedAssetError
          ? { path, size: error.size, reason: 'too-large' }
          : { path, size: 0, reason: 'read-failed' }
        if (!(error instanceof OversizedAssetError)) {
          console.warn(`[PocketRisu Source Collection Exporter] skipped unreadable asset: ${path}`, error)
        }
        const estimatedOmissionBytes = path.length + 96
        if ((currentAssets.length > 0 || currentOmittedAssets.length > 0) && (
          currentAssets.length + currentOmittedAssets.length >= MAX_ENTRIES_PER_PART ||
          currentBytes + estimatedOmissionBytes > targetBytes
        )) {
          await emit([], currentAssets, currentOmittedAssets, false)
          currentAssets = []
          currentOmittedAssets = []
          currentBytes = 0
        }
        currentOmittedAssets.push(omission)
        omittedCount += 1
        currentBytes += estimatedOmissionBytes
        continue
      }
      const encoded = bytesToBase64(bytes)
      const entry = { path, data: encoded, size: bytes.byteLength, sha256: await sha256(bytes) }
      const estimatedBytes = encoded.length + path.length + 160
      if ((currentAssets.length > 0 || currentOmittedAssets.length > 0) && (
        currentAssets.length + currentOmittedAssets.length >= MAX_ENTRIES_PER_PART ||
        currentBytes + estimatedBytes > targetBytes
      )) {
        await emit([], currentAssets, currentOmittedAssets, false)
        currentAssets = []
        currentOmittedAssets = []
        currentBytes = 0
      }
      currentAssets.push(entry)
      currentBytes += estimatedBytes
    }
    if (currentAssets.length > 0 || currentOmittedAssets.length > 0) {
      await emit([], currentAssets, currentOmittedAssets, false)
    }

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
        await emit(currentEntities, [], [], false)
        currentEntities = []
        entityBytes = 0
      }
      currentEntities.push(entity)
      entityBytes += estimatedBytes
    }
    await emit(currentEntities, [], [], true)
    // The manifest itself preserves the complete list. The status stays short
    // enough to remain responsive even for pathological collections.
    const omittedText = omittedCount > 0 ? ` · 에셋 누락 ${omittedCount}` : ''
    const identityWarning = collectionIdentity.persistent
      ? ''
      : '\n주의: 이 기기에서는 관계 ID를 저장하지 못했으므로, 봇과 모듈을 이 화면을 닫기 전에 모두 내보내십시오.'
    setStatus(`완료: ${entities.length}개 항목, ${assetPaths.length - omittedCount}개 에셋${omittedText}, ${partIndex}개 파일\n누락 목록을 포함해 모든 part 파일을 함께 보관하십시오.${identityWarning}`)
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
    async () => {
      const granted = await ensureDatabasePermission()
      await risuai.showContainer('fullscreen')
      if (granted) {
        setStatus('내보낼 종류를 고르십시오. 권한 확인은 완료되었습니다.')
      } else {
        setStatus('데이터 접근 권한이 거부되었습니다. 플러그인 권한을 초기화한 뒤 다시 여십시오.')
      }
    },
    '📦',
    'html',
    'pocketrisu-source-collection-exporter',
  )
})().catch((error) => console.error('[PocketRisu Source Collection Exporter]', error))
