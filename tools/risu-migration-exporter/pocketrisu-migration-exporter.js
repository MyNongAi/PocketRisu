//@name pocketrisu_migration_exporter
//@display-name PocketRisu 이주 내보내기
//@api 3.0
//@version 0.1.0

/*
 * PocketRisu Migration Exporter
 *
 * This file is both an installable RisuAI v3 plugin and a CommonJS module for
 * format-level tests. The browser path is dependency-free on purpose: users
 * can install this single file in desktop Risu and Web Risu alike.
 */

const PocketRisuMigrationExporter = (() => {
    'use strict'

    const FORMAT = 'pocketrisu-migration'
    const FORMAT_VERSION = 1
    const MAGIC = 'PRISUMG1'
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const CHAT_KEYS = new Set([
        'chats',
        'chatFolders',
        'chatPage',
        'coldstorage',
        'coldStoragedChats',
        'lastInteraction',
    ])
    const SOURCE_PRESETS = Object.freeze({
        local: '로컬리스',
        'mobile-web': '모바일웹리스',
        web: '웹리스',
    })

    function cloneJson(value) {
        if (value === undefined) return undefined
        return JSON.parse(JSON.stringify(value))
    }

    function sanitizeCharacter(input, options = {}) {
        if (!input || typeof input !== 'object') return null
        const output = {}
        for (const [key, value] of Object.entries(input)) {
            if (CHAT_KEYS.has(key)) continue
            output[key] = cloneJson(value)
        }
        output.type = output.type || 'character'
        output.chats = []
        output.chatFolders = []
        output.chatPage = 0

        if (!options.includeSecrets && output.oaiTTSConfig && typeof output.oaiTTSConfig === 'object') {
            delete output.oaiTTSConfig.apiKey
        }
        return output
    }

    function sanitizeModule(input) {
        if (!input || typeof input !== 'object') return null
        return cloneJson(input)
    }

    function isInternalAssetPath(value) {
        return typeof value === 'string'
            && value.startsWith('assets/')
            && value.length > 'assets/'.length
            && !value.slice('assets/'.length).includes('/')
            && !value.includes('\\')
    }

    // Risu stores normal assets as flat assets/<id> keys. This also finds
    // references embedded inside character CSS/HTML and module strings, while
    // refusing remote URLs such as https://example.test/assets/image.png.
    const embeddedAssetPattern = /(?:^|[\s"'`([{=,:>])assets\/([A-Za-z0-9][A-Za-z0-9._~-]*)(?=$|[\s"'`()\]}>,;!?&#])/g

    function collectInternalAssetPaths(value) {
        const paths = new Set()
        const seen = new WeakSet()

        const visit = (current) => {
            if (typeof current === 'string') {
                if (isInternalAssetPath(current)) paths.add(current)
                embeddedAssetPattern.lastIndex = 0
                let match
                while ((match = embeddedAssetPattern.exec(current)) !== null) {
                    paths.add(`assets/${match[1]}`)
                }
                return
            }
            if (!current || typeof current !== 'object' || seen.has(current)) return
            seen.add(current)
            if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) return
            for (const key of Object.keys(current)) visit(current[key])
        }

        visit(value)
        return paths
    }

    function buildCharacterLayout(characterOrder, allowedCharacterIds) {
        const allowed = new Set(allowedCharacterIds)
        const loose = []
        const folders = []
        for (const entry of Array.isArray(characterOrder) ? characterOrder : []) {
            if (typeof entry === 'string') {
                if (allowed.has(entry)) loose.push(entry)
                continue
            }
            if (!entry || typeof entry !== 'object' || !Array.isArray(entry.data)) continue
            const characterIds = entry.data.filter((id) => allowed.has(id))
            if (characterIds.length === 0) continue
            folders.push({
                id: typeof entry.id === 'string' ? entry.id : '',
                name: typeof entry.name === 'string' ? entry.name : '',
                color: typeof entry.color === 'string' ? entry.color : '',
                imgFile: isInternalAssetPath(entry.imgFile) ? entry.imgFile : undefined,
                characterIds,
            })
        }
        return { loose, folders }
    }

    function normalizeSource(value, customLabel = '') {
        const type = Object.hasOwn(SOURCE_PRESETS, value) ? value : 'custom'
        const label = type === 'custom'
            ? String(customLabel || '').trim() || '가져온 Risu'
            : SOURCE_PRESETS[type]
        return { type, label }
    }

    function sanitizeFilename(value) {
        return String(value || 'risu')
            .normalize('NFKC')
            .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
            .replace(/[. ]+$/g, '')
            .slice(0, 80) || 'risu'
    }

    function makeId() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            return globalThis.crypto.randomUUID()
        }
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    }

    async function toUint8Array(value) {
        if (value instanceof Uint8Array) return value
        if (value instanceof ArrayBuffer) return new Uint8Array(value)
        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        }
        if (typeof Blob !== 'undefined' && value instanceof Blob) {
            return new Uint8Array(await value.arrayBuffer())
        }
        if (Array.isArray(value)) return Uint8Array.from(value)
        throw new Error('지원하지 않는 에셋 데이터 형식이와요')
    }

    async function sha256Hex(data) {
        const bytes = await toUint8Array(data)
        if (!globalThis.crypto?.subtle) throw new Error('SHA-256을 지원하지 않는 환경이와요')
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
        return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    }

    function encodeBundleParts(manifest, assets) {
        const header = encoder.encode(JSON.stringify(manifest))
        if (header.byteLength > 0xffffffff) throw new Error('이주 파일 헤더가 4GiB를 넘었사와요')
        const prefix = new Uint8Array(MAGIC.length + 4)
        prefix.set(encoder.encode(MAGIC), 0)
        new DataView(prefix.buffer).setUint32(MAGIC.length, header.byteLength, true)
        return [prefix, header, ...assets.map((asset) => asset.data)]
    }

    function decodeBundleBytes(value) {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
        if (bytes.byteLength < MAGIC.length + 4) throw new Error('이주 파일이 너무 짧사와요')
        if (decoder.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) {
            throw new Error('PocketRisu 이주 파일이 아니와요')
        }
        const headerLength = new DataView(bytes.buffer, bytes.byteOffset + MAGIC.length, 4).getUint32(0, true)
        const headerStart = MAGIC.length + 4
        const payloadStart = headerStart + headerLength
        if (payloadStart > bytes.byteLength) throw new Error('이주 파일 헤더가 잘렸사와요')
        const manifest = JSON.parse(decoder.decode(bytes.subarray(headerStart, payloadStart)))
        const assets = []
        let offset = payloadStart
        for (const meta of Array.isArray(manifest.assets) ? manifest.assets : []) {
            if (!Number.isSafeInteger(meta.size) || meta.size < 0 || offset + meta.size > bytes.byteLength) {
                throw new Error(`에셋 ${meta.path || meta.hash || '?'}의 길이가 잘못됐사와요`)
            }
            assets.push({ ...meta, data: bytes.slice(offset, offset + meta.size) })
            offset += meta.size
        }
        if (offset !== bytes.byteLength) throw new Error('이주 파일 끝에 알 수 없는 데이터가 있사와요')
        return { manifest, assets }
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
        return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
    }

    function delay(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds))
    }

    function downloadBlob(filename, blob) {
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }

    async function readAssets(api, paths, progress) {
        const result = new Map()
        const missing = []
        const list = Array.from(paths).sort()
        for (let index = 0; index < list.length; index++) {
            const path = list[index]
            progress?.(`에셋 읽는 중 ${index + 1}/${list.length}: ${path}`)
            try {
                const raw = await api.readImage(path)
                if (raw == null) throw new Error('데이터 없음')
                const data = await toUint8Array(raw)
                const hash = await sha256Hex(data)
                result.set(path, { path, hash, size: data.byteLength, data })
            } catch (error) {
                missing.push({ path, error: error instanceof Error ? error.message : String(error) })
            }
        }
        return { assets: result, missing }
    }

    function subsetCharacterLayout(layout, ids) {
        const allowed = new Set(ids)
        return {
            loose: layout.loose.filter((id) => allowed.has(id)),
            folders: layout.folders
                .map((folder) => ({
                    ...folder,
                    characterIds: folder.characterIds.filter((id) => allowed.has(id)),
                }))
                .filter((folder) => folder.characterIds.length > 0),
        }
    }

    async function exportKind(api, options) {
        const kind = options.kind
        if (kind !== 'characters' && kind !== 'modules') throw new Error('알 수 없는 내보내기 종류이와요')
        const dbKeys = kind === 'characters'
            ? ['characters', 'characterOrder']
            : ['modules']
        options.onProgress?.('Risu 데이터 접근 권한을 확인하는 중이와요')
        const db = await api.getDatabase(dbKeys)
        if (!db) throw new Error('데이터베이스 접근 권한이 거절됐사와요')

        const source = normalizeSource(options.sourceType, options.customSourceLabel)
        const rawItems = kind === 'characters'
            ? (Array.isArray(db.characters) ? db.characters : [])
            : (Array.isArray(db.modules) ? db.modules : [])
        const items = rawItems
            .map((item) => kind === 'characters'
                ? sanitizeCharacter(item, { includeSecrets: options.includeSecrets })
                : sanitizeModule(item))
            .filter(Boolean)

        const characterLayout = kind === 'characters'
            ? buildCharacterLayout(db.characterOrder, items.map((item) => item.chaId))
            : null
        const exportId = makeId()
        const maxChunkBytes = Math.max(16, Math.min(2048, Number(options.chunkSizeMb) || 256)) * 1024 * 1024
        const current = { items: [], assets: new Map(), missing: [], estimatedBytes: 0 }
        const files = []
        let part = 0

        const flush = async () => {
            if (current.items.length === 0) return
            part++
            const assetList = Array.from(current.assets.values())
            const itemIds = current.items.map((item) => kind === 'characters' ? item.chaId : item.id)
            const data = kind === 'characters'
                ? {
                    characters: current.items,
                    characterLayout: subsetCharacterLayout(characterLayout, itemIds),
                }
                : { modules: current.items }
            const manifest = {
                format: FORMAT,
                version: FORMAT_VERSION,
                kind,
                source: {
                    ...source,
                    instanceId: options.sourceInstanceId,
                },
                exportId,
                exportedAt: new Date().toISOString(),
                part,
                data,
                assets: assetList.map(({ path, hash, size }) => ({ path, hash, size })),
                missingAssets: current.missing,
                chatsIncluded: false,
                secretsIncluded: Boolean(options.includeSecrets),
            }
            const parts = encodeBundleParts(manifest, assetList)
            const blob = new Blob(parts, { type: 'application/x-pocketrisu-migration' })
            const kindName = kind === 'characters' ? 'bots' : 'modules'
            const filename = `${sanitizeFilename(source.label)}-${kindName}-${String(part).padStart(3, '0')}.prisumigrate`
            options.onProgress?.(`${filename} 다운로드 중 (${formatBytes(blob.size)})`)
            downloadBlob(filename, blob)
            files.push({ filename, size: blob.size, items: current.items.length, assets: assetList.length })
            current.items = []
            current.assets = new Map()
            current.missing = []
            current.estimatedBytes = 0
            // Give Chromium a turn between automatic downloads and keep the UI responsive.
            await delay(150)
        }

        for (let index = 0; index < items.length; index++) {
            if (options.isCancelled?.()) throw new Error('사용자가 내보내기를 취소했사와요')
            const item = items[index]
            const itemName = item.name || item.chaId || item.id || `${index + 1}`
            options.onProgress?.(`${kind === 'characters' ? '봇' : '모듈'} ${index + 1}/${items.length}: ${itemName}`)
            const assetPaths = collectInternalAssetPaths(item)
            if (kind === 'characters') {
                for (const folder of characterLayout.folders) {
                    if (folder.characterIds.includes(item.chaId) && folder.imgFile) assetPaths.add(folder.imgFile)
                }
            }
            const loaded = await readAssets(api, assetPaths, options.onProgress)
            const incrementalAssetBytes = Array.from(loaded.assets.values())
                .filter((asset) => !current.assets.has(asset.path))
                .reduce((sum, asset) => sum + asset.size, 0)
            const itemJsonBytes = encoder.encode(JSON.stringify(item)).byteLength

            if (current.items.length > 0
                && current.estimatedBytes + incrementalAssetBytes + itemJsonBytes > maxChunkBytes) {
                await flush()
            }

            current.items.push(item)
            current.estimatedBytes += itemJsonBytes
            for (const asset of loaded.assets.values()) {
                if (!current.assets.has(asset.path)) {
                    current.assets.set(asset.path, asset)
                    current.estimatedBytes += asset.size
                }
            }
            current.missing.push(...loaded.missing.map((entry) => ({ ...entry, owner: itemName })))
        }
        await flush()

        return {
            format: FORMAT,
            version: FORMAT_VERSION,
            kind,
            source,
            exportId,
            itemCount: items.length,
            files,
        }
    }

    function renderUi(api, state) {
        document.title = 'PocketRisu 이주 내보내기'
        document.body.innerHTML = `
            <style>
                :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
                * { box-sizing: border-box; }
                body { margin: 0; background: #111827; color: #f3f4f6; }
                main { max-width: 760px; margin: 0 auto; padding: 24px; }
                h1 { margin: 0 0 8px; font-size: 24px; }
                p { color: #cbd5e1; line-height: 1.55; }
                .panel { background: #1f2937; border: 1px solid #374151; border-radius: 14px; padding: 18px; margin-top: 16px; }
                label { display: block; margin: 12px 0 6px; color: #e5e7eb; font-weight: 650; }
                select, input { width: 100%; background: #111827; color: #f9fafb; border: 1px solid #4b5563; border-radius: 9px; padding: 10px 12px; }
                .check { display: flex; align-items: center; gap: 8px; font-weight: 500; }
                .check input { width: auto; }
                .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 18px; }
                button { border: 0; border-radius: 10px; padding: 12px 16px; font-weight: 750; cursor: pointer; }
                button.primary { background: #8b5cf6; color: white; }
                button.secondary { background: #2563eb; color: white; }
                button.cancel { width: 100%; margin-top: 10px; background: #7f1d1d; color: white; display: none; }
                button:disabled { opacity: .45; cursor: wait; }
                #custom-row { display: none; }
                #status { white-space: pre-wrap; overflow-wrap: anywhere; min-height: 72px; color: #d1d5db; font-family: ui-monospace, monospace; font-size: 13px; }
                .warn { color: #fbbf24; font-size: 13px; }
                @media (max-width: 560px) { .buttons { grid-template-columns: 1fr; } main { padding: 16px; } }
            </style>
            <main>
                <h1>PocketRisu 이주 내보내기</h1>
                <p>현재 Risu의 봇과 모듈을 서로 다른 이주 파일로 내보내와요. 채팅과 플러그인은 포함하지 않으며 원본 데이터는 수정하지 않사와요.</p>
                <section class="panel">
                    <label for="source">이 Risu의 출처</label>
                    <select id="source">
                        <option value="local">로컬리스</option>
                        <option value="mobile-web">모바일웹리스</option>
                        <option value="web">웹리스</option>
                        <option value="custom">직접 입력</option>
                    </select>
                    <div id="custom-row">
                        <label for="custom-source">출처 표시명</label>
                        <input id="custom-source" maxlength="50" placeholder="예: 태블릿 웹리스">
                    </div>
                    <label for="chunk-size">파일 분할 크기(MB)</label>
                    <input id="chunk-size" type="number" min="16" max="2048" step="16" value="256">
                    <label class="check"><input id="include-secrets" type="checkbox"> 캐릭터별 API 키도 포함</label>
                    <p class="warn">대부분은 이 항목을 끈 채 사용하는 편이 안전하와요. 브라우저가 여러 파일 다운로드 권한을 물으면 허용해야 한답니다.</p>
                    <div class="buttons">
                        <button id="export-bots" class="primary">봇 전부 백업</button>
                        <button id="export-modules" class="secondary">모듈 전부 백업</button>
                    </div>
                    <button id="cancel" class="cancel">현재 작업 취소</button>
                </section>
                <section class="panel"><div id="status">대기 중이와요.</div></section>
            </main>
        `

        const source = document.getElementById('source')
        const customRow = document.getElementById('custom-row')
        const status = document.getElementById('status')
        const botButton = document.getElementById('export-bots')
        const moduleButton = document.getElementById('export-modules')
        const cancelButton = document.getElementById('cancel')
        source.value = state.sourceType || 'local'
        customRow.style.display = source.value === 'custom' ? 'block' : 'none'

        source.addEventListener('change', async () => {
            customRow.style.display = source.value === 'custom' ? 'block' : 'none'
            state.sourceType = source.value
            await api.safeLocalStorage.setItem('pocketrisu_migration_source_type', source.value)
        })

        let running = false
        let cancelled = false
        const setRunning = (value) => {
            running = value
            botButton.disabled = value
            moduleButton.disabled = value
            cancelButton.style.display = value ? 'block' : 'none'
        }
        cancelButton.addEventListener('click', () => {
            cancelled = true
            status.textContent = '현재 파일을 정리한 뒤 취소하겠사와요.'
        })

        const run = async (kind) => {
            if (running) return
            cancelled = false
            setRunning(true)
            try {
                const sourceType = source.value
                const customSourceLabel = document.getElementById('custom-source').value
                const chunkSizeMb = Number(document.getElementById('chunk-size').value)
                const includeSecrets = document.getElementById('include-secrets').checked
                await api.safeLocalStorage.setItem('pocketrisu_migration_source_type', sourceType)
                const result = await exportKind(api, {
                    kind,
                    sourceType,
                    customSourceLabel,
                    sourceInstanceId: state.sourceInstanceId,
                    chunkSizeMb,
                    includeSecrets,
                    isCancelled: () => cancelled,
                    onProgress: (message) => { status.textContent = message },
                })
                const totalBytes = result.files.reduce((sum, file) => sum + file.size, 0)
                status.textContent = [
                    `${result.source.label} ${kind === 'characters' ? '봇' : '모듈'} 백업이 끝났사와요.`,
                    `항목: ${result.itemCount}개`,
                    `파일: ${result.files.length}개`,
                    `크기: ${formatBytes(totalBytes)}`,
                ].join('\n')
            } catch (error) {
                status.textContent = `실패: ${error instanceof Error ? error.message : String(error)}`
            } finally {
                setRunning(false)
            }
        }

        botButton.addEventListener('click', () => run('characters'))
        moduleButton.addEventListener('click', () => run('modules'))
    }

    async function start(api) {
        let sourceInstanceId = await api.safeLocalStorage.getItem('pocketrisu_migration_source_id')
        if (!sourceInstanceId) {
            sourceInstanceId = makeId()
            await api.safeLocalStorage.setItem('pocketrisu_migration_source_id', sourceInstanceId)
        }
        const sourceType = await api.safeLocalStorage.getItem('pocketrisu_migration_source_type') || 'local'
        await api.registerSetting(
            'PocketRisu 이주 내보내기',
            async () => {
                renderUi(api, { sourceInstanceId, sourceType })
                await api.showContainer('fullscreen')
            },
            '📦',
            'none',
            'pocketrisu-migration-exporter',
        )
        console.log('PocketRisu 이주 내보내기 플러그인이 준비됐사와요')
    }

    return {
        FORMAT,
        FORMAT_VERSION,
        MAGIC,
        sanitizeCharacter,
        sanitizeModule,
        isInternalAssetPath,
        collectInternalAssetPaths,
        buildCharacterLayout,
        normalizeSource,
        encodeBundleParts,
        decodeBundleBytes,
        exportKind,
        start,
    }
})()

if (typeof module !== 'undefined' && module.exports) {
    module.exports = PocketRisuMigrationExporter
}

if (typeof risuai !== 'undefined') {
    PocketRisuMigrationExporter.start(risuai).catch((error) => {
        console.log(`PocketRisu 이주 내보내기 시작 실패: ${error instanceof Error ? error.message : String(error)}`)
    })
}
