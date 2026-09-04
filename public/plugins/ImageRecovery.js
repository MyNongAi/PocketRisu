//@name ImageRecoveryPerChar
//@display-name 에셋 캐시 리매핑
//@version 5.50
//@api 2.1

// Extra asset wrench button for per-character/all asset cache remapping.
// Web Risu remaps risuCache entries; Local Risu remaps DB asset references against AppData/assets.

const PANEL_ID = 'ir-percha-panel';
const STYLE_ID = 'ir-percha-style';
const BTN_CLASS = 'ir-percha-injected';   // injected button marker
const WRENCH_CLASS = 'ir-percha-wrench';
const REALM_CLASS = 'ir-percha-realm';
const DB_NAME = 'risuai';
const STORE_NAME = 'keyvaluepairs';
const IMG_EXT_RE = /\.(png|jpg|jpeg|webp|gif|bmp|avif)$/i;
const ASSET_EXT_RE = /\.(png|jpg|jpeg|webp|gif|bmp|avif|mp4|webm|mp3|wav|ogg|ttf|otf|css|woff|woff2|svg)$/i;
const TAURI_BASE_APPDATA = 14;
const LOCAL_ASSET_PATH_HINT = 'Windows 예상: C:\\Users\\(사용자이름)\\AppData\\Roaming\\co.aiclient.risu\\assets';
const PLUGIN_TRASH_PREFIX = 'ImageRecoveryPerChar:trash:';
const PLUGIN_TRASH_VERSION = 1;

let observer = null;
let isRunning = false;
let logBuf = [];
let currentChar = null;
let currentContext = null;
let currentScanResult = null;
let assetStorageMode = 'web';
let pluginStorageMode = 'plugin';
let pluginStorageOrphanOnly = false;
let pluginInventory = createEmptyPluginInventory();
let currentPluginStorageSummary = null;
let currentLorebookSummary = null;
let selectedAssetFolder = null;
let selectedAssetFiles = [];
let resolvedLocalAssetDir = '';
let realmCandidates = [];
let realmAvailabilityCache = new Map();

function pocketAssetApi() {
    return typeof Risuai !== 'undefined' && typeof Risuai.assetStorageInfo === 'function'
        && Risuai.assetStorageInfo().kind === 'pocket' ? Risuai : null;
}

function retryableAssetError(error) {
    if (error && typeof error.retryable === 'boolean') return error.retryable;
    return /network|failed to fetch|timeout|timed out|HTTP (?:429|5\d\d)|ECONN|EBUSY/i.test(String(error && error.message || error));
}

// Shared philosophy of the fast importer / AssetGod: bounded lanes, reduce
// pressure on transient failures, retry only failed work, and throttle UI.
// No eager prefill is started by opening this plugin or by diagnosis.
async function runAdaptiveAssetJobs(items, worker, options = {}) {
    const mobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    let concurrency = Math.max(1, Math.min(8, options.concurrency || (mobile ? 2 : 4)));
    const maxRetries = options.maxRetries == null ? 2 : options.maxRetries;
    const delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    let pending = items.map((item, index) => ({ item, index, attempt: 0 }));
    let completed = 0, retries = 0, failed = 0, lastProgress = 0;
    const progress = force => {
        if (!force && Date.now() - lastProgress < 120) return;
        lastProgress = Date.now();
        if (options.onProgress) options.onProgress({ completed, total: items.length, concurrency, retries, failed });
    };
    while (pending.length) {
        let cursor = 0, pause = false;
        const retry = [];
        await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
            while (!pause && cursor < pending.length) {
                const job = pending[cursor++];
                try {
                    await worker(job.item, job.index);
                    completed++;
                } catch (error) {
                    if (retryableAssetError(error) && job.attempt < maxRetries) {
                        pause = true;
                        retries++;
                        retry.push({ ...job, attempt: job.attempt + 1 });
                    } else {
                        completed++;
                        failed++;
                        if (options.onFailure) options.onFailure(error, job.item, job.index);
                    }
                }
                progress(false);
            }
        }));
        const deferred = pending.slice(cursor);
        pending = retry.concat(deferred);
        if (pending.length) {
            concurrency = Math.max(1, Math.floor(concurrency / 2));
            const attempt = retry.reduce((max, item) => Math.max(max, item.attempt), 1);
            const waitMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
            if (options.onRetry) options.onRetry({ concurrency, retries, waitMs });
            await delay(waitMs);
        }
    }
    progress(true);
    return { completed, failed, retries, concurrency };
}

function $id(id) { return document.getElementById(id); }

// =========================================
// Reach the real IndexedDB object from the page window.
// =========================================
function getRealIDB() {
    try {
        const realDoc = document.body.parentNode.parentNode;
        return realDoc.defaultView['indexedDB'];
    } catch (e) { return null; }
}
function openRisuDB(idb) {
    return new Promise((resolve, reject) => {
        const req = idb.open(DB_NAME);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {};
    });
}
function txGetAllKeys(db) {
    return new Promise((resolve, reject) => {
        try {
            const r = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys();
            r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
        } catch (e) { reject(e); }
    });
}
function txGet(db, key) {
    return new Promise((resolve, reject) => {
        try {
            const r = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
            r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
        } catch (e) { reject(e); }
    });
}
function txGetKey(db, key) {
    return new Promise((resolve, reject) => {
        try {
            const r = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getKey(key);
            r.onerror = () => reject(r.error); r.onsuccess = () => resolve(!!r.result);
        } catch (e) { reject(e); }
    });
}
function txPut(db, key, value) {
    return new Promise((resolve, reject) => {
        try {
            const r = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value, key);
            r.onerror = () => reject(r.error); r.onsuccess = () => resolve();
        } catch (e) { reject(e); }
    });
}

function contentTypeFromPath(path) {
    const ext = (String(path).split('.').pop() || '').toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'bmp') return 'image/bmp';
    if (ext === 'avif') return 'image/avif';
    if (ext === 'mp4') return 'video/mp4';
    if (ext === 'webm') return 'video/webm';
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'wav') return 'audio/wav';
    if (ext === 'ogg') return 'audio/ogg';
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'css') return 'text/css';
    return 'application/octet-stream';
}
function contentTypeFromDetected(type, path) {
    if (type === 'PNG') return 'image/png';
    if (type === 'WEBP') return 'image/webp';
    if (type === 'JPEG') return 'image/jpeg';
    if (type === 'GIF') return 'image/gif';
    if (type === 'BMP') return 'image/bmp';
    if (type === 'AVIF') return 'image/avif';
    return contentTypeFromPath(path);
}

function getRealWindow() {
    try {
        return document.body.parentNode.parentNode.defaultView;
    } catch (e) {
        return null;
    }
}
function getTauriInvoke() {
    const realWin = getRealWindow();
    const internals = realWin && realWin.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') {
        return internals.invoke.bind(internals);
    }
    return null;
}
function detectRuntimeMode() {
    if (pocketAssetApi()) return 'pocket';
    const realWin = getRealWindow();
    try {
        if (realWin && (realWin.__TAURI__ || realWin.__TAURI_INTERNALS__ || realWin.__TAURI_IPC__)) {
            return 'local';
        }
        if (location && String(location.protocol).startsWith('tauri')) {
            return 'local';
        }
    } catch (e) {}
    return 'web';
}
function modeLabel(mode) {
    if (mode === 'pocket') return '포켓리스 서버';
    if (mode === 'local') return '로컬리스(비검증)';
    return '웹리스';
}

async function resolveLocalAssetDir() {
    if (resolvedLocalAssetDir) return resolvedLocalAssetDir;
    const invoke = getTauriInvoke();
    if (!invoke) return '';
    const appData = await invoke('plugin:path|resolve_directory', {
        directory: TAURI_BASE_APPDATA
    });
    const assetDir = await invoke('plugin:path|join', {
        paths: [appData, 'assets']
    });
    resolvedLocalAssetDir = assetDir;
    return assetDir;
}

async function openLocalAssetDir() {
    const invoke = getTauriInvoke();
    if (!invoke) throw new Error('Tauri IPC 접근 실패');
    const assetDir = await resolveLocalAssetDir();
    if (!assetDir) throw new Error('AppData(Roaming)/co.aiclient.risu/assets 경로 확인 실패');
    await invoke('plugin:shell|open', { path: assetDir });
    return assetDir;
}

function basePath(k) { return k.replace(IMG_EXT_RE, ''); }
function assetBasePath(k) { return String(k || '').replace(ASSET_EXT_RE, ''); }
function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return n.toFixed(0) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function clipForLog(value, maxLength) {
    const text = String(value || '').replace(/\r\n/g, '\n').trim();
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
}
function strToHex(str) {
    const bytes = new TextEncoder().encode(str);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
}
function hexToStr(hex) {
    if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return '';
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    try { return new TextDecoder().decode(bytes); }
    catch (e) { return ''; }
}
function assetPathFromSrc(src) {
    if (typeof src !== 'string' || !src) return '';
    const pocket = src.match(/\/api\/(?:asset(?:-thumbnail)?|external-assets\/content)\/([0-9a-f]+)/i);
    if (pocket) return hexToStr(pocket[1]);
    const sw = src.match(/\/sw\/img\/([0-9a-f]+)/i);
    if (sw) return hexToStr(sw[1]);
    let text = src;
    try { text = decodeURIComponent(src); } catch (e) {}
    text = text.replace(/\\/g, '/').split('#')[0].split('?')[0];
    const idx = text.indexOf('assets/');
    if (idx < 0) return '';
    const path = text.slice(idx);
    if (!path.startsWith('assets/') || !ASSET_EXT_RE.test(path)) return '';
    return path;
}
function addRef(refs, seen, path, source) {
    if (typeof path !== 'string' || (!path.startsWith('assets/') && !path.startsWith('external://'))) return;
    if (seen.has(path)) return;
    seen.add(path);
    refs.push({ path, source });
}
function addAssetRefsFromString(refs, seen, text, source) {
    if (typeof text !== 'string' || text.indexOf('assets/') < 0) return;
    const re = /assets\/[^\s"'<>()[\]{}]+?\.(?:png|jpg|jpeg|webp|gif|bmp|avif|mp4|webm|mp3|wav|ogg|ttf|otf|css|woff|woff2|svg)/gi;
    let match = null;
    while ((match = re.exec(text))) {
        addRef(refs, seen, match[0], source);
    }
}
function collectDeepAssetRefs(value, refs, seen, source, depth) {
    if (value == null || depth > 8) return;
    if (typeof value === 'string') {
        addAssetRefsFromString(refs, seen, value, source);
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) collectDeepAssetRefs(value[i], refs, seen, source, depth + 1);
        return;
    }
    if (typeof value === 'object') {
        const skipKeys = {
            chats: true,
            chatFolders: true,
            coldStoragedChats: true
        };
        for (const key of Object.keys(value)) {
            if (skipKeys[key]) continue;
            collectDeepAssetRefs(value[key], refs, seen, source + '.' + key, depth + 1);
        }
    }
}
function resultScopeText(result) {
    if (!result) return '현재 대상';
    if (result.scopeLabel) return result.scopeLabel;
    if (result.mode === 'all') return '전체 캐릭터';
    if (result.mode === 'module') return '이 모듈';
    return '이 캐릭터';
}
function byteSize(v) {
    if (v == null) return 0;
    if (v instanceof Uint8Array) return v.byteLength;
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'object' && typeof v.byteLength === 'number') return v.byteLength;
    if (typeof v === 'object' && typeof v.size === 'number') return v.size;
    if (typeof v === 'string') return v.length;
    return -1;
}
function normalizeBinary(value) {
    if (value == null) return value;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return new Uint8Array(value);
    return value;
}
async function detectImageType(value) {
    let head = null;
    try {
        if (!value) return 'empty';
        value = normalizeBinary(value);
        if (value instanceof Uint8Array) head = value.slice(0, 12);
        else if (value instanceof ArrayBuffer) head = new Uint8Array(value, 0, Math.min(12, value.byteLength));
        else if (typeof value === 'object' && typeof value.slice === 'function' && typeof value.size === 'number') {
            const buf = await value.slice(0, 12).arrayBuffer();
            head = new Uint8Array(buf);
        } else { return 'unknown:' + (typeof value); }
    } catch (e) { return 'error'; }
    if (!head || head.length < 4) return 'empty';
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) return 'PNG';
    if (head[0] === 0xFF && head[1] === 0xD8) return 'JPEG';
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'GIF';
    if (head[0] === 0x42 && head[1] === 0x4D) return 'BMP';
    if (head.length >= 12 &&
        head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
        head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'WEBP';
    // AVIF: ftyp box at byte 4
    if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
        if (head[8] === 0x61 && head[9] === 0x76 && head[10] === 0x69) return 'AVIF';
        return 'ftyp:other';
    }
    return 'unknown';
}

// =========================================
// Missing-asset recovery sources (Realm or an already imported newer bot).
// This path intentionally uses only public plugin APIs so it behaves the same
// in Web Risu and Local Risu. The Tauri folder scanner above is not involved.
// =========================================
const REALM_HUB_URL = 'https://sv.risuai.xyz';
const REALM_DOWNLOAD_URL = 'https://realm.risuai.net/api/v1/download/dynamic/';
const RECOVERY_ROLLBACK_KEY = 'ImageRecoveryPerChar:recovery:last';

function recoveryNormalize(value) {
    return String(value == null ? '' : value)
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i, '')
        .replace(/[\[\](){}<>「」『』【】]/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function recoveryTokenScore(left, right) {
    left = recoveryNormalize(left);
    right = recoveryNormalize(right);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.82;
    const a = new Set(left.split(' ').filter(Boolean));
    const b = new Set(right.split(' ').filter(Boolean));
    let same = 0;
    for (const token of a) if (b.has(token)) same++;
    return (2 * same) / Math.max(1, a.size + b.size);
}

function recoveryRealmId(char) {
    const value = char && (
        char.realmId ||
        (char.extentions && char.extentions.risuRealmImportId) ||
        (char.extensions && char.extensions.risuRealmImportId)
    );
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function characterRepairSlots(char) {
    const slots = [];
    if (!char) return slots;
    slots.push({
        kind: 'profile', name: 'main', ext: '', label: '프로필',
        get: () => char.image || '', set: value => { char.image = value; }
    });
    for (let i = 0; i < (char.emotionImages || []).length; i++) {
        const item = char.emotionImages[i];
        if (!item) continue;
        slots.push({
            kind: 'emotion', name: item[0] || '', ext: 'image', label: '감정: ' + (item[0] || '?'),
            get: () => item[1] || '', set: value => { item[1] = value; }
        });
    }
    for (let i = 0; i < (char.additionalAssets || []).length; i++) {
        const item = char.additionalAssets[i];
        if (!item) continue;
        slots.push({
            kind: 'additional', name: item[0] || '', ext: item[2] || '', label: '추가: ' + (item[0] || '?'),
            get: () => item[1] || '', set: value => { item[1] = value; }
        });
    }
    for (let i = 0; i < (char.ccAssets || []).length; i++) {
        const item = char.ccAssets[i];
        if (!item) continue;
        slots.push({
            kind: 'cc:' + (item.type || 'asset'), name: item.name || '', ext: item.ext || '', label: 'CC: ' + (item.name || '?'),
            get: () => item.uri || '', set: value => { item.uri = value; }
        });
    }
    return slots;
}

async function recoveryReferenceMissing(reference) {
    if (!reference) return true;
    if (typeof reference !== 'string') return true;
    const api = pocketAssetApi();
    if (api && typeof api.inspectAssets === 'function') {
        if (!reference.startsWith('assets/') && !reference.startsWith('external://')) return false;
        const result = await api.inspectAssets([reference]);
        if (result && result[0] && result[0].status === 'missing') return true;
        if (result && result[0] && result[0].status === 'exists') return false;
        throw new Error('원본 존재 여부 미확인: 덮어쓰지 않습니다. ' + reference + ' · ' + (result && result[0] && result[0].code || '진단 오류'));
    }
    // Plugin API 2.1 deliberately accepts only ordinary Risu asset paths.
    // Do not misdiagnose http/data/external references as missing merely
    // because the sandbox refuses to read them.
    if (!reference.startsWith('assets/')) return false;
    try {
        const bytes = normalizeBinary(await readImage(reference));
        return !bytes || byteSize(bytes) <= 0;
    } catch (error) {
        throw new Error('원본 읽기 오류: 파일 없음으로 간주하지 않습니다. ' + reference + ' · ' + (error && error.message || error));
    }
}

function sourceAssetsFromCharacter(char) {
    const assets = [];
    if (!char) return assets;
    const add = (kind, name, ext, reference, label) => {
        if (!reference) return;
        assets.push({
            kind, name: name || '', ext: ext || '', label,
            load: async () => normalizeBinary(await readImage(reference))
        });
    };
    add('profile', 'main', '', char.image, '프로필');
    for (const item of char.emotionImages || []) if (item) add('emotion', item[0], 'image', item[1], '감정: ' + (item[0] || '?'));
    for (const item of char.additionalAssets || []) if (item) add('additional', item[0], item[2], item[1], '추가: ' + (item[0] || '?'));
    for (const item of char.ccAssets || []) if (item) add('cc:' + (item.type || 'asset'), item.name, item.ext, item.uri, 'CC: ' + (item.name || '?'));
    return assets;
}

function recoveryMatchScore(slot, source) {
    if (slot.kind === 'profile' || source.kind === 'profile') return slot.kind === source.kind ? 100 : -1;
    const nameScore = recoveryTokenScore(slot.name, source.name);
    if (nameScore < 1) return -1; // exact after NFKC/extension/punctuation normalization only
    if (slot.kind === source.kind) return 100;
    const imageKinds = new Set(['emotion', 'additional']);
    if (imageKinds.has(slot.kind) && imageKinds.has(source.kind)) return 92;
    return -1;
}

function chooseRecoverySource(slot, sources) {
    let best = null;
    let bestScore = -1;
    for (const source of sources || []) {
        const score = recoveryMatchScore(slot, source);
        if (score > bestScore) {
            best = source;
            bestScore = score;
        }
    }
    return bestScore >= 92 ? best : null;
}

function saveRecoveryRollback(payload) {
    try {
        if (typeof Risuai !== 'undefined' && Risuai.pluginStorage && typeof Risuai.pluginStorage.setItem === 'function') {
            Risuai.pluginStorage.setItem(RECOVERY_ROLLBACK_KEY, JSON.stringify(payload));
        }
    } catch (e) {
        log('되돌리기 기록 저장 실패(복구 자체는 유지): ' + (e && e.message ? e.message : e));
    }
}

async function recoverMissingAssetsFromSources(sourceLabel, sources, realmId) {
    if (!currentChar) throw new Error('현재 캐릭터를 찾지 못했습니다.');
    const slots = characterRepairSlots(currentChar);
    const broken = [];
    setStatus('깨진 에셋 확인 중...');
    for (let i = 0; i < slots.length; i++) {
        if (await recoveryReferenceMissing(slots[i].get())) broken.push(slots[i]);
        if ((i + 1) % 20 === 0 || i === slots.length - 1) {
            setProgress(((i + 1) / Math.max(1, slots.length)) * 30);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    if (broken.length === 0) {
        log('깨진 일반 에셋 참조가 없습니다. 정상 에셋은 덮어쓰지 않았습니다.');
        setStatus('복구 대상 없음');
        return { recovered: 0, broken: 0, unmatched: 0 };
    }

    const planned = broken.map(slot => ({ slot, source: chooseRecoverySource(slot, sources) }));
    const matched = planned.filter(item => item.source);
    if (matched.length === 0) {
        log('깨진 참조 ' + broken.length + '개를 찾았지만 이름·종류가 정확히 일치하는 원본 에셋이 없습니다.');
        setStatus('일치 에셋 없음');
        return { recovered: 0, broken: broken.length, unmatched: broken.length };
    }
    if (!confirm(
        '대상: ' + (currentChar.name || '?') + '\n' +
        '원본: ' + sourceLabel + '\n\n' +
        '깨진 참조 ' + broken.length + '개 중 ' + matched.length + '개를 복구합니다.\n' +
        '정상 에셋과 채팅·프롬프트는 변경하지 않습니다. 계속할까요?'
    )) {
        setStatus('복구 취소');
        return { recovered: 0, broken: broken.length, unmatched: broken.length - matched.length };
    }

    const changes = [];
    let recovered = 0;
    let errors = 0;
    for (let i = 0; i < matched.length; i++) {
        const item = matched[i];
        try {
            const bytes = normalizeBinary(await item.source.load());
            if (!bytes || byteSize(bytes) <= 0) throw new Error('원본 바이트가 비어 있음');
            const previous = item.slot.get();
            const next = await saveAsset(bytes);
            if (!next) throw new Error('saveAsset가 경로를 반환하지 않음');
            item.slot.set(next);
            changes.push({ label: item.slot.label, from: previous, to: next });
            recovered++;
            log('✓ ' + item.slot.label + ' <- ' + item.source.label);
        } catch (e) {
            errors++;
            log('실패: ' + item.slot.label + ': ' + (e && e.message ? e.message : e));
        }
        setProgress(30 + ((i + 1) / Math.max(1, matched.length)) * 65);
        setStatus('에셋 복구 ' + (i + 1) + '/' + matched.length);
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (recovered > 0) {
        if (realmId) {
            currentChar.realmId = realmId;
            currentChar.extentions = currentChar.extentions || {};
            currentChar.extentions.risuRealmImportId = realmId;
        }
        saveRecoveryRollback({
            version: 1,
            at: Date.now(),
            targetId: currentChar.chaId || '',
            targetName: currentChar.name || '',
            source: sourceLabel,
            changes
        });
        await Promise.resolve(setChar(currentChar));
    }
    setProgress(100);
    setStatus('복구 완료: ' + recovered + '개');
    log('완료. 복구 ' + recovered + ', 불일치 ' + (broken.length - matched.length) + ', 오류 ' + errors);
    return { recovered, broken: broken.length, unmatched: broken.length - matched.length, errors };
}

function zipU16(view, offset) { return view.getUint16(offset, true); }
function zipU32(view, offset) { return view.getUint32(offset, true); }

function openRecoveryZip(bytes) {
    bytes = normalizeBinary(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const min = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= min; i--) {
        if (zipU32(view, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('CHARX ZIP 끝 레코드를 찾지 못했습니다.');
    const entryCount = zipU16(view, eocd + 10);
    let offset = zipU32(view, eocd + 16);
    const entries = new Map();
    const decoder = new TextDecoder();
    for (let i = 0; i < entryCount; i++) {
        if (zipU32(view, offset) !== 0x02014b50) throw new Error('CHARX 중앙 디렉터리가 손상되었습니다.');
        const method = zipU16(view, offset + 10);
        const compressedSize = zipU32(view, offset + 20);
        const size = zipU32(view, offset + 24);
        const nameLength = zipU16(view, offset + 28);
        const extraLength = zipU16(view, offset + 30);
        const commentLength = zipU16(view, offset + 32);
        const localOffset = zipU32(view, offset + 42);
        const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength)).replace(/\\/g, '/');
        entries.set(name, { name, method, compressedSize, size, localOffset });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return { bytes, view, entries };
}

async function readRecoveryZipEntry(zip, name) {
    const normalized = String(name || '').replace(/^\/+/, '').replace(/\\/g, '/');
    let entry = zip.entries.get(normalized);
    if (!entry) {
        const lower = normalized.toLocaleLowerCase();
        entry = Array.from(zip.entries.values()).find(item => item.name.toLocaleLowerCase() === lower);
    }
    if (!entry) throw new Error('CHARX 항목 없음: ' + normalized);
    const offset = entry.localOffset;
    if (zipU32(zip.view, offset) !== 0x04034b50) throw new Error('CHARX 로컬 헤더 손상: ' + normalized);
    const nameLength = zipU16(zip.view, offset + 26);
    const extraLength = zipU16(zip.view, offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const compressed = zip.bytes.slice(start, start + entry.compressedSize);
    if (entry.method === 0) return compressed;
    if (entry.method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 압축 CHARX 해제를 지원하지 않습니다.');
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('지원하지 않는 CHARX 압축 방식: ' + entry.method);
}

function recoveryBase64Bytes(value) {
    const raw = atob(String(value || '').replace(/\s+/g, ''));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

function recoveryDataUriBytes(uri) {
    const comma = String(uri || '').indexOf(',');
    if (comma < 0) throw new Error('잘못된 data URI');
    const head = uri.slice(0, comma);
    const body = uri.slice(comma + 1);
    return /;base64/i.test(head) ? recoveryBase64Bytes(body) : new TextEncoder().encode(decodeURIComponent(body));
}

async function recoveryHttpBytes(url, headers) {
    const response = await nativeFetch(url, { method: 'GET', headers: headers || {} });
    if (!response.ok) throw new Error('다운로드 실패 ' + response.status + ': ' + (await response.text().catch(() => '')));
    return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

function cardRecoverySources(card, resolveUri, profileLoader) {
    const sources = [];
    const seen = new Set();
    const add = (kind, name, ext, uri, label, loader) => {
        const key = kind + '|' + recoveryNormalize(name) + '|' + String(uri || '');
        if (seen.has(key)) return;
        seen.add(key);
        sources.push({ kind, name: name || '', ext: ext || '', label, load: loader || (() => resolveUri(uri)) });
    };
    let hasProfile = false;
    const data = card && card.data ? card.data : {};
    for (const asset of data.assets || []) {
        if (!asset || !asset.uri) continue;
        const type = String(asset.type || 'asset');
        let kind = 'cc:' + type;
        if (type === 'icon') { kind = 'profile'; hasProfile = true; }
        else if (type === 'emotion') kind = 'emotion';
        else if (type === 'x-risu-asset') kind = 'additional';
        add(kind, asset.name || (kind === 'profile' ? 'main' : ''), asset.ext || '', asset.uri, type + ': ' + (asset.name || '?'));
    }
    const risu = data.extensions && data.extensions.risuai;
    if (risu) {
        for (const item of risu.emotions || []) if (item) add('emotion', item[0], 'image', item[1], '감정: ' + (item[0] || '?'));
        for (const item of risu.additionalAssets || []) if (item) add('additional', item[0], item[2], item[1], '추가: ' + (item[0] || '?'));
    }
    if (!hasProfile && profileLoader) add('profile', 'main', '', '__profile__', '프로필', profileLoader);
    return sources;
}

async function realmSourcesFromCharx(bytes) {
    const zip = openRecoveryZip(bytes);
    const cardEntry = Array.from(zip.entries.keys()).find(name => name === 'card.json' || name.endsWith('/card.json'));
    if (!cardEntry) throw new Error('CHARX 안에 card.json이 없습니다.');
    const card = JSON.parse(new TextDecoder().decode(await readRecoveryZipEntry(zip, cardEntry)));
    const resolveUri = async uri => {
        uri = String(uri || '');
        if (uri.startsWith('data:')) return recoveryDataUriBytes(uri);
        if (uri.startsWith('embeded://') || uri.startsWith('embedded://')) {
            return readRecoveryZipEntry(zip, uri.replace(/^embedd?ed:\/\//, ''));
        }
        if (/^https?:\/\//i.test(uri)) return (await recoveryHttpBytes(uri)).bytes;
        return (await recoveryHttpBytes(REALM_HUB_URL + '/resource/' + encodeURIComponent(uri))).bytes;
    };
    return { name: card.data && card.data.name || '', sources: cardRecoverySources(card, resolveUri, null) };
}

function readRecoveryPngChunks(bytes) {
    const chunks = new Map();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    const decoder = new TextDecoder();
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset, false);
        const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
        if (type === 'IEND') break;
        if (type === 'tEXt') {
            const data = bytes.slice(offset + 8, offset + 8 + length);
            const zero = data.indexOf(0);
            if (zero >= 0) chunks.set(decoder.decode(data.slice(0, zero)), decoder.decode(data.slice(zero + 1)));
        }
        offset += 12 + length;
    }
    return chunks;
}

async function realmSourcesFromPng(bytes) {
    const chunks = readRecoveryPngChunks(bytes);
    const encodedCard = chunks.get('ccv3') || chunks.get('chara');
    if (!encodedCard) throw new Error('PNG 카드 정보를 찾지 못했습니다.');
    const card = JSON.parse(new TextDecoder().decode(recoveryBase64Bytes(encodedCard)));
    const resolveUri = async uri => {
        uri = String(uri || '');
        if (uri.startsWith('data:')) return recoveryDataUriBytes(uri);
        if (uri.startsWith('__asset:')) {
            const index = uri.replace('__asset:', '');
            const encoded = chunks.get('chara-ext-asset_:' + index) || chunks.get('chara-ext-asset_' + index);
            if (!encoded) throw new Error('PNG 내장 에셋 없음: ' + index);
            return recoveryBase64Bytes(encoded);
        }
        if (/^https?:\/\//i.test(uri)) return (await recoveryHttpBytes(uri)).bytes;
        return (await recoveryHttpBytes(REALM_HUB_URL + '/resource/' + encodeURIComponent(uri))).bytes;
    };
    return { name: card.data && card.data.name || '', sources: cardRecoverySources(card, resolveUri, async () => bytes) };
}

async function realmSourcesFromJson(bytes) {
    const result = JSON.parse(new TextDecoder().decode(bytes));
    const card = result.card || result;
    const resolveUri = async uri => {
        uri = String(uri || '');
        if (uri.startsWith('data:')) return recoveryDataUriBytes(uri);
        if (/^https?:\/\//i.test(uri)) return (await recoveryHttpBytes(uri)).bytes;
        return (await recoveryHttpBytes(REALM_HUB_URL + '/resource/' + encodeURIComponent(uri))).bytes;
    };
    const profileLoader = result.img ? (() => resolveUri(result.img)) : null;
    return { name: card.data && card.data.name || '', sources: cardRecoverySources(card, resolveUri, profileLoader) };
}

async function downloadRealmRecoverySources(id) {
    const url = REALM_DOWNLOAD_URL + encodeURIComponent(id) + '?cors=true';
    const result = await recoveryHttpBytes(url, { 'x-risu-api-version': '4' });
    const bytes = result.bytes;
    const contentType = String(result.response.headers.get('content-type') || '').toLocaleLowerCase();
    if ((bytes[0] === 0x50 && bytes[1] === 0x4b) || contentType.includes('zip') || contentType.includes('charx')) {
        return realmSourcesFromCharx(bytes);
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return realmSourcesFromPng(bytes);
    }
    return realmSourcesFromJson(bytes);
}

function updateRecoverySourceUI() {
    const idInput = $id(PANEL_ID + '-realm-id');
    if (idInput) idInput.value = currentChar ? recoveryRealmId(currentChar) : '';
    const select = $id(PANEL_ID + '-local-source');
    if (select) {
        select.innerHTML = '<option value="">새 버전 봇 선택</option>';
        const targetId = currentChar && currentChar.chaId;
        const targetName = currentChar && currentChar.name;
        const ranked = getAllCharacters()
            .map((char, index) => ({ char, index, score: recoveryTokenScore(targetName, char && char.name) }))
            .filter(item => item.char && item.char.chaId !== targetId)
            .sort((a, b) => b.score - a.score || a.index - b.index);
        for (const item of ranked) {
            const option = document.createElement('option');
            option.value = String(item.index);
            option.textContent = (item.score === 1 ? '★ ' : '') + (item.char.name || '(이름 없음)');
            select.appendChild(option);
        }
    }
    setBtnEnabled('realm-recover', !isRunning && !!currentChar);
    setBtnEnabled('local-recover', !isRunning && !!currentChar);
}

function renderRealmCandidates(candidates) {
    realmCandidates = candidates || [];
    const select = $id(PANEL_ID + '-realm-candidates');
    if (!select) return;
    select.innerHTML = '';
    if (realmCandidates.length === 0) {
        select.innerHTML = '<option value="">후보 없음</option>';
        return;
    }
    for (let i = 0; i < realmCandidates.length; i++) {
        const candidate = realmCandidates[i];
        const option = document.createElement('option');
        option.value = candidate.id || '';
        option.textContent = Math.round((candidate.score || 0) * 100) + '% · ' + (candidate.name || '?') + ' · ' + (candidate.authorname || candidate.creatorName || '?');
        select.appendChild(option);
    }
    selectRealmCandidate();
}

function selectRealmCandidate() {
    const select = $id(PANEL_ID + '-realm-candidates');
    const input = $id(PANEL_ID + '-realm-id');
    if (select && input && select.value) input.value = select.value;
}

async function runRealmCandidateSearch() {
    if (isRunning || !currentChar) return;
    setRunning(true);
    setStatus('렐름 후보 검색 중...');
    try {
        const candidates = await findRealmRecoveryCandidates(currentChar);
        renderRealmCandidates(candidates);
        log('렐름 후보 ' + candidates.length + '개를 찾았습니다. 제목·제작자를 확인한 뒤 복구하시기 바랍니다.');
        setStatus('렐름 후보 ' + candidates.length + '개');
    } catch (e) {
        log('렐름 후보 검색 실패: ' + (e && e.message ? e.message : e));
        setStatus('렐름 검색 오류');
    } finally {
        setRunning(false);
    }
}

async function findRealmRecoveryCandidates(char) {
    const search = (char && char.name || '').trim();
    if (!search) throw new Error('현재 캐릭터 이름이 없습니다.');
    const query = 'search==' + search + ' __shared&&page==0&&nsfw==true&&sort==&&web==other';
    const result = await recoveryHttpBytes(REALM_HUB_URL + '/realm/' + encodeURIComponent(query));
    const json = JSON.parse(new TextDecoder().decode(result.bytes));
    const list = Array.isArray(json) ? json : (json.data || []);
    const creator = recoveryNormalize(char.creator || (char.additionalData && char.additionalData.creator));
    return list.map(candidate => {
        const nameScore = recoveryTokenScore(char.name, candidate.name);
        const candidateCreator = recoveryNormalize(candidate.creatorName || candidate.authorname || candidate.creator);
        const creatorBonus = creator && candidateCreator && creator === candidateCreator ? 0.15 : 0;
        const assetBonus = candidate.hasAsset || candidate.hasEmotion ? 0.03 : 0;
        return Object.assign({}, candidate, { score: Math.min(1, nameScore * 0.82 + creatorBonus + assetBonus) });
    }).filter(candidate => candidate.score >= 0.45).sort((a, b) => b.score - a.score).slice(0, 12);
}

async function runRealmAssetRecovery() {
    if (isRunning || !currentChar) return;
    const idInput = $id(PANEL_ID + '-realm-id');
    const id = String(idInput && idInput.value || '').trim();
    if (!id) {
        log('Realm ID가 없습니다. 먼저 후보 찾기를 실행하시기 바랍니다.');
        setStatus('Realm ID 필요');
        return;
    }
    setRunning(true);
    clearLog();
    setProgress(0);
    setStatus('렐름 카드 다운로드 중...');
    try {
        await refreshCurrentRecoveryCharacter();
        const realm = await downloadRealmRecoverySources(id);
        log('렐름 원본: ' + (realm.name || id) + ', 에셋 후보 ' + realm.sources.length + '개');
        await recoverMissingAssetsFromSources('RisuRealm ' + (realm.name || id), realm.sources, id);
    } catch (e) {
        log('렐름 복구 실패: ' + (e && e.message ? e.message : e));
        setStatus('렐름 복구 오류');
    } finally {
        setRunning(false);
    }
}

async function runImportedBotAssetRecovery() {
    if (isRunning || !currentChar) return;
    const select = $id(PANEL_ID + '-local-source');
    const selectedValue = String(select && select.value || '');
    const index = selectedValue === '' ? NaN : Number(selectedValue);
    const sourceChar = Number.isInteger(index) ? getAllCharacters()[index] : null;
    if (!sourceChar) {
        log('원본으로 사용할 새 버전 봇을 선택하시기 바랍니다.');
        setStatus('임포트 원본 필요');
        return;
    }
    setRunning(true);
    clearLog();
    setProgress(0);
    try {
        await refreshCurrentRecoveryCharacter();
        const sources = sourceAssetsFromCharacter(await hydrateRecoverySourceCharacter(sourceChar));
        log('임포트 원본: ' + (sourceChar.name || '?') + ', 에셋 후보 ' + sources.length + '개');
        await recoverMissingAssetsFromSources('임포트된 봇 ' + (sourceChar.name || '?'), sources, recoveryRealmId(sourceChar));
    } catch (e) {
        log('임포트 봇 복구 실패: ' + (e && e.message ? e.message : e));
        setStatus('임포트 봇 복구 오류');
    } finally {
        setRunning(false);
    }
}

async function localReadAssetEntries(path) {
    const invoke = getTauriInvoke();
    const entries = await invoke('plugin:fs|read_dir', {
        path,
        options: { baseDir: TAURI_BASE_APPDATA }
    });
    const out = [];
    for (const entry of entries || []) {
        const name = entry.name || '';
        const child = path ? path + '/' + name : name;
        const isDir = entry.isDirectory || entry.children;
        if (isDir) {
            try {
                const nested = entry.children
                    ? flattenLocalEntries(child, entry.children)
                    : await localReadAssetEntries(child);
                out.push(...nested);
            } catch (_) {}
        } else if (name) {
            out.push(child);
        }
    }
    return out;
}
function flattenLocalEntries(parent, entries) {
    const out = [];
    for (const entry of entries || []) {
        const name = entry.name || '';
        const child = parent ? parent + '/' + name : name;
        if (entry.isDirectory || entry.children) {
            out.push(...flattenLocalEntries(child, entry.children || []));
        } else if (name) {
            out.push(child);
        }
    }
    return out;
}
function createWebAssetStorage() {
    let db = null;
    return {
        kind: 'web',
        supportsCache: true,
        supportsRemap: true,
        supportsWrite: true,
        async open() {
            const idb = getRealIDB();
            if (!idb) throw new Error('IndexedDB 도달 실패');
            db = await openRisuDB(idb);
            return 'DB 오픈, version ' + db.version;
        },
        async keys() { return await txGetAllKeys(db); },
        async exists(key) { return await txGetKey(db, key); },
        async get(key) { return normalizeBinary(await txGet(db, key)); },
        async put(key, value) { await txPut(db, key, normalizeBinary(value)); },
        close() { try { if (db) db.close(); } catch (_) {} }
    };
}
function createLocalAssetStorage() {
    return {
        kind: 'local',
        supportsCache: false,
        supportsRemap: true,
        supportsWrite: true,
        async open() {
            const invoke = getTauriInvoke();
            if (!invoke) throw new Error('Tauri IPC 접근 실패');
            await resolveLocalAssetDir();
            return '로컬리스 AppData assets 접근: ' + (resolvedLocalAssetDir || LOCAL_ASSET_PATH_HINT);
        },
        async keys() {
            const files = await localReadAssetEntries('assets');
            return files.map(p => p.replace(/\\/g, '/')).filter(p => p.startsWith('assets/') && ASSET_EXT_RE.test(p));
        },
        async exists(key) {
            const invoke = getTauriInvoke();
            return !!(await invoke('plugin:fs|exists', {
                path: key,
                options: { baseDir: TAURI_BASE_APPDATA }
            }));
        },
        async get(key) {
            const invoke = getTauriInvoke();
            return normalizeBinary(await invoke('plugin:fs|read_file', {
                path: key,
                options: { baseDir: TAURI_BASE_APPDATA }
            }));
        },
        async put(key, value) {
            const invoke = getTauriInvoke();
            const bytes = normalizeBinary(value);
            await invoke('plugin:fs|write_file', {
                path: key,
                contents: Array.from(bytes || []),
                options: { baseDir: TAURI_BASE_APPDATA }
            });
        },
        close() {}
    };
}
function createAssetStorage(mode) {
    if (mode === 'pocket') throw new Error('포켓리스는 서버 메타데이터 진단을 사용합니다. 브라우저 저장소와 별개입니다.');
    if (mode === 'local') return createLocalAssetStorage();
    return createWebAssetStorage();
}

// =========================================
// UI: panel
// =========================================
function makeStyle() {
    if ($id(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
        '#' + PANEL_ID + '{position:fixed;inset:0;background:rgba(0,0,0,0.92);' +
        'display:none;flex-direction:column;align-items:center;justify-content:center;' +
        'z-index:999999;font-family:system-ui,sans-serif;color:#fff;}' +
        '#' + PANEL_ID + '.visible{display:flex;}' +
        '.irp-box{background:#1a1a2e;border-radius:10px;padding:14px;' +
        'width:min(780px,95vw);height:min(88vh,760px);' +
        'display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);' +
        'box-sizing:border-box;}' +
        '.irp-head{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;' +
        'margin-bottom:8px;}' +
        '.irp-head-main{min-width:0;}' +
        '.irp-title{margin:0;color:#00d4ff;font-size:1.05rem;font-weight:bold;}' +
        '.irp-sub{margin:0 0 8px 0;color:#aaa;font-size:0.78rem;word-break:break-all;}' +
        '.irp-store{margin-left:auto;border:1px solid #3b3b5d;border-radius:8px;padding:8px;' +
        'background:#111122;min-width:230px;max-width:48%;box-sizing:border-box;}' +
        '.irp-store-title{display:flex;align-items:center;justify-content:space-between;gap:8px;' +
        'font-size:0.78rem;font-weight:bold;color:#c4b5fd;margin-bottom:6px;}' +
        '.irp-store-mode{font-size:0.72rem;padding:4px 8px;border-radius:6px;border:1px solid #4b5563;background:#1f2937;color:#f8f8f2;cursor:pointer;}' +
        '.irp-store-mode:hover{border-color:#22d3ee;}' +
        '.irp-store-row{display:flex;gap:6px;flex-wrap:wrap;}' +
        '.irp-store-btn{flex:1 1 68px;padding:7px 6px;border:none;border-radius:6px;' +
        'font-size:0.72rem;font-weight:bold;cursor:pointer;background:#334155;color:#fff;}' +
        '.irp-store-btn:hover{background:#475569;}' +
        '.irp-store-note{font-size:0.68rem;color:#94a3b8;margin-top:5px;word-break:break-all;}' +
        '.irp-status{color:#ffcc66;font-size:0.78rem;margin-bottom:6px;min-height:1em;' +
        'word-break:break-all;}' +
        '.irp-main{display:flex;gap:10px;min-height:0;flex:1;}' +
        '.irp-tabs{display:flex;flex-direction:column;gap:6px;width:128px;flex:0 0 128px;}' +
        '.irp-tab{padding:10px 8px;border:1px solid #3b3b5d;border-radius:7px;text-align:left;' +
        'background:#111122;color:#cbd5e1;font-size:0.78rem;font-weight:bold;cursor:pointer;line-height:1.25;}' +
        '.irp-tab.active{background:#00d4ff;color:#101021;border-color:#00d4ff;}' +
        '.irp-content{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1;}' +
        '.irp-page{display:none;flex-direction:column;min-height:0;flex:0 0 auto;}' +
        '.irp-page.visible{display:flex;}' +
        '.irp-page-note{border:1px solid #33334f;border-radius:8px;background:#101021;padding:8px;' +
        'font-size:0.72rem;color:#cbd5e1;line-height:1.45;margin-bottom:8px;}' +
        '.irp-progress{width:100%;height:10px;background:#2d2d44;border-radius:5px;' +
        'overflow:hidden;margin-bottom:10px;}' +
        '.irp-bar{height:100%;background:linear-gradient(90deg,#50fa7b,#00d4ff);' +
        'width:0%;transition:width 0.15s;}' +
        '#'+ PANEL_ID + '-page-storage,#'+ PANEL_ID + '-page-plugin-storage,#'+ PANEL_ID + '-page-lorebook{min-height:0;flex:1;overflow:hidden;}' +
        '.irp-usage{border:1px solid #33334f;border-radius:8px;background:#101021;' +
        'padding:8px;margin-bottom:8px;box-sizing:border-box;display:flex;flex-direction:column;' +
        'min-height:0;max-height:100%;overflow:hidden;}' +
        '.irp-usage-title{display:flex;align-items:center;justify-content:space-between;gap:8px;' +
        'font-size:0.78rem;color:#e5e7eb;margin-bottom:6px;}' +
        '.irp-usage-title strong{color:#fff;}' +
        '.irp-usage-total{color:#94a3b8;font-size:0.72rem;text-align:right;}' +
        '.irp-usage-visual{display:flex;align-items:center;justify-content:center;gap:16px;margin:4px 0 6px 0;flex-shrink:0;}' +
        '.irp-usage-pie{width:112px;height:112px;border-radius:50%;background:conic-gradient(#22c55e 0 100%, #ef4444 100% 100%);' +
        'display:flex;align-items:center;justify-content:center;position:relative;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);}' +
        '.irp-usage-pie:after{content:"";position:absolute;width:66px;height:66px;border-radius:50%;background:#101021;' +
        'box-shadow:0 0 0 1px rgba(255,255,255,.05);}' +
        '.irp-usage-pie-text{position:relative;z-index:1;text-align:center;font-size:0.72rem;line-height:1.2;color:#e5e7eb;}' +
        '.irp-usage-pie-text strong{display:block;font-size:1.05rem;color:#ef4444;}' +
        '.irp-usage-vertical{width:32px;height:112px;background:#2d2d44;border-radius:9px;overflow:hidden;display:flex;' +
        'flex-direction:column-reverse;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);}' +
        '.irp-usage-used{width:100%;background:#22c55e;min-height:0;}' +
        '.irp-usage-orphan{width:100%;background:#ef4444;min-height:0;}' +
        '.irp-usage-legend{display:flex;gap:10px;flex-wrap:wrap;font-size:0.72rem;color:#cbd5e1;flex-shrink:0;}' +
        '.irp-usage-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px;}' +
        '.irp-usage-dot.used{background:#22c55e;}' +
        '.irp-usage-dot.orphan{background:#ef4444;}' +
        '.irp-usage-note{margin-top:5px;color:#94a3b8;font-size:0.68rem;line-height:1.35;flex-shrink:0;}' +
        '.irp-usage-samples{margin-top:8px;min-height:52px;max-height:96px;overflow:auto;background:#0a0a14;' +
        'border:1px solid #24243a;border-radius:6px;padding:7px;font-family:ui-monospace,monospace;' +
        'font-size:10px;line-height:1.35;color:#fca5a5;white-space:pre-wrap;word-break:break-all;}' +
        '.irp-plugin-controls{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;}' +
        '.irp-plugin-select{min-width:158px;padding:8px;border-radius:6px;border:1px solid #3b3b5d;' +
        'background:#111122;color:#f8f8f2;font:inherit;font-size:0.76rem;}' +
        '.irp-plugin-hint{font-size:0.68rem;color:#94a3b8;line-height:1.35;margin-bottom:8px;}' +
        '.irp-realm-grid{display:grid;grid-template-columns:1fr;gap:7px;margin-bottom:8px;}' +
        '.irp-realm-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}' +
        '.irp-realm-input,.irp-realm-select{min-width:0;flex:1 1 220px;padding:8px;border-radius:6px;' +
        'border:1px solid #3b3b5d;background:#111122;color:#f8f8f2;font:inherit;font-size:0.76rem;}' +
        '.irp-realm-label{font-size:0.72rem;color:#c4b5fd;font-weight:bold;min-width:92px;}' +
        '.irp-log{flex:1;min-height:0;background:#0a0a14;color:#6ddc8e;' +
        'border:1px solid #333;border-radius:6px;padding:8px;' +
        'font-family:ui-monospace,monospace;font-size:11px;line-height:1.4;' +
        'white-space:pre-wrap;word-break:break-all;overflow-y:auto;' +
        'box-sizing:border-box;user-select:text;-webkit-user-select:text;' +
        '-webkit-touch-callout:default;}' +
        '.irp-content.storage-mode .irp-log{flex:0 0 118px;max-height:118px;}' +
        '.irp-content.storage-mode #'+ PANEL_ID + '-repair-actions{display:none!important;}' +
        '.irp-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;}' +
        '.irp-btn{flex:1 1 100px;padding:10px 6px;border:none;border-radius:6px;' +
        'font-size:0.82rem;font-weight:bold;cursor:pointer;font-family:inherit;}' +
        '.irp-btn-title{display:block;line-height:1.2;}' +
        '.irp-btn-hint{display:block;margin-top:4px;font-size:0.68rem;font-weight:500;' +
        'line-height:1.2;opacity:0.78;}' +
        '.irp-btn[disabled]{opacity:0.4;cursor:not-allowed;}' +
        '.irp-btn-scan{background:#00d4ff;color:#1a1a2e;}' +
        '.irp-btn-apply{background:#50fa7b;color:#1a1a2e;}' +
        '.irp-btn-remap{background:#a78bfa;color:#1a1a2e;}' +
        '.irp-btn-fill{background:#38bdf8;color:#101021;}' +
        '.irp-btn-cache{background:#ff5555;color:#fff;}' +
        '.irp-btn-copy{background:#ffb86c;color:#1a1a2e;}' +
        '.irp-btn-close{background:#6272a4;color:#fff;}' +
        '.' + BTN_CLASS + '{background:none;border:none;cursor:pointer;color:inherit;' +
        'padding:0;margin:0 6px 0 0;line-height:0;display:inline-flex;align-items:center;' +
        'vertical-align:middle;}' +
        '.' + BTN_CLASS + ':hover{color:#22d3ee;}' +
        '.' + BTN_CLASS + ' svg{width:24px;height:24px;}' +
        '.' + REALM_CLASS + '{transition:color .15s ease,opacity .15s ease;}' +
        '.' + REALM_CLASS + '[data-realm-state="checking"]{color:#f59e0b;opacity:.8;}' +
        '.' + REALM_CLASS + '[data-realm-state="found"]{color:#22c55e;}' +
        '.' + REALM_CLASS + '[data-realm-state="missing"]{color:#ef4444;}';
    document.head.appendChild(style);
}

function makePanel() {
    if ($id(PANEL_ID)) return;
    const ov = document.createElement('div');
    ov.id = PANEL_ID;
    ov.innerHTML =
        '<div class="irp-box">' +
        '<div class="irp-head">' +
        '<div class="irp-head-main">' +
        '<h2 class="irp-title">에셋 캐시 리매핑</h2>' +
        '<p class="irp-sub" id="' + PANEL_ID + '-sub">대상: -</p>' +
        '</div>' +
        '<div class="irp-store">' +
        '<div class="irp-store-title"><span>에셋저장소</span><select class="irp-store-mode" id="' + PANEL_ID + '-mode" title="저장소 환경 선택">' +
        '<option value="web">웹리스</option>' +
        '<option value="local">로컬리스(비검증)</option>' +
        '<option value="pocket">포켓리스 서버</option>' +
        '</select></div>' +
        '<div class="irp-store-row">' +
        '<button class="irp-store-btn" id="' + PANEL_ID + '-folder">폴더 열기</button>' +
        '<button class="irp-store-btn" id="' + PANEL_ID + '-files">파일 변경</button>' +
        '</div>' +
        '<div class="irp-store-note" id="' + PANEL_ID + '-store-note">저장소 확인 중...</div>' +
        '</div>' +
        '</div>' +
        '<div class="irp-main">' +
        '<div class="irp-tabs">' +
        '<button class="irp-tab active" id="' + PANEL_ID + '-tab-current">현재 캐릭터<br>진단</button>' +
        '<button class="irp-tab" id="' + PANEL_ID + '-tab-all">전체 캐릭터<br>진단</button>' +
        '<button class="irp-tab" id="' + PANEL_ID + '-tab-realm">없는 에셋<br>가져오기</button>' +
        '<button class="irp-tab" id="' + PANEL_ID + '-tab-storage">저장소<br>뷰어</button>' +
        '<button class="irp-tab" id="' + PANEL_ID + '-tab-plugin-storage">플러그인<br>저장소</button>' +
        '<button class="irp-tab" id="' + PANEL_ID + '-tab-lorebook">로어북<br>진단</button>' +
        '</div>' +
        '<div class="irp-content">' +
        '<div class="irp-status" id="' + PANEL_ID + '-status">대기 중</div>' +
        '<div class="irp-progress"><div class="irp-bar" id="' + PANEL_ID + '-bar"></div></div>' +
        '<div class="irp-page visible" id="' + PANEL_ID + '-page-current">' +
        '<div class="irp-page-note">현재 열려 있는 캐릭터나 모듈 추가에셋만 진단합니다. 빠르게 문제 참조와 확장자 통일 후보를 확인할 때 사용합니다.</div>' +
        '<div class="irp-actions">' +
        '<button class="irp-btn irp-btn-scan" id="' + PANEL_ID + '-scan">🔍 현재 캐릭터 진단</button>' +
        '</div>' +
        '</div>' +
        '<div class="irp-page" id="' + PANEL_ID + '-page-all">' +
        '<div class="irp-page-note">캐릭터와 선택한 모듈의 참조를 검사합니다. 휴지통은 기본 제외이며, 진단만으로 원본을 다운로드하거나 캐시를 채우지 않습니다.</div>' +
        '<div class="irp-page-note"><label><input type="checkbox" id="' + PANEL_ID + '-include-modules" checked> 모듈 포함</label> · ' +
        '<label><input type="checkbox" id="' + PANEL_ID + '-include-trash"> 휴지통 포함</label></div>' +
        '<div class="irp-actions">' +
        '<button class="irp-btn irp-btn-scan" id="' + PANEL_ID + '-scanall">🌐 전체 캐릭터·모듈 진단</button>' +
        '</div>' +
        '</div>' +
        '<div class="irp-page" id="' + PANEL_ID + '-page-realm">' +
        '<div class="irp-page-note">현재 봇의 정상 에셋과 채팅·프롬프트는 건드리지 않고, 실제 바이트가 사라진 프로필·감정·추가 에셋 참조만 복구합니다. 렐름 카드 또는 이미 임포트된 새 버전 봇을 원본으로 쓸 수 있습니다.</div>' +
        '<div class="irp-realm-grid">' +
        '<div class="irp-realm-row"><span class="irp-realm-label">Realm ID</span><input class="irp-realm-input" id="' + PANEL_ID + '-realm-id" placeholder="자동 감지 또는 후보 검색"></div>' +
        '<div class="irp-realm-row"><span class="irp-realm-label">렐름 후보</span><select class="irp-realm-select" id="' + PANEL_ID + '-realm-candidates"><option value="">후보 검색 전</option></select></div>' +
        '<div class="irp-realm-row"><span class="irp-realm-label">임포트 원본</span><select class="irp-realm-select" id="' + PANEL_ID + '-local-source"><option value="">새 버전 봇 선택</option></select></div>' +
        '</div>' +
        '<div class="irp-actions">' +
        '<button class="irp-btn irp-btn-scan" id="' + PANEL_ID + '-realm-search">렐름 후보 찾기</button>' +
        '<button class="irp-btn irp-btn-apply" id="' + PANEL_ID + '-realm-recover">렐름에서 없는 에셋 가져오기</button>' +
        '<button class="irp-btn irp-btn-remap" id="' + PANEL_ID + '-local-recover">임포트된 봇으로 메꾸기</button>' +
        '</div>' +
        '</div>' +
        '<div class="irp-page" id="' + PANEL_ID + '-page-storage">' +
        '<div class="irp-usage" id="' + PANEL_ID + '-usage">' +
        '<div class="irp-usage-title"><strong>저장소 점유</strong><span class="irp-usage-total" id="' + PANEL_ID + '-usage-total">-</span></div>' +
        '<div class="irp-usage-visual">' +
        '<div class="irp-usage-pie" id="' + PANEL_ID + '-usage-pie"><div class="irp-usage-pie-text"><strong id="' + PANEL_ID + '-usage-orphan-pct">0%</strong>고아</div></div>' +
        '<div class="irp-usage-vertical" title="아래 초록: 사용 중 / 위 빨강: 고아 후보">' +
        '<div class="irp-usage-used" id="' + PANEL_ID + '-usage-used"></div><div class="irp-usage-orphan" id="' + PANEL_ID + '-usage-orphan"></div>' +
        '</div>' +
        '</div>' +
        '<div class="irp-usage-legend">' +
        '<span><i class="irp-usage-dot used"></i><span id="' + PANEL_ID + '-usage-used-text">사용 중 -</span></span>' +
        '<span><i class="irp-usage-dot orphan"></i><span id="' + PANEL_ID + '-usage-orphan-text">고아 후보 -</span></span>' +
        '</div>' +
        '<div class="irp-usage-note" id="' + PANEL_ID + '-usage-note">진단 후 표시됩니다.</div>' +
        '<div class="irp-usage-samples" id="' + PANEL_ID + '-usage-samples">저장소 점유 분석을 누르면 고아 후보 샘플이 여기에 표시됩니다.</div>' +
        '</div>' +
        '<div class="irp-actions">' +
        '<button class="irp-btn irp-btn-scan" id="' + PANEL_ID + '-storage-scan">📊 저장소 점유 분석</button>' +
        '</div>' +
        '</div>' +
        '<div class="irp-page" id="' + PANEL_ID + '-page-plugin-storage">' +
        '<div class="irp-page-note">설치된 플러그인 목록과 저장소 키를 대조해 플러그인 고아 후보를 찾습니다. 고아 후보는 바로 삭제하지 않고 쓰레기통으로 이동해 복원할 수 있습니다.</div>' +
        '<div class="irp-plugin-controls">' +
        '<select class="irp-plugin-select" id="' + PANEL_ID + '-plugin-storage-mode" title="플러그인 저장소 종류">' +
        '<option value="plugin">플러그인 스토리지</option>' +
        '<option value="local">로컬 스토리지</option>' +
        '</select>' +
        '<button class="irp-btn irp-btn-scan" id="' + PANEL_ID + '-plugin-storage-scan">플러그인 고아 분석</button>' +
        '<button class="irp-btn irp-btn-copy" id="' + PANEL_ID + '-plugin-orphan-toggle">고아 후보만 보기</button>' +
        '</div>' +
        '<div class="irp-plugin-controls">' +
        '<button class="irp-btn irp-btn-cache" id="' + PANEL_ID + '-plugin-trash-move" disabled>고아 후보 쓰레기통</button>' +
        '<button class="irp-btn irp-btn-scan" id="' + PANEL_ID + '-plugin-trash-view">쓰레기통 보기</button>' +
        '<button class="irp-btn irp-btn-apply" id="' + PANEL_ID + '-plugin-trash-restore">쓰레기통 복원</button>' +
        '<button class="irp-btn irp-btn-cache" id="' + PANEL_ID + '-plugin-trash-empty">쓰레기통 비우기</button>' +
        '</div>' +
        '<div class="irp-plugin-hint" id="' + PANEL_ID + '-plugin-hint">플러그인 스토리지는 세이브 내부 pluginCustomStorage, 로컬 스토리지는 safeLocalStorage 기준입니다.</div>' +
        '<div class="irp-usage" id="' + PANEL_ID + '-plugin-usage">' +
        '<div class="irp-usage-title"><strong>플러그인 저장소</strong><span class="irp-usage-total" id="' + PANEL_ID + '-plugin-usage-total">-</span></div>' +
        '<div class="irp-usage-visual">' +
        '<div class="irp-usage-pie" id="' + PANEL_ID + '-plugin-usage-pie"><div class="irp-usage-pie-text"><strong id="' + PANEL_ID + '-plugin-usage-orphan-pct">0%</strong>고아</div></div>' +
        '<div class="irp-usage-vertical" title="아래 초록: 설치 플러그인 매칭 / 위 빨강: 고아 후보">' +
        '<div class="irp-usage-used" id="' + PANEL_ID + '-plugin-usage-used"></div><div class="irp-usage-orphan" id="' + PANEL_ID + '-plugin-usage-orphan"></div>' +
        '</div>' +
        '</div>' +
        '<div class="irp-usage-legend">' +
        '<span><i class="irp-usage-dot used"></i><span id="' + PANEL_ID + '-plugin-usage-used-text">고아 아님 -</span></span>' +
        '<span><i class="irp-usage-dot orphan"></i><span id="' + PANEL_ID + '-plugin-usage-orphan-text">고아 후보 -</span></span>' +
        '</div>' +
        '<div class="irp-usage-note" id="' + PANEL_ID + '-plugin-usage-note">분석 후 표시됩니다.</div>' +
        '<div class="irp-usage-samples" id="' + PANEL_ID + '-plugin-usage-samples">플러그인 고아 분석을 누르면 후보 샘플이 여기에 표시됩니다.</div>' +
        '</div>' +
        '</div>' +
        '<div class="irp-page" id="' + PANEL_ID + '-page-lorebook">' +
        '<div class="irp-page-note">캐릭터와 모듈의 로어북 항목을 검사해 빈 항목, 트리거 없는 항목, 중복, 깨진 폴더 참조 후보를 찾습니다. 이 탭은 아직 진단 전용이며 삭제하지 않습니다.</div>' +
        '<div class="irp-usage" id="' + PANEL_ID + '-lorebook-usage">' +
        '<div class="irp-usage-title"><strong>로어북 후보</strong><span class="irp-usage-total" id="' + PANEL_ID + '-lorebook-usage-total">-</span></div>' +
        '<div class="irp-usage-visual">' +
        '<div class="irp-usage-pie" id="' + PANEL_ID + '-lorebook-usage-pie"><div class="irp-usage-pie-text"><strong id="' + PANEL_ID + '-lorebook-usage-candidate-pct">0%</strong>후보</div></div>' +
        '<div class="irp-usage-vertical" title="아래 초록: 일반/보존 / 위 빨강: 정리 후보">' +
        '<div class="irp-usage-used" id="' + PANEL_ID + '-lorebook-usage-used"></div><div class="irp-usage-orphan" id="' + PANEL_ID + '-lorebook-usage-candidate"></div>' +
        '</div>' +
        '</div>' +
        '<div class="irp-usage-legend">' +
        '<span><i class="irp-usage-dot used"></i><span id="' + PANEL_ID + '-lorebook-usage-used-text">일반/보존 -</span></span>' +
        '<span><i class="irp-usage-dot orphan"></i><span id="' + PANEL_ID + '-lorebook-usage-candidate-text">후보 -</span></span>' +
        '</div>' +
        '<div class="irp-usage-note" id="' + PANEL_ID + '-lorebook-usage-note">진단 후 표시됩니다.</div>' +
        '<div class="irp-usage-samples" id="' + PANEL_ID + '-lorebook-usage-samples">로어북 고아 진단을 누르면 후보 샘플이 여기에 표시됩니다.</div>' +
        '</div>' +
        '<div class="irp-actions">' +
        '<button class="irp-btn irp-btn-scan" id="' + PANEL_ID + '-lorebook-scan">로어북 고아 진단</button>' +
        '</div>' +
        '</div>' +
        '<div class="irp-log" id="' + PANEL_ID + '-log"></div>' +
        '<div class="irp-actions" id="' + PANEL_ID + '-repair-actions">' +
        '<button class="irp-btn irp-btn-apply" id="' + PANEL_ID + '-apply" disabled>🔧 확장자 통일</button>' +
        '<button class="irp-btn irp-btn-fill" id="' + PANEL_ID + '-fill" disabled><span class="irp-btn-title">누락 캐시 보충</span><span class="irp-btn-hint">원본 있음 · 캐시 없음</span></button>' +
        '<button class="irp-btn irp-btn-remap" id="' + PANEL_ID + '-remap" disabled><span class="irp-btn-title">🗺️ 캐시 덮어쓰기</span><span class="irp-btn-hint">원본 있음 · 캐시 이상</span></button>' +
        '<button class="irp-btn irp-btn-cache" id="' + PANEL_ID + '-cache" disabled>🧹 캐시 청소 (위험)</button>' +
        '</div>' +
        '<div class="irp-actions">' +
        '<button class="irp-btn irp-btn-copy" id="' + PANEL_ID + '-copy">📋 로그 복사</button>' +
        '<button class="irp-btn irp-btn-close" id="' + PANEL_ID + '-close">닫기</button>' +
        '</div>' +
        '</div>' +
        '</div></div>';
    document.body.appendChild(ov);

    $id(PANEL_ID + '-scan').addEventListener('click', () => runCharScan('current'));
    $id(PANEL_ID + '-scanall').addEventListener('click', requestAllCharacterScan);
    $id(PANEL_ID + '-tab-current').addEventListener('click', () => switchPanelPage('current'));
    $id(PANEL_ID + '-tab-all').addEventListener('click', () => switchPanelPage('all'));
    $id(PANEL_ID + '-tab-realm').addEventListener('click', () => switchPanelPage('realm'));
    $id(PANEL_ID + '-tab-storage').addEventListener('click', () => switchPanelPage('storage'));
    $id(PANEL_ID + '-tab-plugin-storage').addEventListener('click', () => switchPanelPage('plugin-storage'));
    $id(PANEL_ID + '-tab-lorebook').addEventListener('click', () => switchPanelPage('lorebook'));
    $id(PANEL_ID + '-storage-scan').addEventListener('click', runStorageUsageScan);
    $id(PANEL_ID + '-plugin-storage-scan').addEventListener('click', runPluginStorageScan);
    $id(PANEL_ID + '-lorebook-scan').addEventListener('click', runLorebookScan);
    $id(PANEL_ID + '-realm-search').addEventListener('click', runRealmCandidateSearch);
    $id(PANEL_ID + '-realm-recover').addEventListener('click', runRealmAssetRecovery);
    $id(PANEL_ID + '-local-recover').addEventListener('click', runImportedBotAssetRecovery);
    $id(PANEL_ID + '-realm-candidates').addEventListener('change', selectRealmCandidate);
    $id(PANEL_ID + '-plugin-storage-mode').addEventListener('change', changePluginStorageMode);
    $id(PANEL_ID + '-plugin-orphan-toggle').addEventListener('click', togglePluginStorageOrphanOnly);
    $id(PANEL_ID + '-plugin-trash-move').addEventListener('click', runPluginTrashMove);
    $id(PANEL_ID + '-plugin-trash-view').addEventListener('click', runPluginTrashView);
    $id(PANEL_ID + '-plugin-trash-restore').addEventListener('click', runPluginTrashRestore);
    $id(PANEL_ID + '-plugin-trash-empty').addEventListener('click', runPluginTrashEmpty);
    $id(PANEL_ID + '-apply').addEventListener('click', runCharApply);
    $id(PANEL_ID + '-remap').addEventListener('click', runCharCacheRemap);
    $id(PANEL_ID + '-fill').addEventListener('click', runCharCacheFillMissing);
    $id(PANEL_ID + '-cache').addEventListener('click', runCharCacheClean);
    $id(PANEL_ID + '-mode').addEventListener('change', changeAssetStorageMode);
    $id(PANEL_ID + '-folder').addEventListener('click', openAssetStorageFolder);
    $id(PANEL_ID + '-files').addEventListener('click', changeAssetStorageFiles);
    $id(PANEL_ID + '-copy').addEventListener('click', copyLog);
    $id(PANEL_ID + '-close').addEventListener('click', () => {
        ov.classList.remove('visible');
    });
    initAssetStorageMode();
    clearUsageSummary();
    clearPluginStorageSummary();
    clearLorebookSummary();
    updatePluginStorageUI();
    updateRecoverySourceUI();
}

function switchPanelPage(page) {
    const currentPage = $id(PANEL_ID + '-page-current');
    const allPage = $id(PANEL_ID + '-page-all');
    const realmPage = $id(PANEL_ID + '-page-realm');
    const storagePage = $id(PANEL_ID + '-page-storage');
    const pluginStoragePage = $id(PANEL_ID + '-page-plugin-storage');
    const lorebookPage = $id(PANEL_ID + '-page-lorebook');
    const content = (storagePage || pluginStoragePage || lorebookPage) ? (storagePage || pluginStoragePage || lorebookPage).closest('.irp-content') : null;
    const currentTab = $id(PANEL_ID + '-tab-current');
    const allTab = $id(PANEL_ID + '-tab-all');
    const realmTab = $id(PANEL_ID + '-tab-realm');
    const storageTab = $id(PANEL_ID + '-tab-storage');
    const pluginStorageTab = $id(PANEL_ID + '-tab-plugin-storage');
    const lorebookTab = $id(PANEL_ID + '-tab-lorebook');
    const repairActions = $id(PANEL_ID + '-repair-actions');
    const isStorage = page === 'storage';
    const isPluginStorage = page === 'plugin-storage';
    const isLorebook = page === 'lorebook';
    const isAll = page === 'all';
    const isRealm = page === 'realm';
    if (currentPage) currentPage.classList.toggle('visible', page === 'current');
    if (allPage) allPage.classList.toggle('visible', isAll);
    if (realmPage) realmPage.classList.toggle('visible', isRealm);
    if (storagePage) storagePage.classList.toggle('visible', isStorage);
    if (pluginStoragePage) pluginStoragePage.classList.toggle('visible', isPluginStorage);
    if (lorebookPage) lorebookPage.classList.toggle('visible', isLorebook);
    if (currentTab) currentTab.classList.toggle('active', page === 'current');
    if (allTab) allTab.classList.toggle('active', isAll);
    if (realmTab) realmTab.classList.toggle('active', isRealm);
    if (storageTab) storageTab.classList.toggle('active', isStorage);
    if (pluginStorageTab) pluginStorageTab.classList.toggle('active', isPluginStorage);
    if (lorebookTab) lorebookTab.classList.toggle('active', isLorebook);
    if (repairActions) repairActions.style.display = (isStorage || isPluginStorage || isLorebook || isRealm) ? 'none' : 'flex';
    if (content) content.classList.toggle('storage-mode', isStorage || isPluginStorage || isLorebook);
}

function setSub(text) {
    const el = $id(PANEL_ID + '-sub');
    if (el) el.textContent = '대상: ' + text;
}
function setStoreNote(text) {
    const el = $id(PANEL_ID + '-store-note');
    if (el) el.textContent = text;
}
function updateAssetStorageUI() {
    const modeEl = $id(PANEL_ID + '-mode');
    if (modeEl) modeEl.value = assetStorageMode;
    const folderBtn = $id(PANEL_ID + '-folder');
    const filesBtn = $id(PANEL_ID + '-files');
    const row = folderBtn && folderBtn.parentElement;
    if (filesBtn) {
        filesBtn.style.display = 'none';
        filesBtn.disabled = true;
        filesBtn.title = '아직 실제 리매핑에 연결되지 않아 숨김 처리됨';
    }
    if (assetStorageMode === 'pocket') {
        if (row) row.style.display = 'none';
        setStoreNote('포켓리스: 서버 내부/외부 저장소의 존재 여부만 검사. SW 캐시 누락은 원본 손실이 아닙니다.');
    } else if (assetStorageMode === 'web') {
        if (row) row.style.display = 'none';
        if (folderBtn) folderBtn.style.display = 'none';
        setStoreNote('웹리스: IndexedDB/forage(risuai/keyvaluepairs)를 자동 기준으로 사용');
    } else if (selectedAssetFolder) {
        if (row) row.style.display = 'flex';
        if (folderBtn) folderBtn.style.display = '';
        setStoreNote('로컬리스(비검증): 선택 폴더 - ' + selectedAssetFolder.name + '. 진단/로컬 리매핑/확장자 통일 지원');
    } else if (resolvedLocalAssetDir) {
        if (row) row.style.display = 'flex';
        if (folderBtn) folderBtn.style.display = '';
        setStoreNote('로컬리스(비검증): ' + resolvedLocalAssetDir + '. 진단/로컬 리매핑/확장자 통일 지원');
    } else {
        if (row) row.style.display = 'flex';
        if (folderBtn) folderBtn.style.display = '';
        setStoreNote('로컬리스(비검증) 원본: ' + LOCAL_ASSET_PATH_HINT + '. 진단/로컬 리매핑/확장자 통일 지원');
    }
}
function setStatus(text) {
    const el = $id(PANEL_ID + '-status');
    if (el) el.textContent = text;
}
function setProgress(pct) {
    const bar = $id(PANEL_ID + '-bar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
}
function clearUsageSummary() {
    const used = $id(PANEL_ID + '-usage-used');
    const orphan = $id(PANEL_ID + '-usage-orphan');
    const pie = $id(PANEL_ID + '-usage-pie');
    const orphanPctText = $id(PANEL_ID + '-usage-orphan-pct');
    const totalText = $id(PANEL_ID + '-usage-total');
    const usedText = $id(PANEL_ID + '-usage-used-text');
    const orphanText = $id(PANEL_ID + '-usage-orphan-text');
    const note = $id(PANEL_ID + '-usage-note');
    const samples = $id(PANEL_ID + '-usage-samples');
    if (used) used.style.width = '0%';
    if (orphan) orphan.style.width = '0%';
    if (used) used.style.height = '0%';
    if (orphan) orphan.style.height = '0%';
    if (pie) pie.style.background = 'conic-gradient(#22c55e 0 100%, #ef4444 100% 100%)';
    if (orphanPctText) orphanPctText.textContent = '0%';
    if (totalText) totalText.textContent = '-';
    if (usedText) usedText.textContent = '사용 중 -';
    if (orphanText) orphanText.textContent = '고아 후보 -';
    if (note) note.textContent = '저장소 점유 분석을 누르거나 진단을 실행하면 표시됩니다.';
    if (samples) samples.textContent = '저장소 점유 분석을 누르면 고아 후보 샘플이 여기에 표시됩니다.';
}
function renderUsageSummary(summary) {
    const panel = $id(PANEL_ID + '-usage');
    if (!panel || !summary) return;
    const total = Math.max(1, summary.totalAssetKeys || 0);
    const usedPct = ((summary.usedAssetKeys || 0) / total) * 100;
    const orphanPct = ((summary.orphanAssetKeys || 0) / total) * 100;
    const used = $id(PANEL_ID + '-usage-used');
    const orphan = $id(PANEL_ID + '-usage-orphan');
    const pie = $id(PANEL_ID + '-usage-pie');
    const orphanPctText = $id(PANEL_ID + '-usage-orphan-pct');
    const totalText = $id(PANEL_ID + '-usage-total');
    const usedText = $id(PANEL_ID + '-usage-used-text');
    const orphanText = $id(PANEL_ID + '-usage-orphan-text');
    const note = $id(PANEL_ID + '-usage-note');
    const samples = $id(PANEL_ID + '-usage-samples');

    if (used) used.style.height = usedPct.toFixed(2) + '%';
    if (orphan) orphan.style.height = orphanPct.toFixed(2) + '%';
    if (pie) {
        pie.style.background = 'conic-gradient(#22c55e 0 ' + usedPct.toFixed(2) + '%, #ef4444 ' + usedPct.toFixed(2) + '% 100%)';
    }
    if (orphanPctText) orphanPctText.textContent = orphanPct.toFixed(1) + '%';
    if (totalText) {
        const usage = summary.storageUsageBytes ? ' · 브라우저 전체 사용량 ' + formatBytes(summary.storageUsageBytes) : '';
        totalText.textContent = summary.totalAssetKeys.toLocaleString() + ' keys' + usage;
    }
    if (usedText) usedText.textContent = '사용 중 ' + summary.usedAssetKeys.toLocaleString() + '개 (' + usedPct.toFixed(1) + '%)';
    if (orphanText) orphanText.textContent = '고아 후보 ' + summary.orphanAssetKeys.toLocaleString() + '개 (' + orphanPct.toFixed(1) + '%)';
    if (note) {
        note.textContent = '색상은 전체 캐릭터+모듈 참조 기준입니다. 개별 파일 바이트를 전부 읽지 않으므로 막대는 용량이 아니라 키 개수 기준이며, 전체 사용량은 브라우저/앱 저장소 추정치입니다.';
    }
    if (samples) {
        if (summary.orphanKeys && summary.orphanKeys.length > 0) {
            samples.textContent = '고아 후보 샘플 (최대 50)\n' + summary.orphanKeys.slice(0, 50).join('\n');
        } else {
            samples.textContent = '고아 후보가 없습니다.';
        }
    }
}

function clearLorebookSummary() {
    currentLorebookSummary = null;
    const used = $id(PANEL_ID + '-lorebook-usage-used');
    const candidate = $id(PANEL_ID + '-lorebook-usage-candidate');
    const pie = $id(PANEL_ID + '-lorebook-usage-pie');
    const pct = $id(PANEL_ID + '-lorebook-usage-candidate-pct');
    const total = $id(PANEL_ID + '-lorebook-usage-total');
    const usedText = $id(PANEL_ID + '-lorebook-usage-used-text');
    const candidateText = $id(PANEL_ID + '-lorebook-usage-candidate-text');
    const note = $id(PANEL_ID + '-lorebook-usage-note');
    const samples = $id(PANEL_ID + '-lorebook-usage-samples');
    if (used) used.style.height = '0%';
    if (candidate) candidate.style.height = '0%';
    if (pie) pie.style.background = 'conic-gradient(#22c55e 0 100%, #ef4444 100% 100%)';
    if (pct) pct.textContent = '0%';
    if (total) total.textContent = '-';
    if (usedText) usedText.textContent = '일반/보존 -';
    if (candidateText) candidateText.textContent = '후보 -';
    if (note) note.textContent = '진단 후 표시됩니다.';
    if (samples) samples.textContent = '로어북 고아 진단을 누르면 후보 샘플이 여기에 표시됩니다.';
}

function renderLorebookSummary(summary) {
    currentLorebookSummary = summary;
    if (!summary) return;
    const total = Math.max(1, summary.totalEntries || 0);
    const rawCandidatePct = ((summary.findings.length || 0) / total) * 100;
    const candidatePct = Math.min(100, rawCandidatePct);
    const usedPct = Math.max(0, 100 - candidatePct);
    const used = $id(PANEL_ID + '-lorebook-usage-used');
    const candidate = $id(PANEL_ID + '-lorebook-usage-candidate');
    const pie = $id(PANEL_ID + '-lorebook-usage-pie');
    const pct = $id(PANEL_ID + '-lorebook-usage-candidate-pct');
    const totalText = $id(PANEL_ID + '-lorebook-usage-total');
    const usedText = $id(PANEL_ID + '-lorebook-usage-used-text');
    const candidateText = $id(PANEL_ID + '-lorebook-usage-candidate-text');
    const note = $id(PANEL_ID + '-lorebook-usage-note');
    const samples = $id(PANEL_ID + '-lorebook-usage-samples');

    if (used) used.style.height = usedPct.toFixed(2) + '%';
    if (candidate) candidate.style.height = candidatePct.toFixed(2) + '%';
    if (pie) {
        pie.style.background = 'conic-gradient(#22c55e 0 ' + usedPct.toFixed(2) + '%, #ef4444 ' + usedPct.toFixed(2) + '% 100%)';
    }
    if (pct) pct.textContent = candidatePct.toFixed(1) + '%';
    if (totalText) totalText.textContent = summary.totalEntries.toLocaleString() + ' entries · 소유자 ' + summary.totalOwners.toLocaleString() + '개';
    if (usedText) usedText.textContent = '일반/보존 ' + summary.nonCandidateEntries.toLocaleString() + '개 (' + usedPct.toFixed(1) + '%)';
    if (candidateText) candidateText.textContent = '후보 ' + summary.findings.length.toLocaleString() + '개 (' + candidatePct.toFixed(1) + '%)';
    if (note) {
        note.textContent = '빈 항목 ' + summary.counts.empty +
            '개, 트리거 없음 ' + summary.counts.inactiveNoTrigger +
            '개, 중복 ' + summary.counts.duplicate +
            '개, 깨진 폴더 ' + summary.counts.brokenFolder +
            '개, 비활성 ' + summary.counts.disabled + '개.';
    }
    if (samples) {
        if (summary.findings.length === 0) {
            samples.textContent = '후보가 없습니다.';
        } else {
            samples.textContent = '로어북 후보 샘플 (최대 80)\n' + summary.findings.slice(0, 80).map(formatLorebookFinding).join('\n\n');
        }
    }
}

function formatLorebookFinding(finding) {
    const title = finding.title ? ' · ' + finding.title : '';
    const extra = finding.detail ? '\n  ' + finding.detail : '';
    return '[' + finding.kindLabel + '] ' + finding.ownerType + ': ' + finding.ownerName +
        ' · ' + finding.path + title + extra;
}

function loreToArray(value) {
    if (Array.isArray(value)) return value;
    return [];
}

function loreGetAtPath(value, parts) {
    let current = value;
    for (const part of parts) {
        if (!current || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return current;
}

function lorePathLabel(parts) {
    return parts.join('.');
}

function loreLooksLikeEntry(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value) && (
        'content' in value ||
        'key' in value ||
        'keys' in value ||
        'comment' in value ||
        'name' in value ||
        'alwaysActive' in value ||
        'constant' in value ||
        'selective' in value ||
        'insertorder' in value ||
        'insertion_order' in value ||
        'mode' in value
    ));
}

function loreLooksLikeArray(value) {
    if (!Array.isArray(value) || value.length === 0) return false;
    let hits = 0;
    const limit = Math.min(value.length, 8);
    for (let i = 0; i < limit; i++) {
        if (loreLooksLikeEntry(value[i])) hits++;
    }
    return hits > 0;
}

function collectLorebookArrays(owner) {
    const arrays = [];
    const seenArrays = typeof WeakSet === 'function' ? new WeakSet() : null;
    const directPaths = [
        ['lorebook'],
        ['loreBook'],
        ['lorebooks'],
        ['character_book', 'entries'],
        ['characterBook', 'entries'],
        ['data', 'character_book', 'entries'],
        ['data', 'characterBook', 'entries'],
        ['worldInfo', 'entries'],
        ['world_info', 'entries']
    ];

    function addArray(pathParts, value) {
        if (!loreLooksLikeArray(value)) return;
        if (seenArrays && seenArrays.has(value)) return;
        if (seenArrays) seenArrays.add(value);
        arrays.push({ path: lorePathLabel(pathParts), entries: value });
    }

    for (const pathParts of directPaths) addArray(pathParts, loreGetAtPath(owner, pathParts));

    const skipKeys = { chats: true, chatFolders: true, coldStoragedChats: true };
    function walk(value, pathParts, depth) {
        if (!value || typeof value !== 'object' || depth > 5) return;
        if (Array.isArray(value)) {
            const pathText = lorePathLabel(pathParts);
            if (/(?:lore|book|world[_-]?info|memory|entries)/i.test(pathText)) addArray(pathParts, value);
            for (let i = 0; i < Math.min(value.length, 20); i++) walk(value[i], pathParts.concat(String(i)), depth + 1);
            return;
        }
        for (const key of Object.keys(value)) {
            if (skipKeys[key]) continue;
            walk(value[key], pathParts.concat(key), depth + 1);
        }
    }
    walk(owner, [], 0);
    return arrays;
}

function loreStringValues() {
    const out = [];
    for (let i = 0; i < arguments.length; i++) {
        const value = arguments[i];
        if (typeof value === 'string') {
            if (value.trim()) out.push(value.trim());
        } else if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === 'string' && item.trim()) out.push(item.trim());
            }
        }
    }
    return out;
}

function loreHasContent(entry) {
    return typeof entry.content === 'string' && entry.content.trim().length > 0;
}

function loreHasKeys(entry) {
    return loreStringValues(entry.keys, entry.key).length > 0;
}

function loreHasSecondaryKeys(entry) {
    return loreStringValues(entry.secondary_keys, entry.secondaryKeys, entry.secondkey).length > 0;
}

function loreAlwaysActive(entry) {
    return entry.constant === true || entry.alwaysActive === true || entry.always_active === true;
}

function loreDisabled(entry) {
    return entry.enabled === false || entry.disable === true || entry.disabled === true || entry.ableFlag === false;
}

function loreFolderEntry(entry) {
    return entry && typeof entry === 'object' && (entry.mode === 'folder' || entry.type === 'folder');
}

function loreEntryTitle(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const direct = loreStringValues(entry.name, entry.comment, entry.memo, entry.title).find(Boolean);
    if (direct) return clipForLog(direct, 90);
    const content = typeof entry.content === 'string' ? entry.content : '';
    const heading = content.match(/^\s*#{1,6}\s+(.+)$/m);
    if (heading && heading[1]) return clipForLog(heading[1], 90);
    return clipForLog((content.split(/\r?\n/).find(line => line.trim().length > 0) || '').trim(), 90);
}

function loreNormalizeText(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function loreStableHash(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash, 31) + value.charCodeAt(i);
    return (hash >>> 0).toString(16);
}

function loreActivation(entry) {
    const labels = [];
    if (loreAlwaysActive(entry)) labels.push('항상 활성');
    labels.push(...loreStringValues(entry.keys, entry.key));
    const normalized = Array.from(new Set(labels.map(loreNormalizeText).filter(Boolean))).sort();
    return {
        key: normalized.join('|'),
        label: Array.from(new Set(labels.map(v => String(v).trim()).filter(Boolean))).join(', ')
    };
}

function loreEntryFolderKey(entry) {
    if (!entry || typeof entry !== 'object') return '';
    return String(entry.key || entry.id || '').trim();
}

function loreFolderRef(entry) {
    if (!entry || typeof entry !== 'object') return '';
    return String(entry.folder || entry.folderId || entry.folderID || '').trim();
}

function loreInsertOrder(entry) {
    const n = Number(entry && (entry.insertorder ?? entry.insertion_order ?? entry.insertionOrder));
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function collectLoreOwners() {
    const owners = [];
    const chars = getAllCharacters();
    const modules = getAllModules();
    for (let i = 0; i < chars.length; i++) {
        const item = chars[i];
        if (!item) continue;
        owners.push({ type: '캐릭터', name: item.name || item.nickname || ('캐릭터 #' + (i + 1)), value: item });
    }
    for (let i = 0; i < modules.length; i++) {
        const item = modules[i];
        if (!item) continue;
        owners.push({ type: '모듈', name: item.name || item.displayName || ('모듈 #' + (i + 1)), value: item });
    }
    return owners;
}

function addLoreFinding(out, finding) {
    out.findings.push(finding);
    out.counts[finding.kind] = (out.counts[finding.kind] || 0) + 1;
}

function analyzeLorebookArray(out, owner, arrayInfo) {
    const entries = loreToArray(arrayInfo.entries);
    const folderKeys = new Set();
    const duplicateRefs = [];
    out.totalEntries += entries.length;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (loreFolderEntry(entry)) {
            const key = loreEntryFolderKey(entry);
            if (key) folderKeys.add(key);
            out.folderEntries++;
        }
    }

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const path = arrayInfo.path + '[' + i + ']';
        if (!entry || typeof entry !== 'object') {
            addLoreFinding(out, {
                kind: 'invalid',
                kindLabel: '비정상 항목',
                ownerType: owner.type,
                ownerName: owner.name,
                path,
                title: '',
                detail: '로어북 항목이 객체가 아닙니다.'
            });
            continue;
        }
        if (loreFolderEntry(entry)) continue;

        const title = loreEntryTitle(entry);
        const content = loreHasContent(entry);
        const keys = loreHasKeys(entry);
        const secondary = loreHasSecondaryKeys(entry);
        const always = loreAlwaysActive(entry);
        const disabled = loreDisabled(entry);
        const folderRef = loreFolderRef(entry);

        if (!always && !content && !keys && !secondary) {
            addLoreFinding(out, {
                kind: 'empty',
                kindLabel: '빈/구분선 후보',
                ownerType: owner.type,
                ownerName: owner.name,
                path,
                title,
                detail: '내용, 호출 키, 보조 키가 모두 비어 있습니다.'
            });
        } else if (!always && content && !keys) {
            addLoreFinding(out, {
                kind: 'inactiveNoTrigger',
                kindLabel: '트리거 없음',
                ownerType: owner.type,
                ownerName: owner.name,
                path,
                title,
                detail: '내용은 있지만 항상 활성/호출 키가 없어 호출되지 않을 수 있습니다.'
            });
        }

        if (disabled) {
            addLoreFinding(out, {
                kind: 'disabled',
                kindLabel: '비활성 보존',
                ownerType: owner.type,
                ownerName: owner.name,
                path,
                title,
                detail: '비활성 항목입니다. 의도적 보관일 수 있어 자동 삭제 대상이 아닙니다.'
            });
        }

        if (folderRef && !folderKeys.has(folderRef)) {
            addLoreFinding(out, {
                kind: 'brokenFolder',
                kindLabel: '깨진 폴더 참조',
                ownerType: owner.type,
                ownerName: owner.name,
                path,
                title,
                detail: 'folder=' + folderRef + ' 를 가리키지만 같은 로어북 안의 폴더 항목을 찾지 못했습니다.'
            });
        }

        const activation = loreActivation(entry);
        if (activation.key) {
            duplicateRefs.push({
                owner,
                arrayPath: arrayInfo.path,
                index: i,
                path,
                entry,
                title,
                titleKey: loreNormalizeText(title),
                contentKey: loreNormalizeText(typeof entry.content === 'string' ? entry.content : ''),
                activationKey: activation.key,
                activationLabel: activation.label,
                brokenFolder: !!(folderRef && !folderKeys.has(folderRef)),
                insertOrder: loreInsertOrder(entry)
            });
        }
    }

    addLoreDuplicateFindings(out, duplicateRefs);
}

function addLoreDuplicateFindings(out, refs) {
    const seenGroups = new Set();
    const byContent = new Map();
    const byTitle = new Map();
    for (const ref of refs) {
        if (ref.contentKey && ref.contentKey.length >= 20) {
            const key = ref.activationKey + '|content:' + loreStableHash(ref.contentKey);
            const group = byContent.get(key) || [];
            group.push(ref);
            byContent.set(key, group);
        }
        if (ref.titleKey) {
            const key = ref.activationKey + '|title:' + ref.titleKey;
            const group = byTitle.get(key) || [];
            group.push(ref);
            byTitle.set(key, group);
        }
    }
    for (const group of byContent.values()) {
        if (group.length < 2) continue;
        seenGroups.add(loreDuplicateSignature(group));
        addLoreDuplicateGroup(out, group, '같은 호출 조건과 같은 내용입니다.');
    }
    for (const group of byTitle.values()) {
        if (group.length < 2) continue;
        if (seenGroups.has(loreDuplicateSignature(group))) continue;
        addLoreDuplicateGroup(out, group, '같은 호출 조건과 같은 이름입니다.');
    }
}

function loreDuplicateSignature(group) {
    return group.map(ref => ref.path).sort().join('|');
}

function addLoreDuplicateGroup(out, group, reason) {
    const sorted = group.slice().sort((a, b) => {
        if (a.brokenFolder !== b.brokenFolder) return a.brokenFolder ? 1 : -1;
        if (a.insertOrder !== b.insertOrder) return a.insertOrder - b.insertOrder;
        return a.index - b.index;
    });
    const survivor = sorted[0];
    for (const ref of sorted.slice(1)) {
        addLoreFinding(out, {
            kind: 'duplicate',
            kindLabel: '중복 후보',
            ownerType: ref.owner.type,
            ownerName: ref.owner.name,
            path: ref.path,
            title: ref.title || ref.activationLabel,
            detail: reason + ' 기준 후보: ' + survivor.path
        });
    }
}

function collectLorebookExtensionFindings(out, owner) {
    const roots = [
        { path: 'extensions', value: owner.value && owner.value.extensions },
        { path: 'data.extensions', value: owner.value && owner.value.data && owner.value.data.extensions }
    ];
    for (const root of roots) {
        walkLoreExtensionValue(out, owner, root.value, root.path, 0);
    }
}

function walkLoreExtensionValue(out, owner, value, path, depth) {
    if (!value || typeof value !== 'object' || depth > 5) return;
    const pathLooksLore = /(?:lore|book|world[_-]?info|memory|entries)/i.test(path);
    if (pathLooksLore && (loreLooksLikeArray(value) || loreLooksLikeEntry(value) ||
        (value && typeof value === 'object' && (Array.isArray(value.entries) || Array.isArray(value.lorebooks) || Array.isArray(value.worldInfos))))) {
        addLoreFinding(out, {
            kind: 'extensionLike',
            kindLabel: '확장 데이터',
            ownerType: owner.type,
            ownerName: owner.name,
            path,
            title: '',
            detail: 'extensions 안에 로어북처럼 보이는 데이터가 있습니다. 호환성 데이터일 수 있어 자동 삭제 금지.'
        });
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < Math.min(value.length, 30); i++) walkLoreExtensionValue(out, owner, value[i], path + '[' + i + ']', depth + 1);
        return;
    }
    for (const key of Object.keys(value)) {
        walkLoreExtensionValue(out, owner, value[key], path + '.' + key, depth + 1);
    }
}

function buildLorebookSummary() {
    const owners = collectLoreOwners();
    const out = {
        totalOwners: owners.length,
        totalEntries: 0,
        folderEntries: 0,
        arrays: 0,
        findings: [],
        counts: {
            invalid: 0,
            empty: 0,
            inactiveNoTrigger: 0,
            disabled: 0,
            brokenFolder: 0,
            duplicate: 0,
            extensionLike: 0
        },
        nonCandidateEntries: 0
    };

    for (let i = 0; i < owners.length; i++) {
        const owner = owners[i];
        const arrays = collectLorebookArrays(owner.value);
        out.arrays += arrays.length;
        for (const arrayInfo of arrays) analyzeLorebookArray(out, owner, arrayInfo);
        collectLorebookExtensionFindings(out, owner);
        if (owners.length > 0 && i % 20 === 0) {
            setProgress(10 + Math.floor((i / owners.length) * 80));
        }
    }
    out.nonCandidateEntries = Math.max(0, out.totalEntries - out.findings.length);
    return out;
}

async function runLorebookScan() {
    if (isRunning) return;
    setRunning(true);
    clearLog();
    clearLorebookSummary();
    switchPanelPage('lorebook');
    setProgress(0);
    setStatus('로어북 고아 진단 중...');

    try {
        log('=== 로어북 고아 진단 ===');
        log('대상: 전체 캐릭터 + 전체 모듈');
        log('주의: 이 기능은 진단 전용입니다. 삭제/수정하지 않습니다.');
        setProgress(8);
        const summary = buildLorebookSummary();
        renderLorebookSummary(summary);
        setProgress(100);
        setStatus('로어북 진단 완료');

        log('');
        log('--- 요약 ---');
        log('  소유자: ' + summary.totalOwners);
        log('  로어북 배열: ' + summary.arrays);
        log('  로어북 항목: ' + summary.totalEntries);
        log('  폴더 항목: ' + summary.folderEntries);
        log('  후보 총합: ' + summary.findings.length);
        log('  빈/구분선 후보: ' + summary.counts.empty);
        log('  트리거 없음: ' + summary.counts.inactiveNoTrigger);
        log('  비활성 보존: ' + summary.counts.disabled);
        log('  깨진 폴더 참조: ' + summary.counts.brokenFolder);
        log('  중복 후보: ' + summary.counts.duplicate);
        log('  확장 데이터 후보: ' + summary.counts.extensionLike);

        if (summary.findings.length > 0) {
            log('');
            log('--- 후보 샘플 (최대 40, 정상 항목은 출력하지 않음) ---');
            for (const finding of summary.findings.slice(0, 40)) {
                log(formatLorebookFinding(finding).replace(/\n/g, ' / '));
            }
            if (summary.findings.length > 40) log('... 외 ' + (summary.findings.length - 40) + '개');
        } else {
            log('후보 없음');
        }
        log('');
        log('다음 단계에서 필요하면 로어북 쓰레기통 이동/복원 기능을 별도로 붙일 수 있습니다.');
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        setRunning(false);
    }
}

function createEmptyPluginInventory() {
    return {
        loaded: false,
        error: '',
        plugins: [],
        exactKeys: new Map(),
        rules: []
    };
}

function pluginStorageModeLabel(mode) {
    if (mode === 'local') return '로컬 스토리지';
    return '플러그인 스토리지';
}

function pluginStorageModeDesc(mode) {
    if (mode === 'local') return 'safeLocalStorage 기준입니다. 기기 로컬 데이터라 환경마다 다를 수 있습니다.';
    return '세이브 내부 pluginCustomStorage 기준입니다. 세이브 파일과 함께 이동하는 플러그인 데이터입니다.';
}

function pluginValueToString(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    try { return JSON.stringify(value); }
    catch (e) { return String(value); }
}

function normalizePluginToken(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '');
}

function looksLikePluginStorageKey(value) {
    const text = String(value || '').trim();
    if (text.length < 2 || text.length > 180) return false;
    if (/\s/.test(text)) return false;
    if (/[<>{}()[\]"']/.test(text)) return false;
    return true;
}

function pluginLabel(plugin) {
    if (!plugin) return '알 수 없음';
    return plugin.displayName || plugin.name || plugin.id || '알 수 없음';
}

function pluginPrimaryKey(plugin, index) {
    return String((plugin && (plugin.name || plugin.id || plugin.displayName)) || ('plugin-' + index));
}

function addExactPluginOwner(key, plugin, reason) {
    if (!looksLikePluginStorageKey(key)) return;
    if (!pluginInventory.exactKeys.has(key)) {
        pluginInventory.exactKeys.set(key, { plugin, reason });
    }
}

function addPluginOwnerRules(plugin) {
    const names = [plugin.name, plugin.displayName, plugin.id].filter(Boolean);
    for (const name of names) {
        const raw = String(name).trim().toLowerCase();
        const norm = normalizePluginToken(name);
        if (raw || norm) pluginInventory.rules.push({ raw, norm, plugin });
    }
}

function collectPluginStorageKeyLiterals(script, plugin) {
    if (typeof script !== 'string' || !script) return;
    const directPattern = /(?:safeLocalStorage|pluginStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*(['"])([^'"\r\n]+)\1/g;
    const constPattern = /\b(?:const|let|var)\s+[$\w]*(?:STORAGE|storage|KEY|key)[$\w]*\s*=\s*(['"])([^'"\r\n]+)\1/g;
    let match = null;
    while ((match = directPattern.exec(script))) addExactPluginOwner(match[2], plugin, 'script-call');
    while ((match = constPattern.exec(script))) addExactPluginOwner(match[2], plugin, 'script-const');
}

async function loadPluginInventory() {
    pluginInventory = createEmptyPluginInventory();
    try {
        if (typeof getDatabase !== 'function') {
            pluginInventory.error = 'getDatabase API 없음';
            return;
        }
        const db = getDatabase();
        const plugins = []
            .concat(Array.isArray(db && db.plugins) ? db.plugins : [])
            .concat(Array.isArray(db && db.pluginV2) ? db.pluginV2 : []);
        const seen = new Set();
        pluginInventory.plugins = plugins.filter((plugin, index) => {
            if (!plugin) return false;
            const key = pluginPrimaryKey(plugin, index);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        for (const plugin of pluginInventory.plugins) {
            addPluginOwnerRules(plugin);
            if (plugin.name) addExactPluginOwner(plugin.name, plugin, 'plugin-name');
            if (plugin.displayName) addExactPluginOwner(plugin.displayName, plugin, 'display-name');
            if (plugin.id) addExactPluginOwner(plugin.id, plugin, 'plugin-id');
            collectPluginStorageKeyLiterals(plugin.script || plugin.code || plugin.content || '', plugin);
        }
        pluginInventory.loaded = true;
    } catch (e) {
        pluginInventory.error = e && e.message ? e.message : String(e);
    }
}

function classifyPluginStorageOwner(key) {
    const keyText = String(key || '');
    const lower = keyText.toLowerCase();

    if (keyText.startsWith(PLUGIN_TRASH_PREFIX)) {
        return { status: 'trash', label: '쓰레기통', orphan: false, reason: 'trash-backup' };
    }

    if (pluginStorageMode === 'local' && lower.startsWith('safety-')) {
        return { status: 'system', label: 'Safety 캐시', orphan: false, reason: 'safety-cache' };
    }

    if (!pluginInventory.loaded) {
        return { status: 'unknown', label: pluginInventory.error || '설치 목록 미확인', orphan: false, reason: 'inventory-missing' };
    }

    const exact = pluginInventory.exactKeys.get(keyText);
    if (exact) {
        return { status: 'installed', label: pluginLabel(exact.plugin), orphan: false, reason: exact.reason };
    }

    for (const rule of pluginInventory.rules) {
        if (!rule.raw) continue;
        if (lower === rule.raw ||
            lower.startsWith(rule.raw + ':') ||
            lower.startsWith(rule.raw + '.') ||
            lower.startsWith(rule.raw + '/') ||
            lower.startsWith(rule.raw + '_') ||
            lower.startsWith(rule.raw + '-')) {
            return { status: 'installed', label: pluginLabel(rule.plugin), orphan: false, reason: 'name-prefix' };
        }
    }

    const normalizedKey = normalizePluginToken(keyText);
    if (normalizedKey.length >= 5) {
        for (const rule of pluginInventory.rules) {
            if (rule.norm && rule.norm.length >= 5 && normalizedKey === rule.norm) {
                return { status: 'installed', label: pluginLabel(rule.plugin), orphan: false, reason: 'name-normalized' };
            }
        }
    }

    return { status: 'orphan', label: '고아 후보', orphan: true, reason: 'no-installed-owner' };
}

function getPluginStorageApi(mode) {
    if (mode === 'local') {
        if (typeof safeLocalStorage !== 'undefined') return safeLocalStorage;
        if (typeof Risuai !== 'undefined' && Risuai && Risuai.safeLocalStorage) return Risuai.safeLocalStorage;
        return null;
    }
    if (typeof pluginStorage !== 'undefined') return pluginStorage;
    if (typeof Risuai !== 'undefined' && Risuai && Risuai.pluginStorage) return Risuai.pluginStorage;
    return null;
}

async function pluginStorageKeysByMode(mode) {
    const api = getPluginStorageApi(mode);
    if (!api) throw new Error(pluginStorageModeLabel(mode) + ' API 없음');
    if (typeof api.keys === 'function') {
        const keys = await api.keys();
        if (Array.isArray(keys)) return keys.map(k => String(k));
    }
    const len = typeof api.length === 'function' ? await api.length() : api.length;
    if (typeof api.key === 'function' && Number.isFinite(Number(len))) {
        const out = [];
        for (let i = 0; i < Number(len); i++) {
            const key = await api.key(i);
            if (key != null) out.push(String(key));
        }
        return out;
    }
    throw new Error(pluginStorageModeLabel(mode) + ' 키 목록 조회 불가');
}

async function pluginStorageGetByMode(mode, key) {
    const api = getPluginStorageApi(mode);
    if (!api || typeof api.getItem !== 'function') throw new Error(pluginStorageModeLabel(mode) + ' 읽기 API 없음');
    return await api.getItem(key);
}

async function pluginStorageSetByMode(mode, key, value) {
    const api = getPluginStorageApi(mode);
    if (!api || typeof api.setItem !== 'function') throw new Error(pluginStorageModeLabel(mode) + ' 쓰기 API 없음');
    return await api.setItem(key, value);
}

async function pluginStorageRemoveByMode(mode, key) {
    const api = getPluginStorageApi(mode);
    if (!api || typeof api.removeItem !== 'function') throw new Error(pluginStorageModeLabel(mode) + ' 삭제 API 없음');
    return await api.removeItem(key);
}

function makePluginTrashKey(mode, originalKey) {
    return PLUGIN_TRASH_PREFIX + mode + ':' + Date.now().toString(36) + ':' + strToHex(String(originalKey || ''));
}

function makePluginTrashPayload(mode, entry) {
    return JSON.stringify({
        version: PLUGIN_TRASH_VERSION,
        tool: 'ImageRecoveryPerChar',
        originalMode: mode,
        originalKey: entry.key,
        movedAt: new Date().toISOString(),
        owner: entry.owner || null,
        size: entry.size || 0,
        value: entry.rawValue,
        valueText: entry.value || ''
    });
}

function parsePluginTrashPayload(trashKey, rawValue) {
    let payload = null;
    if (typeof rawValue === 'string') {
        try { payload = JSON.parse(rawValue); } catch (e) {}
    } else if (rawValue && typeof rawValue === 'object') {
        payload = rawValue;
    }
    if (!payload || typeof payload !== 'object') {
        return {
            trashKey,
            valid: false,
            originalKey: '',
            movedAt: '',
            restoreValue: rawValue,
            note: '쓰레기통 payload 파싱 실패'
        };
    }
    const hasValue = Object.prototype.hasOwnProperty.call(payload, 'value');
    return {
        trashKey,
        valid: true,
        version: payload.version || 0,
        originalMode: payload.originalMode || '',
        originalKey: String(payload.originalKey || ''),
        movedAt: payload.movedAt || '',
        owner: payload.owner || null,
        size: payload.size || 0,
        restoreValue: hasValue ? payload.value : (payload.valueText || ''),
        note: ''
    };
}

async function pluginTrashEntriesByMode(mode) {
    const keys = await pluginStorageKeysByMode(mode);
    const trashKeys = keys.filter(key => String(key).startsWith(PLUGIN_TRASH_PREFIX)).sort((a, b) => a.localeCompare(b));
    const entries = [];
    for (const trashKey of trashKeys) {
        let rawValue = null;
        try {
            rawValue = await pluginStorageGetByMode(mode, trashKey);
        } catch (e) {
            entries.push({
                trashKey,
                valid: false,
                originalKey: '',
                movedAt: '',
                restoreValue: '',
                note: '읽기 실패: ' + (e && e.message ? e.message : e)
            });
            continue;
        }
        entries.push(parsePluginTrashPayload(trashKey, rawValue));
    }
    return entries;
}

function renderPluginTrashEntries(entries) {
    const samples = $id(PANEL_ID + '-plugin-usage-samples');
    if (!samples) return;
    if (!entries || entries.length === 0) {
        samples.textContent = '쓰레기통이 비어 있습니다.';
        return;
    }
    const lines = ['쓰레기통 항목 (최대 50)'];
    for (const entry of entries.slice(0, 50)) {
        const key = entry.originalKey || '(원래 키 확인 불가)';
        const when = entry.movedAt ? (' · ' + entry.movedAt) : '';
        const state = entry.valid ? 'ok' : 'invalid';
        lines.push('[' + state + '] ' + key + when);
    }
    samples.textContent = lines.join('\n');
}

function buildPluginStorageSummary(entries) {
    const orphanEntries = entries.filter(e => e.owner && e.owner.orphan);
    const installedEntries = entries.filter(e => e.owner && e.owner.status === 'installed');
    const systemEntries = entries.filter(e => e.owner && e.owner.status === 'system');
    const unknownEntries = entries.filter(e => e.owner && e.owner.status === 'unknown');
    const trashEntries = entries.filter(e => e.owner && e.owner.status === 'trash');
    const totalBytes = entries.reduce((sum, e) => sum + (e.size || 0), 0);
    return {
        entries,
        totalKeys: entries.length,
        nonOrphanKeys: entries.length - orphanEntries.length,
        orphanKeys: orphanEntries.length,
        installedKeys: installedEntries.length,
        systemKeys: systemEntries.length,
        unknownKeys: unknownEntries.length,
        trashKeys: trashEntries.length,
        totalBytes,
        orphanEntries
    };
}

function clearPluginStorageSummary() {
    currentPluginStorageSummary = null;
    const ids = ['plugin-usage-used', 'plugin-usage-orphan'];
    for (const id of ids) {
        const el = $id(PANEL_ID + '-' + id);
        if (el) el.style.height = '0%';
    }
    const pie = $id(PANEL_ID + '-plugin-usage-pie');
    if (pie) pie.style.background = 'conic-gradient(#22c55e 0 100%, #ef4444 100% 100%)';
    const pct = $id(PANEL_ID + '-plugin-usage-orphan-pct');
    if (pct) pct.textContent = '0%';
    const total = $id(PANEL_ID + '-plugin-usage-total');
    if (total) total.textContent = '-';
    const usedText = $id(PANEL_ID + '-plugin-usage-used-text');
    if (usedText) usedText.textContent = '고아 아님 -';
    const orphanText = $id(PANEL_ID + '-plugin-usage-orphan-text');
    if (orphanText) orphanText.textContent = '고아 후보 -';
    const note = $id(PANEL_ID + '-plugin-usage-note');
    if (note) note.textContent = '분석 후 표시됩니다.';
    const samples = $id(PANEL_ID + '-plugin-usage-samples');
    if (samples) samples.textContent = '플러그인 고아 분석을 누르면 후보 샘플이 여기에 표시됩니다.';
    setBtnEnabled('plugin-trash-move', false);
}

function renderPluginStorageSamples(summary) {
    const samples = $id(PANEL_ID + '-plugin-usage-samples');
    if (!samples || !summary) return;
    const source = pluginStorageOrphanOnly ? summary.orphanEntries : summary.entries;
    if (!source || source.length === 0) {
        samples.textContent = pluginStorageOrphanOnly ? '고아 후보가 없습니다.' : '저장소 키가 없습니다.';
        return;
    }
    const sorted = source.slice().sort((a, b) => {
        const ao = a.owner && a.owner.orphan ? 1 : 0;
        const bo = b.owner && b.owner.orphan ? 1 : 0;
        if (ao !== bo) return bo - ao;
        return (b.size || 0) - (a.size || 0);
    });
    const title = pluginStorageOrphanOnly ? '고아 후보 샘플 (최대 50)' : '저장소 키 샘플 (고아 우선, 최대 50)';
    const lines = [title];
    for (const entry of sorted.slice(0, 50)) {
        const owner = entry.owner || { label: '?', status: 'unknown', reason: '?' };
        lines.push('[' + owner.status + '] ' + entry.key + ' (' + formatBytes(entry.size || 0) + ') · ' + owner.label + ' · ' + owner.reason);
    }
    samples.textContent = lines.join('\n');
}

function renderPluginStorageSummary(summary) {
    currentPluginStorageSummary = summary;
    const total = Math.max(1, summary.totalKeys || 0);
    const nonOrphanPct = ((summary.nonOrphanKeys || 0) / total) * 100;
    const orphanPct = ((summary.orphanKeys || 0) / total) * 100;
    const used = $id(PANEL_ID + '-plugin-usage-used');
    const orphan = $id(PANEL_ID + '-plugin-usage-orphan');
    const pie = $id(PANEL_ID + '-plugin-usage-pie');
    const orphanPctText = $id(PANEL_ID + '-plugin-usage-orphan-pct');
    const totalText = $id(PANEL_ID + '-plugin-usage-total');
    const usedText = $id(PANEL_ID + '-plugin-usage-used-text');
    const orphanText = $id(PANEL_ID + '-plugin-usage-orphan-text');
    const note = $id(PANEL_ID + '-plugin-usage-note');

    if (used) used.style.height = nonOrphanPct.toFixed(2) + '%';
    if (orphan) orphan.style.height = orphanPct.toFixed(2) + '%';
    if (pie) {
        pie.style.background = 'conic-gradient(#22c55e 0 ' + nonOrphanPct.toFixed(2) + '%, #ef4444 ' + nonOrphanPct.toFixed(2) + '% 100%)';
    }
    if (orphanPctText) orphanPctText.textContent = orphanPct.toFixed(1) + '%';
    if (totalText) totalText.textContent = summary.totalKeys.toLocaleString() + ' keys · 약 ' + formatBytes(summary.totalBytes || 0);
    if (usedText) usedText.textContent = '고아 아님 ' + summary.nonOrphanKeys.toLocaleString() + '개 (' + nonOrphanPct.toFixed(1) + '%)';
    if (orphanText) orphanText.textContent = '고아 후보 ' + summary.orphanKeys.toLocaleString() + '개 (' + orphanPct.toFixed(1) + '%)';
    if (note) {
        note.textContent = '설치 매칭 ' + summary.installedKeys.toLocaleString() +
            '개, 시스템 ' + summary.systemKeys.toLocaleString() +
            '개, 미확인 ' + summary.unknownKeys.toLocaleString() +
            '개, 쓰레기통 ' + (summary.trashKeys || 0).toLocaleString() +
            '개. 고아 후보는 삭제 확정이 아니라 설치 목록과 매칭되지 않는 키입니다.';
    }
    renderPluginStorageSamples(summary);
}

function updatePluginStorageUI() {
    const modeEl = $id(PANEL_ID + '-plugin-storage-mode');
    if (modeEl) modeEl.value = pluginStorageMode;
    const hint = $id(PANEL_ID + '-plugin-hint');
    if (hint) hint.textContent = pluginStorageModeDesc(pluginStorageMode);
    const toggle = $id(PANEL_ID + '-plugin-orphan-toggle');
    if (toggle) toggle.textContent = pluginStorageOrphanOnly ? '고아 후보만 보는 중' : '고아 후보만 보기';
}

function changePluginStorageMode() {
    const modeEl = $id(PANEL_ID + '-plugin-storage-mode');
    pluginStorageMode = modeEl && modeEl.value ? modeEl.value : 'plugin';
    updatePluginStorageUI();
    clearPluginStorageSummary();
    log('플러그인 저장소 모드 변경: ' + pluginStorageModeLabel(pluginStorageMode));
}

function togglePluginStorageOrphanOnly() {
    pluginStorageOrphanOnly = !pluginStorageOrphanOnly;
    updatePluginStorageUI();
    if (currentPluginStorageSummary) renderPluginStorageSamples(currentPluginStorageSummary);
}

async function runPluginStorageScan() {
    if (isRunning) return;
    setRunning(true);
    clearLog();
    clearPluginStorageSummary();
    switchPanelPage('plugin-storage');
    setProgress(0);
    setStatus('플러그인 저장소 분석 중...');

    try {
        log('=== 플러그인 저장소 뷰어 ===');
        log('저장소: ' + pluginStorageModeLabel(pluginStorageMode));
        log(pluginStorageModeDesc(pluginStorageMode));
        log('');

        setStatus('설치 플러그인 목록 확인 중...');
        await loadPluginInventory();
        if (pluginInventory.loaded) {
            log('설치 플러그인 목록: ' + pluginInventory.plugins.length + '개');
        } else {
            log('설치 플러그인 목록 미확인: ' + (pluginInventory.error || '알 수 없음'));
            log('이 경우 고아 판정을 확정하지 않고 unknown으로 표시합니다.');
        }
        setProgress(25);

        setStatus(pluginStorageModeLabel(pluginStorageMode) + ' 키 조회 중...');
        const keys = await pluginStorageKeysByMode(pluginStorageMode);
        const sortedKeys = keys.slice().sort((a, b) => a.localeCompare(b));
        log('저장소 키: ' + sortedKeys.length + '개');
        setProgress(45);

        const entries = [];
        for (let i = 0; i < sortedKeys.length; i++) {
            const key = sortedKeys[i];
            let rawValue = null;
            let valueText = '';
            let readError = '';
            try {
                rawValue = await pluginStorageGetByMode(pluginStorageMode, key);
                valueText = pluginValueToString(rawValue);
            } catch (e) {
                readError = e && e.message ? e.message : String(e);
                valueText = '[읽기 실패] ' + readError;
            }
            entries.push({
                key,
                value: valueText,
                rawValue,
                readError,
                size: valueText.length * 2,
                owner: classifyPluginStorageOwner(key)
            });
            if (sortedKeys.length > 0 && i % 20 === 0) {
                setProgress(45 + Math.floor((i / sortedKeys.length) * 45));
            }
        }

        const summary = buildPluginStorageSummary(entries);
        renderPluginStorageSummary(summary);
        setProgress(100);
        setStatus('플러그인 저장소 분석 완료');

        log('');
        log('--- 플러그인 저장소 분석 요약 ---');
        log('  전체 키: ' + summary.totalKeys);
        log('  고아 후보: ' + summary.orphanKeys);
        log('  설치 플러그인 매칭: ' + summary.installedKeys);
        log('  시스템/미확인: ' + (summary.systemKeys + summary.unknownKeys));
        log('  추정 문자열 용량: ' + formatBytes(summary.totalBytes || 0));
        if (summary.orphanEntries.length > 0) {
            log('  고아 후보 샘플 (최대 10):');
            for (const entry of summary.orphanEntries.slice(0, 10)) {
                log('    ' + entry.key + ' (' + formatBytes(entry.size || 0) + ')');
            }
        } else {
            log('  고아 후보 없음');
        }
        log('');
        log('주의: 동적 키를 쓰는 플러그인은 오탐이 있을 수 있습니다. 이 탭은 후보 확인용입니다.');
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        setRunning(false);
    }
}

async function runPluginTrashMove() {
    if (isRunning) return;
    if (!currentPluginStorageSummary || !currentPluginStorageSummary.orphanEntries || currentPluginStorageSummary.orphanEntries.length === 0) {
        setStatus('먼저 플러그인 고아 분석 필요');
        log('먼저 플러그인 고아 분석을 실행하세요.');
        return;
    }

    const candidates = currentPluginStorageSummary.orphanEntries
        .filter(entry => entry && !entry.readError && !String(entry.key || '').startsWith(PLUGIN_TRASH_PREFIX));
    const skippedReadErrors = currentPluginStorageSummary.orphanEntries.length - candidates.length;
    if (candidates.length === 0) {
        setStatus('이동할 고아 후보 없음');
        log('읽기 가능한 고아 후보가 없습니다.');
        return;
    }

    if (!confirm(
        '플러그인 고아 후보 ' + candidates.length + '개를 쓰레기통으로 이동할까요?\n\n' +
        '원래 키는 제거되지만, 쓰레기통에 백업 복사본을 남겨 복원할 수 있습니다.\n' +
        '오탐 가능성이 있으니 문제 없는지 확인한 뒤 나중에 쓰레기통을 비우세요.'
    )) return;

    setRunning(true);
    switchPanelPage('plugin-storage');
    setProgress(0);
    setStatus('고아 후보 쓰레기통 이동 중...');
    log('=== 플러그인 고아 후보 쓰레기통 이동 ===');
    log('저장소: ' + pluginStorageModeLabel(pluginStorageMode));
    log('대상: ' + candidates.length + '개');
    if (skippedReadErrors > 0) log('읽기 실패로 스킵: ' + skippedReadErrors + '개');

    let moved = 0;
    let errors = 0;
    try {
        for (let i = 0; i < candidates.length; i++) {
            const entry = candidates[i];
            const trashKey = makePluginTrashKey(pluginStorageMode, entry.key);
            try {
                await pluginStorageSetByMode(pluginStorageMode, trashKey, makePluginTrashPayload(pluginStorageMode, entry));
                await pluginStorageRemoveByMode(pluginStorageMode, entry.key);
                moved++;
                if (moved <= 20) log('이동: ' + entry.key);
            } catch (e) {
                errors++;
                log('실패: ' + entry.key + ' · ' + (e && e.message ? e.message : e));
            }
            setProgress(Math.floor(((i + 1) / candidates.length) * 100));
        }
        log('');
        log('완료: 이동 ' + moved + '개, 실패 ' + errors + '개');
        log('문제가 생기면 같은 저장소 모드에서 쓰레기통 복원을 누르세요.');
        setStatus('쓰레기통 이동 완료');
        clearPluginStorageSummary();
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        setRunning(false);
    }
}

async function runPluginTrashView() {
    if (isRunning) return;
    setRunning(true);
    switchPanelPage('plugin-storage');
    clearLog();
    setProgress(0);
    setStatus('쓰레기통 조회 중...');
    try {
        log('=== 플러그인 저장소 쓰레기통 ===');
        log('저장소: ' + pluginStorageModeLabel(pluginStorageMode));
        const entries = await pluginTrashEntriesByMode(pluginStorageMode);
        renderPluginTrashEntries(entries);
        setProgress(100);
        setStatus('쓰레기통 조회 완료');
        log('쓰레기통 항목: ' + entries.length + '개');
        for (const entry of entries.slice(0, 30)) {
            log('  ' + (entry.originalKey || entry.trashKey) + (entry.movedAt ? ' · ' + entry.movedAt : ''));
        }
        if (entries.length > 30) log('  ... 외 ' + (entries.length - 30) + '개');
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        setRunning(false);
    }
}

async function runPluginTrashRestore() {
    if (isRunning) return;
    setRunning(true);
    switchPanelPage('plugin-storage');
    clearLog();
    setProgress(0);
    setStatus('쓰레기통 복원 준비 중...');
    try {
        const entries = await pluginTrashEntriesByMode(pluginStorageMode);
        const validEntries = entries.filter(entry => entry.valid && entry.originalKey);
        renderPluginTrashEntries(entries);
        if (validEntries.length === 0) {
            log('복원 가능한 쓰레기통 항목이 없습니다.');
            setStatus('복원 대상 없음');
            return;
        }
        setRunning(false);
        const ok = confirm(
            '쓰레기통 항목 ' + validEntries.length + '개를 원래 키로 복원할까요?\n\n' +
            '이미 같은 원래 키가 다시 생긴 항목은 덮어쓰지 않고 스킵합니다.'
        );
        if (!ok) {
            setStatus('복원 취소');
            return;
        }
        setRunning(true);
        setStatus('쓰레기통 복원 중...');
        log('=== 플러그인 저장소 쓰레기통 복원 ===');
        log('저장소: ' + pluginStorageModeLabel(pluginStorageMode));

        const currentKeys = new Set(await pluginStorageKeysByMode(pluginStorageMode));
        let restored = 0;
        let skipped = 0;
        let errors = 0;
        for (let i = 0; i < validEntries.length; i++) {
            const entry = validEntries[i];
            try {
                if (entry.originalMode && entry.originalMode !== pluginStorageMode) {
                    skipped++;
                    log('스킵(저장소 모드 다름): ' + entry.originalKey);
                } else if (currentKeys.has(entry.originalKey)) {
                    skipped++;
                    log('스킵(원래 키 이미 존재): ' + entry.originalKey);
                } else {
                    await pluginStorageSetByMode(pluginStorageMode, entry.originalKey, entry.restoreValue);
                    await pluginStorageRemoveByMode(pluginStorageMode, entry.trashKey);
                    currentKeys.add(entry.originalKey);
                    currentKeys.delete(entry.trashKey);
                    restored++;
                    if (restored <= 20) log('복원: ' + entry.originalKey);
                }
            } catch (e) {
                errors++;
                log('실패: ' + entry.originalKey + ' · ' + (e && e.message ? e.message : e));
            }
            setProgress(Math.floor(((i + 1) / validEntries.length) * 100));
        }
        log('');
        log('완료: 복원 ' + restored + '개, 스킵 ' + skipped + '개, 실패 ' + errors + '개');
        clearPluginStorageSummary();
        setStatus('쓰레기통 복원 완료');
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        setRunning(false);
    }
}

async function runPluginTrashEmpty() {
    if (isRunning) return;
    setRunning(true);
    switchPanelPage('plugin-storage');
    clearLog();
    setProgress(0);
    setStatus('쓰레기통 비우기 준비 중...');
    try {
        const entries = await pluginTrashEntriesByMode(pluginStorageMode);
        renderPluginTrashEntries(entries);
        if (entries.length === 0) {
            log('쓰레기통이 비어 있습니다.');
            setStatus('쓰레기통 비어 있음');
            return;
        }
        setRunning(false);
        const ok = confirm(
            '위험: 쓰레기통 항목 ' + entries.length + '개를 영구 삭제할까요?\n\n' +
            '이 작업 후에는 플러그인으로 복원할 수 없습니다.'
        );
        if (!ok) {
            setStatus('쓰레기통 비우기 취소');
            return;
        }
        setRunning(true);
        setStatus('쓰레기통 비우는 중...');
        log('=== 플러그인 저장소 쓰레기통 비우기 ===');
        log('저장소: ' + pluginStorageModeLabel(pluginStorageMode));

        let removed = 0;
        let errors = 0;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            try {
                await pluginStorageRemoveByMode(pluginStorageMode, entry.trashKey);
                removed++;
            } catch (e) {
                errors++;
                log('실패: ' + entry.trashKey + ' · ' + (e && e.message ? e.message : e));
            }
            setProgress(Math.floor(((i + 1) / entries.length) * 100));
        }
        log('완료: 영구 삭제 ' + removed + '개, 실패 ' + errors + '개');
        clearPluginStorageSummary();
        renderPluginTrashEntries([]);
        setStatus('쓰레기통 비우기 완료');
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        setRunning(false);
    }
}

function logRaw(line) {
    logBuf.push(line);
    // Large broken collections must not grow the DOM/log buffer forever.
    if (logBuf.length > 1200) {
        logBuf.splice(0, logBuf.length - 1000);
        const target = $id(PANEL_ID + '-log');
        if (target) target.textContent = logBuf.join('\n') + '\n';
        return;
    }
    const el = $id(PANEL_ID + '-log');
    if (el) { el.textContent += line + '\n'; el.scrollTop = el.scrollHeight; }
}
function log(msg) {
    const t = new Date().toLocaleTimeString();
    logRaw('[' + t + '] ' + msg);
}
function clearLog() {
    logBuf = [];
    const el = $id(PANEL_ID + '-log');
    if (el) el.textContent = '';
    clearUsageSummary();
}
function setBtnEnabled(id, enabled) {
    const b = $id(PANEL_ID + '-' + id);
    if (b) b.disabled = !enabled;
}
function setRunning(r) {
    isRunning = r;
    setBtnEnabled('scan', !r);
    setBtnEnabled('scanall', !r);
    setBtnEnabled('storage-scan', !r);
    setBtnEnabled('plugin-storage-scan', !r);
    setBtnEnabled('lorebook-scan', !r);
    setBtnEnabled('realm-search', !r);
    setBtnEnabled('realm-recover', !r && !!currentChar);
    setBtnEnabled('local-recover', !r && !!currentChar);
    setBtnEnabled('plugin-trash-move', !r && currentPluginStorageSummary && currentPluginStorageSummary.orphanKeys > 0);
    setBtnEnabled('plugin-trash-view', !r);
    setBtnEnabled('plugin-trash-restore', !r);
    setBtnEnabled('plugin-trash-empty', !r);
    setBtnEnabled('apply', !r && currentScanResult && currentScanResult.actionable.length > 0);
    setBtnEnabled('remap', !r && currentScanResult && currentScanResult.supportsRemap && currentScanResult.refs && currentScanResult.refs.length > 0);
    setBtnEnabled('fill', !r && currentScanResult && currentScanResult.supportsCache && currentScanResult.refs && currentScanResult.refs.length > 0);
    setBtnEnabled('cache', !r && currentScanResult && currentScanResult.supportsCache && currentScanResult.refs && currentScanResult.refs.length > 0);
}

function requestAllCharacterScan() {
    if (isRunning) return;
    if (!confirm(
        '전체 캐릭터 진단을 실행할까요?\n\n' +
        '모든 캐릭터의 자산 참조를 검사하고 전체 에셋 키를 인덱싱합니다.\n' +
        '캐릭터/에셋이 많으면 모바일에서 시간이 오래 걸릴 수 있습니다.'
    )) {
        setStatus('전체 진단 취소');
        return;
    }
    runCharScan('all');
}

async function getStorageUsageBytes() {
    try {
        if (navigator && navigator.storage && typeof navigator.storage.estimate === 'function') {
            const est = await navigator.storage.estimate();
            return est.usage || 0;
        }
    } catch (e) {}
    return 0;
}

async function runStorageUsageScan() {
    if (isRunning) return;
    if (assetStorageMode === 'pocket') {
        log('포켓리스 전체 디스크 점유는 서버 설정에서 확인하세요. 브라우저 IndexedDB 용량을 서버 용량으로 표시하지 않습니다.');
        setStatus('서버 저장소는 캐릭터·모듈 진단 지원');
        return;
    }
    setRunning(true);
    clearLog();
    clearUsageSummary();
    switchPanelPage('storage');
    setProgress(0);
    setStatus('저장소 점유 분석 중...');

    let storage = null;
    try {
        log('=== 저장소 뷰어 ===');
        log('저장소: ' + modeLabel(assetStorageMode));
        storage = createAssetStorage(assetStorageMode);
        log(await storage.open());
        setProgress(20);

        setStatus(modeLabel(assetStorageMode) + ' 키 인덱싱 중...');
        const allKeys = await storage.keys();
        setProgress(50);

        setStatus('전체 캐릭터+모듈 참조 수집 중...');
        const globalRefs = collectGlobalAssetRefs();
        const usageSummary = buildAssetUsageSummary(allKeys, globalRefs, await getStorageUsageBytes());
        renderUsageSummary(usageSummary);
        setProgress(100);
        setStatus('저장소 점유 분석 완료');

        log('--- 저장소 점유 분석 (전체 캐릭터+모듈 참조 기준) ---');
        log('  전체 저장소 자산 키: ' + usageSummary.totalAssetKeys);
        log('  사용 중 자산 키: ' + usageSummary.usedAssetKeys);
        log('  고아 후보 자산 키: ' + usageSummary.orphanAssetKeys);
        log('  DB 안 자산 참조: ' + usageSummary.referencedAssetPaths);
        if (usageSummary.storageUsageBytes) {
            log('  브라우저/앱 전체 저장소 사용량: ' + formatBytes(usageSummary.storageUsageBytes));
        }
        log('  주의: 초록/빨강 막대는 개별 바이트가 아니라 키 개수 기준입니다.');
        if (usageSummary.orphanKeys.length > 0) {
            log('  고아 후보 샘플 (최대 10):');
            for (const k of usageSummary.orphanKeys.slice(0, 10)) log('    ' + k);
        }
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        try { if (storage) storage.close(); } catch (_) {}
        setRunning(false);
    }
}

async function copyLog() {
    const text = logBuf.join('\n');
    try {
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            log('복사됨');
            return;
        }
    } catch (e) {}
    log('자동 복사 불가. 로그 영역을 길게 눌러 직접 복사해주세요.');
}

function initAssetStorageMode() {
    assetStorageMode = detectRuntimeMode();
    updateAssetStorageUI();
    refreshLocalAssetDir(false);
}
function changeAssetStorageMode() {
    const modeEl = $id(PANEL_ID + '-mode');
    assetStorageMode = modeEl && modeEl.value ? modeEl.value : 'web';
    updateAssetStorageUI();
    log('에셋저장소 모드 변경: ' + modeLabel(assetStorageMode));
    refreshLocalAssetDir(true);
}
async function refreshLocalAssetDir(verbose) {
    if (assetStorageMode !== 'local' || resolvedLocalAssetDir) return;
    if (!getTauriInvoke()) {
        if (verbose) {
            log('로컬리스 자동 추적 불가: Tauri IPC가 보이지 않습니다.');
            log(LOCAL_ASSET_PATH_HINT);
        }
        return;
    }
    try {
        const dir = await resolveLocalAssetDir();
        updateAssetStorageUI();
        if (verbose) log('로컬리스 원본 에셋 저장소 추적: ' + dir);
    } catch (e) {
        if (verbose) log('로컬리스 원본 저장소 추적 실패: ' + (e && e.message ? e.message : e));
    }
}
async function openAssetStorageFolder() {
    if (assetStorageMode === 'web') {
        log('웹리스 모드: 원본 에셋 저장소는 브라우저 IndexedDB(risuai/keyvaluepairs)입니다. OS 폴더가 없습니다.');
        log('브라우저 프로필 내부 IndexedDB 폴더는 실제로 존재하지만, 웹 페이지 권한으로 정확한 OS 경로를 알거나 열 수 없습니다.');
        log('캐시 덮어씌워 리매핑은 현재 IndexedDB 자산을 기준으로 동작합니다.');
        return;
    }
    try {
        const dir = await openLocalAssetDir();
        setStoreNote('로컬리스(비검증): ' + dir + '. 진단/로컬 리매핑/확장자 통일 지원');
        log('로컬리스 원본 에셋 저장소: ' + dir);
        log('폴더 열기 요청 완료');
        return;
    } catch (e) {
        log('로컬리스 원본 저장소 자동 열기 실패: ' + (e && e.message ? e.message : e));
        log(LOCAL_ASSET_PATH_HINT);
        log('대체로 수동 폴더 선택을 시도합니다.');
    }
    const realWin = getRealWindow();
    const picker = (realWin && realWin.showDirectoryPicker) || (typeof showDirectoryPicker === 'function' ? showDirectoryPicker : null);
    if (!picker) {
        log('폴더 선택 API를 사용할 수 없습니다. 로컬리스 AppData(Roaming) assets 폴더 자동 열기는 플러그인 권한상 불가할 수 있습니다.');
        log(LOCAL_ASSET_PATH_HINT);
        return;
    }
    try {
        selectedAssetFolder = await picker.call(realWin || window);
        updateAssetStorageUI();
        log('선택 폴더: ' + selectedAssetFolder.name);
        log('참고: 진단/로컬 리매핑/확장자 통일은 로컬리스 AppData assets 기준으로 동작합니다.');
    } catch (e) {
        log('폴더 선택 취소/실패: ' + (e && e.message ? e.message : e));
    }
}
async function changeAssetStorageFiles() {
    log('파일 변경은 아직 실제 리매핑 기준에 연결되지 않았습니다. 현재 버전에서는 사용하지 않습니다.');
    return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif,.mp4,.webm,.mp3,.wav,.ogg,.svg,.css,*/*';
    input.onchange = () => {
        selectedAssetFiles = Array.from(input.files || []);
        log('선택 파일: ' + selectedAssetFiles.length + '개');
        setStoreNote('수동 선택 파일 ' + selectedAssetFiles.length + '개. 현재 직접 파일 리매핑에는 사용하지 않습니다.');
    };
    input.click();
}

// =========================================
// Collect character asset references.
// =========================================
function collectCharRefs(char) {
    const refs = [];
    const seen = new Set();
    const add = (path, source) => {
        addRef(refs, seen, path, source);
    };
    if (!char) return refs;
    if (char.image) add(char.image, 'image (메인)');
    if (char.emotionImages) {
        for (const em of char.emotionImages) {
            if (em && em[1]) add(em[1], 'emotion: ' + (em[0] || '?'));
        }
    }
    if (char.additionalAssets) {
        for (const a of char.additionalAssets) {
            if (a && a[1]) add(a[1], 'additional: ' + (a[0] || '?'));
        }
    }
    if (char.ccAssets) {
        for (const a of char.ccAssets) {
            if (a && a.uri) add(a.uri, 'ccAsset: ' + (a.name || '?'));
        }
    }
    if (char.vits && char.vits.files) {
        for (const k of Object.keys(char.vits.files)) {
            add(char.vits.files[k], 'vits: ' + k);
        }
    }
    return refs;
}

function collectModuleRefs(module) {
    const refs = [];
    const seen = new Set();
    if (!module || !Array.isArray(module.assets)) return refs;
    for (const a of module.assets) {
        if (a && a[1]) addRef(refs, seen, a[1], 'module additional: ' + (a[0] || '?'));
    }
    return refs;
}

function collectTableAssetRefs(table) {
    const refs = [];
    const seen = new Set();
    if (!table || !table.querySelectorAll) return refs;
    const media = table.querySelectorAll('img[src], video[src], audio[src], source[src]');
    for (let i = 0; i < media.length; i++) {
        const path = assetPathFromSrc(media[i].getAttribute('src') || media[i].src || '');
        if (path) addRef(refs, seen, path, 'additional preview');
    }
    return refs;
}

function tableAssetNames(table) {
    if (!table || !table.querySelectorAll) return [];
    const names = [];
    const inputs = table.querySelectorAll('input');
    for (let i = 0; i < inputs.length; i++) {
        const v = (inputs[i].value || '').trim();
        if (v) names.push(v);
    }
    return names;
}

function findModuleByAssetTable(table) {
    const names = tableAssetNames(table);
    if (names.length === 0) return null;
    let modules = [];
    try {
        const db = getDatabase();
        modules = db.modules || [];
    } catch (e) {
        return null;
    }
    let best = null;
    let bestScore = 0;
    let tie = false;
    for (const mod of modules) {
        if (!mod || !Array.isArray(mod.assets)) continue;
        const assetNames = mod.assets.map(a => a && a[0]).filter(Boolean);
        let score = 0;
        for (const n of names) {
            if (assetNames.includes(n)) score++;
        }
        if (score > bestScore) {
            best = mod;
            bestScore = score;
            tie = false;
        } else if (score > 0 && score === bestScore) {
            tie = true;
        }
    }
    return bestScore > 0 && !tie ? best : null;
}

function resolveModuleTableContext(table) {
    const tableRefs = collectTableAssetRefs(table);
    const host = table && table.querySelector ? table.querySelector('[data-risu-module-id]') : null;
    const moduleId = host && host.getAttribute('data-risu-module-id');
    const matched = moduleId ? getAllModules().find(item => item && item.id === moduleId) : findModuleByAssetTable(table);
    const refs = [];
    const seen = new Set();
    if (matched) {
        const moduleRefs = collectModuleRefs(matched);
        for (const r of moduleRefs) addRef(refs, seen, r.path, r.source);
    }
    for (const r of tableRefs) addRef(refs, seen, r.path, r.source);
    return {
        type: 'module',
        owner: matched || null,
        label: (matched && matched.name ? matched.name : '모듈 추가에셋'),
        refs
    };
}

// =========================================
// Collect all characters for full-scope scan.
// =========================================
function getAllCharacters() {
    try {
        const db = getDatabase();
        return db.characters || [];
    } catch (e) {
        return [];
    }
}
function getAllModules() {
    try {
        const db = getDatabase();
        return db.modules || [];
    } catch (e) {
        return [];
    }
}
function collectGlobalAssetRefs() {
    const refs = [];
    const seen = new Set();
    const add = (path, source) => addRef(refs, seen, path, source);
    const chars = getAllCharacters();
    const modules = getAllModules();

    for (const c of chars) {
        if (!c) continue;
        const label = c.name || '?';
        const known = collectCharRefs(c);
        for (const r of known) add(r.path, '[캐릭터: ' + label + '] ' + r.source);
        collectDeepAssetRefs(c, refs, seen, '[캐릭터: ' + label + ']', 0);
    }

    for (const m of modules) {
        if (!m) continue;
        const label = m.name || '?';
        const known = collectModuleRefs(m);
        for (const r of known) add(r.path, '[모듈: ' + label + '] ' + r.source);
        collectDeepAssetRefs(m, refs, seen, '[모듈: ' + label + ']', 0);
    }

    return refs;
}
function buildAssetUsageSummary(allKeys, refs, storageUsageBytes) {
    const storedKeys = [];
    for (const k of allKeys || []) {
        if (typeof k === 'string' && k.startsWith('assets/') && ASSET_EXT_RE.test(k)) storedKeys.push(k);
    }

    const exactRefs = new Set();
    const baseRefs = new Set();
    for (const ref of refs || []) {
        if (!ref || !ref.path) continue;
        exactRefs.add(ref.path);
        baseRefs.add(assetBasePath(ref.path));
    }

    const usedKeys = [];
    const orphanKeys = [];
    for (const key of storedKeys) {
        if (exactRefs.has(key) || baseRefs.has(assetBasePath(key))) {
            usedKeys.push(key);
        } else {
            orphanKeys.push(key);
        }
    }

    return {
        totalAssetKeys: storedKeys.length,
        usedAssetKeys: usedKeys.length,
        orphanAssetKeys: orphanKeys.length,
        usedKeys,
        orphanKeys,
        referencedAssetPaths: exactRefs.size,
        storageUsageBytes: storageUsageBytes || 0
    };
}

function cacheUrlForAssetPath(path, origin) {
    return (origin || location.origin) + '/sw/img/' + strToHex(path);
}

async function scanCacheStateForRefs(refs, progressBase, progressSpan) {
    const summary = {
        available: false,
        error: '',
        total: 0,
        hit: 0,
        miss: 0,
        missingPaths: [],
        missingSamples: [],
        errors: 0,
        errorSamples: []
    };
    if (typeof caches === 'undefined') {
        summary.error = 'caches API 사용 불가';
        return summary;
    }

    let cache = null;
    try {
        cache = await caches.open('risuCache');
    } catch (e) {
        summary.error = e && e.message ? e.message : String(e);
        return summary;
    }

    const uniqueRefs = uniqueAssetRefs(refs);
    const origin = location.origin;
    summary.available = true;
    summary.total = uniqueRefs.length;

    for (let i = 0; i < uniqueRefs.length; i++) {
        const path = uniqueRefs[i].path;
        try {
            const matched = await cache.match(cacheUrlForAssetPath(path, origin));
            if (matched) {
                summary.hit++;
            } else {
                summary.miss++;
                summary.missingPaths.push(path);
                if (summary.missingSamples.length < 10) summary.missingSamples.push(path);
            }
        } catch (e) {
            summary.errors++;
            if (summary.errorSamples.length < 10) {
                summary.errorSamples.push(path + ': ' + (e && e.message ? e.message : e));
            }
        }
        if ((i + 1) % 100 === 0 || i === uniqueRefs.length - 1) {
            if (Number.isFinite(progressBase) && Number.isFinite(progressSpan)) {
                setProgress(progressBase + ((i + 1) / Math.max(1, uniqueRefs.length)) * progressSpan);
            }
            setStatus('SW 캐시 상태 검사 ' + (i + 1) + '/' + uniqueRefs.length);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    return summary;
}

// =========================================
// Scan current scope or all characters.
// =========================================
function scanScopeOptions() {
    return {
        includeTrash: !!($id(PANEL_ID + '-include-trash') && $id(PANEL_ID + '-include-trash').checked),
        includeModules: !$id(PANEL_ID + '-include-modules') || $id(PANEL_ID + '-include-modules').checked,
    };
}

async function refreshCurrentRecoveryCharacter() {
    if (!pocketAssetApi() || typeof getCharAsync !== 'function') return;
    const fresh = await getCharAsync();
    if (!fresh || !currentChar || fresh.chaId !== currentChar.chaId) {
        throw new Error('선택한 캐릭터가 변경되었습니다. 복구 패널을 다시 열어 주세요.');
    }
    if (fresh.additionalAssetManifest && !Array.isArray(fresh.additionalAssets)) {
        throw new Error('현재 캐릭터 에셋 목록을 모두 읽지 못했습니다. 복구를 중단합니다.');
    }
    currentChar = fresh;
}

async function hydrateRecoverySourceCharacter(char) {
    const api = pocketAssetApi();
    if (!api || Array.isArray(char.additionalAssets) || !char.additionalAssetManifest) return char;
    const manifest = { ...char.additionalAssetManifest };
    const assets = [];
    let total = null;
    for (let offset = 0; total === null || offset < total;) {
        const requestedId = manifest.id;
        const page = await api.getAssetManifestPage(manifest, { offset, limit: 128 });
        if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total)
            || page.total < 0 || (offset > 0 && manifest.id !== requestedId)
            || (total !== null && total !== page.total) || (!page.items.length && offset < page.total)) {
            throw new Error('복구 원본의 에셋 목록을 모두 읽지 못했습니다.');
        }
        total = page.total;
        assets.push(...page.items);
        offset += page.items.length;
        if (!total) break;
    }
    return { ...char, additionalAssets: assets };
}

async function* pocketOwnerReferencePages(owner, kind, api) {
    const seen = new Set();
    const label = '[' + (kind === 'module' ? '모듈' : '캐릭터') + ': ' + (owner.name || '?') + '] ';
    const initial = kind === 'module' ? [] : collectCharRefs({ ...owner, additionalAssets: [] });
    const filter = refs => refs.filter(ref => {
        if (seen.has(ref.path)) return false;
        seen.add(ref.path);
        ref.source = label + ref.source;
        return true;
    });
    if (initial.length) yield filter(initial);
    const inline = kind === 'module' ? owner.assets : owner.additionalAssets;
    const descriptor = kind === 'module' ? owner.assetManifest : owner.additionalAssetManifest;
    const tupleRefs = items => {
        const refs = [], localSeen = new Set();
        for (const tuple of items) if (tuple && tuple[1]) addRef(refs, localSeen, tuple[1], 'additional: ' + (tuple[0] || '?'));
        return filter(refs);
    };
    if (Array.isArray(inline)) {
        for (let offset = 0; offset < inline.length; offset += 128) yield tupleRefs(inline.slice(offset, offset + 128));
    } else if (descriptor) {
        if (typeof api.getAssetManifestPage !== 'function') throw new Error('Manifest 페이지 API 미지원: 서버 업데이트 필요');
        const manifest = { ...descriptor };
        let total = null;
        for (let offset = 0; total === null || offset < total;) {
            const requestedId = manifest.id;
            const page = await api.getAssetManifestPage(manifest, { offset, limit: 128 });
            if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0
                || (offset > 0 && manifest.id !== requestedId)
                || (total !== null && total !== page.total) || (!page.items.length && offset < page.total)) {
                throw new Error('Manifest 페이지가 누락되었거나 진단 중 변경되었습니다. 다시 진단하세요.');
            }
            total = page.total;
            yield tupleRefs(page.items);
            offset += page.items.length;
            if (!total) break;
        }
    }
}

async function runPocketAssetScan(mode) {
    setRunning(true);
    clearLog();
    currentScanResult = null;
    setProgress(0);
    const api = pocketAssetApi();
    const options = scanScopeOptions();
    const summary = { total: 0, exists: 0, missing: 0, error: 0, unsupported: 0, fallback: 0, ownerErrors: 0 };
    const issues = [];
    try {
        if (!api || typeof api.inspectAssets !== 'function') {
            throw new Error('이 서버에 메타데이터 진단 API가 없습니다. 포켓리스 코어와 플러그인을 함께 업데이트해야 합니다.');
        }
        const owners = [];
        if (mode === 'all') {
            for (const owner of getAllCharacters()) if (owner && (options.includeTrash || !owner.trashTime)) owners.push({ owner, kind: 'character' });
            if (options.includeModules) for (const owner of getAllModules()) if (owner && (options.includeTrash || !owner.trashTime)) owners.push({ owner, kind: 'module' });
        } else if (currentContext && currentContext.type === 'module') {
            if (!currentContext.owner) throw new Error('현재 모듈 ID를 확인할 수 없습니다. 모듈을 다시 열거나 전체 모듈 진단을 사용하세요. 화면 일부만 보고 정상 판정하지 않습니다.');
            const owner = getAllModules().find(item => item && item.id === currentContext.owner.id);
            if (!owner) throw new Error('현재 모듈이 변경되거나 삭제되었습니다. 다시 열어 주세요.');
            owners.push({ owner, kind: 'module' });
        } else {
            // Read a fresh owner, but leave manifest pages lazy. A snapshot
            // captured before switching bots must not diagnose the old bot.
            const selected = typeof getChar === 'function' ? getChar() : currentChar;
            if (!selected) throw new Error('현재 캐릭터를 찾을 수 없습니다.');
            const owner = getAllCharacters().find(item => item && item.chaId === selected.chaId) || selected;
            currentChar = selected;
            owners.push({ owner, kind: 'character' });
        }
        if (!owners.length) throw new Error('진단 대상이 없습니다.');
        log('포켓리스 서버 진단: 원본 다운로드·SW 캐시 채우기 없이 존재 여부만 검사합니다.');
        log('원본 없음, 접근 오류, 검사 미지원은 서로 다른 결과입니다. 해시·디코딩 검증은 별도입니다.');
        log('대상 ' + owners.length + '개, 휴지통 ' + (options.includeTrash ? '포함' : '제외') + ', 소유자별 중복 참조 제거');
        for (let index = 0; index < owners.length; index++) {
            const { owner, kind } = owners[index];
            try {
                for await (const pageRefs of pocketOwnerReferencePages(owner, kind, api)) {
                    for (let offset = 0; offset < pageRefs.length; offset += 128) {
                        const refs = pageRefs.slice(offset, offset + 128);
                        if (!refs.length) continue;
                        let records = null;
                        await runAdaptiveAssetJobs([refs], async batch => {
                            const next = await api.inspectAssets(batch.map(ref => ref.path));
                            if (!Array.isArray(next) || next.length !== batch.length
                                || next.some((entry, i) => entry.path !== batch[i].path)) throw new Error('잘못된 서버 진단 응답');
                            if (next.some(entry => entry.retryable)) throw Object.assign(new Error('서버 저장소 일시 오류'), { retryable: true });
                            records = next;
                        }, {
                            concurrency: 1,
                            onRetry: ({ waitMs }) => setStatus('저장소 일시 오류: ' + waitMs + 'ms 뒤 재시도'),
                            onFailure: error => {
                                records = refs.map(ref => ({ path: ref.path, status: 'error', code: String(error && error.message || error) }));
                            },
                        });
                        for (let i = 0; i < records.length; i++) {
                            const record = records[i];
                            const status = ['exists', 'missing', 'error', 'unsupported'].includes(record.status) ? record.status : 'error';
                            summary.total++;
                            summary[status]++;
                            if (record.source && record.source.startsWith('fallback-')) summary.fallback++;
                            if (status !== 'exists' && issues.length < 200) {
                                issues.push({ ...record, source: refs[i].source, exists: status === 'missing' ? false : null, variants: [] });
                                log((status === 'missing' ? '원본 없음' : status === 'unsupported' ? '검사 미지원' : '접근/검사 오류') + ': ' + refs[i].source + ' · ' + record.path + ' · ' + (record.code || status));
                            }
                        }
                        setStatus('서버 검사 ' + (index + 1) + '/' + owners.length + ' · 참조 ' + summary.total + '개');
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }
            } catch (error) {
                summary.ownerErrors++;
                log('목록 검사 불완전: ' + (owner.name || '?') + ' · ' + (error && error.message || error));
            }
            setProgress(((index + 1) / owners.length) * 100);
        }
        log('요약: 확인 ' + summary.total + ', 존재 ' + summary.exists + ', 원본 없음 ' + summary.missing
            + ', 접근/검사 오류 ' + summary.error + ', 미지원 ' + summary.unsupported + ', 목록 실패 ' + summary.ownerErrors);
        if (summary.fallback) log('내부/휴지통 fallback으로 사용 가능: ' + summary.fallback + '개');
        log('문제 상세는 최대 200개만 보관합니다. 정상 에셋 바이트와 전체 키 목록은 보관하지 않습니다.');
        log('포켓리스는 risuCache 일괄 채우기/덮어쓰기를 사용하지 않습니다. 서버 원본 복구와 브라우저 캐시는 별개입니다.');
        currentScanResult = {
            mode, storageMode: 'pocket', refs: issues, totalRefs: summary.total, summary,
            actionable: [], byBase: new Map(), supportsCache: false, supportsRemap: false, supportsWrite: false,
            scopeLabel: mode === 'all' ? '전체 캐릭터·모듈' : owners[0].owner.name,
        };
        setStatus(summary.error || summary.unsupported || summary.ownerErrors ? '진단 완료 · 확인하지 못한 항목 있음' : '서버 진단 완료');
    } catch (error) {
        log('진단 불가: ' + (error && error.message || error));
        setStatus('진단 불가 — 원본 없음으로 판정하지 않음');
    } finally { setRunning(false); }
}

async function runCharScan(mode) {
    if (isRunning) return;
    if (pocketAssetApi() && assetStorageMode !== 'pocket') {
        assetStorageMode = 'pocket';
        updateAssetStorageUI();
    }
    if (assetStorageMode === 'pocket') return await runPocketAssetScan(mode);
    setRunning(true);
    clearLog();
    setProgress(0);
    setStatus('진단 버튼을 눌러주세요');
    currentScanResult = null;

    let targetChars = [];
    let targetModules = [];
    const scopeOptions = scanScopeOptions();
    let contextRefs = null;
    let scopeLabel = '';
    let resultMode = mode;
    if (mode === 'all') {
        const all = getAllCharacters();
        if (!all || all.length === 0) {
            log('캐릭터 목록을 가져오지 못했습니다.');
            setStatus('오류');
            setRunning(false);
            return;
        }
        targetChars = all.filter(c => c && (scopeOptions.includeTrash || !c.trashTime));
        targetModules = scopeOptions.includeModules ? getAllModules().filter(m => m && (scopeOptions.includeTrash || !m.trashTime)) : [];
        scopeLabel = '캐릭터 ' + targetChars.length + '명 · 모듈 ' + targetModules.length + '개';
        setSub(scopeLabel);
    } else if (currentContext && Array.isArray(currentContext.refs)) {
        contextRefs = currentContext.refs;
        scopeLabel = currentContext.label || '현재 추가에셋';
        resultMode = currentContext.type || 'current';
    } else {
        if (!currentChar) {
            log('현재 캐릭터를 가져오지 못했습니다. (getChar 실패)');
            setStatus('오류');
            setRunning(false);
            return;
        }
        targetChars = [currentChar];
        scopeLabel = (currentChar.name || '?');
    }

    log('=== 이미지 진단 (' + (mode === 'all' ? '전체' : '현재') + ') ===');
    log('대상: ' + scopeLabel);
    log('time: ' + new Date().toISOString());
    log('');

    // Check storage quota to estimate mobile eviction risk.
    let storageUsageBytes = 0;
    try {
        if (navigator && navigator.storage && typeof navigator.storage.estimate === 'function') {
            const est = await navigator.storage.estimate();
            const usage = est.usage || 0;
            const quota = est.quota || 0;
            storageUsageBytes = usage;
            const usageMB = (usage / 1024 / 1024).toFixed(1);
            const quotaMB = (quota / 1024 / 1024).toFixed(1);
            const pct = quota > 0 ? ((usage / quota) * 100).toFixed(1) : '?';
            log('--- Storage 상태 ---');
            log('  사용량: ' + usageMB + ' MB');
            log('  할당량: ' + quotaMB + ' MB');
            log('  사용률: ' + pct + '%');
            if (quota > 0 && usage / quota > 0.7) {
                log('  경고: 사용률 70% 초과. 모바일 브라우저가 IndexedDB 데이터를 evict할 위험이 있습니다.');
                log('  자산 정리와 원본 봇 파일/카드 보관을 권장합니다.');
            }
            log('');
        }
    } catch (e) {
        log('storage.estimate 실패: ' + e);
    }

    // Collect asset refs for the selected scope.
    const refs = [];
    const seenPaths = new Set();
    if (contextRefs) {
        for (const r of contextRefs) {
            if (seenPaths.has(r.path)) continue;
            seenPaths.add(r.path);
            refs.push({ path: r.path, source: r.source });
        }
    } else {
        for (const c of targetChars) {
            const cRefs = collectCharRefs(c);
            for (const r of cRefs) {
                if (seenPaths.has(r.path)) continue;
                seenPaths.add(r.path);
                // Prefix source labels with character names during full scan.
                const source = (mode === 'all' && c.name) ? ('[' + c.name + '] ' + r.source) : r.source;
                refs.push({ path: r.path, source });
            }
        }
    }
    for (const module of targetModules) {
        for (const ref of collectModuleRefs(module)) addRef(refs, seenPaths, ref.path, '[모듈: ' + (module.name || '?') + '] ' + ref.source);
    }
    log('수집된 자산 참조: ' + refs.length + '개 (중복 제거)');
    if (refs.length === 0) {
        log('자산 참조가 없습니다.');
        setStatus('자산 없음');
        setRunning(false);
        return;
    }

    let storage = null;
    try {
        storage = createAssetStorage(assetStorageMode);
        const openMessage = await storage.open();
        log(openMessage);
        log('');

        // Build a base-path index once to find extension variants quickly.
        setStatus(modeLabel(assetStorageMode) + ' 키 인덱싱 중...');
        const allKeys = await storage.keys();
        const byBase = new Map();
        for (const k of allKeys) {
            if (typeof k !== 'string') continue;
            if (!k.startsWith('assets/')) continue;
            if (!IMG_EXT_RE.test(k)) continue;
            const b = basePath(k);
            const list = byBase.get(b) || [];
            list.push(k);
            byBase.set(b, list);
        }
        log('전체 이미지 자산 키: ' + Array.from(byBase.values()).reduce((a,b)=>a+b.length,0));
        log('전체 베이스: ' + byBase.size);
        log('');

        setStatus('저장소 점유 분석 중...');
        const globalRefs = collectGlobalAssetRefs();
        const usageSummary = buildAssetUsageSummary(allKeys, globalRefs, storageUsageBytes);
        renderUsageSummary(usageSummary);
        log('--- 저장소 점유 분석 (전체 캐릭터+모듈 참조 기준) ---');
        log('  전체 저장소 자산 키: ' + usageSummary.totalAssetKeys);
        log('  사용 중 자산 키: ' + usageSummary.usedAssetKeys);
        log('  고아 후보 자산 키: ' + usageSummary.orphanAssetKeys);
        log('  DB 안 자산 참조: ' + usageSummary.referencedAssetPaths);
        if (usageSummary.storageUsageBytes) {
            log('  브라우저/앱 전체 저장소 사용량: ' + formatBytes(usageSummary.storageUsageBytes));
        }
        log('  주의: 초록/빨강 막대는 개별 바이트가 아니라 키 개수 기준입니다.');
        if (usageSummary.orphanKeys.length > 0) {
            log('  고아 후보 샘플 (최대 10):');
            for (const k of usageSummary.orphanKeys.slice(0, 10)) log('    ' + k);
        }
        log('');
        setProgress(15);

        log('--- 자산 검사 (문제 케이스만 출력) ---');
        const refsResult = [];
        const actionable = [];
        let liveCount = 0, deadCount = 0;
        let unrecoverableDeadCount = 0;
        const deadSamples = [];

        for (let i = 0; i < refs.length; i++) {
            const ref = refs[i];
            const exists = await storage.exists(ref.path);
            const base = basePath(ref.path);
            const variants = byBase.get(base) || [];

            let size = 0;
            if (exists) {
                liveCount++;
            } else {
                deadCount++;
            }

            const variantInfo = [];
            for (const vk of variants) {
                if (vk === ref.path) continue;
                variantInfo.push(vk);
            }

            refsResult.push({
                path: ref.path,
                source: ref.source,
                exists,
                size,
                variants: variantInfo
            });

            const hasVariantFix = !exists && variantInfo.length > 0;
            const isProblem = !exists || hasVariantFix;
            const shouldPrint = isProblem;

            if (shouldPrint) {
                log('[' + (i+1) + '/' + refs.length + '] ' + ref.source);
                log('  경로: ' + ref.path);
                if (!exists) {
                    if (variantInfo.length > 0) {
                        log('  원본 저장소 없음. 다른 변형: ' + variantInfo.join(', '));
                        log('  별칭 적용 가능');
                    } else {
                        unrecoverableDeadCount++;
                        log('  원본 저장소 없음. 변형도 없음. 죽은 참조 (원본 에셋 필요)');
                        if (deadSamples.length < 10) deadSamples.push(ref.path);
                    }
                }
            } else if (!exists && deadSamples.length < 10) {
                deadSamples.push(ref.path);
            }

            // Collect actionable repairs separately from log output.
            if (!exists && variantInfo.length > 0) {
                actionable.push({
                    targetKey: ref.path,
                    sourceKey: variantInfo[0]
                });
            }

            if (i % 25 === 0 || i === refs.length - 1) {
                setProgress(15 + ((i+1) / refs.length) * 80);
                setStatus('진행 ' + (i+1) + '/' + refs.length);
            }
        }

        let cacheSummary = null;
        if (storage.supportsCache) {
            setStatus('SW 캐시 상태 검사 중...');
            cacheSummary = await scanCacheStateForRefs(refsResult, 95, 4);
            log('');
            log('--- SW 캐시 상태 (risuCache) ---');
            if (!cacheSummary.available) {
                log('  사용 불가: ' + (cacheSummary.error || '알 수 없음'));
            } else {
                log('  대상 캐시 키: ' + cacheSummary.total);
                log('  캐시 있음: ' + cacheSummary.hit);
                log('  캐시 없음: ' + cacheSummary.miss);
                if (cacheSummary.errors > 0) log('  검사 오류: ' + cacheSummary.errors);
                if (cacheSummary.missingSamples.length > 0) {
                    log('  캐시 없음 샘플 (최대 10):');
                    for (const s of cacheSummary.missingSamples) log('    ' + s);
                    log('  누락 캐시는 [누락 캐시 보충]으로 복구할 수 있습니다.');
                }
            }
        }

        log('');
        log('=== 요약 ===');
        log('  대상: ' + scopeLabel);
        log('  자산 참조 총: ' + refs.length);
        log('  원본 저장소 존재: ' + liveCount);
        log('  죽은 참조: ' + deadCount);
        log('  원본 에셋 없음: ' + unrecoverableDeadCount);
        log('  확장자 통일 가능: ' + actionable.length);
        if (!storage.supportsCache && storage.kind === 'local') {
            log('  로컬 리매핑: AppData/assets 실제 파일 기준으로 DB 참조 재매칭 가능');
        }
        if (deadCount > 0 && deadSamples.length > 0) {
            log('  죽은 참조 샘플 (최대 10):');
            for (const s of deadSamples) log('    ' + s);
        }
        if (actionable.length > 0) {
            log('');
            log('[확장자 통일] 활성화: ' + actionable.length + '개 자산.');
            log('캐시는 건드리지 않습니다.');
        }
        if (unrecoverableDeadCount > 0) {
            log('');
            log('원본 에셋이 없는 참조가 ' + unrecoverableDeadCount + '개 있습니다.');
            log('캐시 덮어씌워 리매핑/확장자 통일로는 복구할 수 없습니다.');
            log('같은 봇의 원본 파일/카드에서 누락 에셋을 확보한 뒤 다시 진단해주세요.');
        }
        setProgress(100);
        setStatus('진단 완료');
        currentScanResult = {
            refs: refsResult,
            actionable,
            byBase,
            mode: resultMode,
            scopeLabel,
            ...scopeOptions,
            storageMode: assetStorageMode,
            supportsCache: storage.supportsCache,
            supportsRemap: storage.supportsRemap,
            supportsWrite: storage.supportsWrite,
            usageSummary,
            cacheSummary
        };
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        try { if (storage) storage.close(); } catch (_) {}
        setRunning(false);
    }
}

// =========================================
// APPLY - 현재 스캔 범위의 확장자 통일
// =========================================
async function runCharApply() {
    if (isRunning) return;
    if (!currentScanResult || currentScanResult.actionable.length === 0) {
        log('진단을 먼저 실행해주세요.');
        return;
    }
    const applyScope = resultScopeText(currentScanResult);
    if (!confirm(
        applyScope + '의 ' + currentScanResult.actionable.length + '개 자산에 대해\n' +
        '같은 base의 다른 확장자 변형 중 가장 큰 것을 복사해서 참조 경로와 확장자를 맞춥니다.\n\n' +
        '캐시는 손대지 않습니다. 계속할까요?'
    )) return;

    setRunning(true);
    setProgress(0);
    setStatus('확장자 통일 중...');
    log('');
    log('--- 확장자 통일 ---');

    let storage = null;
    try {
        const storageMode = currentScanResult.storageMode || assetStorageMode;
        storage = createAssetStorage(storageMode);
        log(await storage.open());
        if (!storage.supportsWrite) {
            log('이 저장소 모드에서는 쓰기를 지원하지 않습니다.');
            return;
        }

        const list = currentScanResult.actionable;
        const byBase = currentScanResult.byBase;
        let aliased = 0, errors = 0;

        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            try {
                const base = basePath(item.targetKey);
                const variants = (byBase.get(base) || []).filter(k => k !== item.targetKey);
                let bestKey = null, bestSize = 0;
                for (const vk of variants) {
                    const v = await storage.get(vk);
                    const s = byteSize(v);
                    if (s > bestSize) { bestSize = s; bestKey = vk; }
                }
                if (bestKey && bestSize > 0) {
                    const data = await storage.get(bestKey);
                    await storage.put(item.targetKey, data);
                    aliased++;
                    log('✓ ' + item.targetKey + ' <- ' + bestKey + ' (' + bestSize + 'B)');
                } else {
                    log('skip: ' + item.targetKey + ' 변형 데이터 없음');
                }
            } catch (e) {
                errors++;
                log('error: ' + item.targetKey + ': ' + (e && e.message ? e.message : e));
            }
            setProgress(((i+1) / list.length) * 100);
            setStatus('진행 ' + (i+1) + '/' + list.length);
        }

        log('');
        log('완료. 확장자 통일 ' + aliased + ', 에러 ' + errors);
        setStatus('확장자 통일 완료');
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        try { if (storage) storage.close(); } catch (_) {}
        currentScanResult = null;
        setRunning(false);
    }
}
async function runCharCacheClean() {
    if (isRunning) return;
    if (!currentScanResult || !currentScanResult.refs || currentScanResult.refs.length === 0) {
        log('진단을 먼저 실행해주세요.');
        return;
    }
    if (!currentScanResult.supportsCache) {
        log('이 저장소 모드에서는 SW 캐시 청소가 적용되지 않습니다. 로컬리스는 AppData 파일을 직접 읽습니다.');
        return;
    }
    if (typeof caches === 'undefined') {
        log('caches API 사용 불가');
        return;
    }
    const scope = resultScopeText(currentScanResult) + ' ' + currentScanResult.refs.length + '개 자산';
    if (!confirm('위험: ' + scope + ' 경로에 해당하는 SW 캐시 항목만 삭제합니다.\n\n삭제 후 화면 반영에는 새로고침이 필요할 수 있습니다. 계속할까요?')) return;

    setRunning(true);
    setProgress(0);
    setStatus('캐시 청소 중...');
    log('');
    log('--- 캐시 청소 (' + scope + ') ---');

    try {
        const cache = await caches.open('risuCache');
        const refs = currentScanResult.refs;
        let deleted = 0, missing = 0;
        const origin = location.origin;
        for (let i = 0; i < refs.length; i++) {
            const path = refs[i].path;
            const encoded = strToHex(path);
            const url = cacheUrlForAssetPath(path, origin);
            try {
                const ok = await cache.delete(url);
                if (ok) deleted++; else missing++;
            } catch (e) {
                log('error: ' + path + ': ' + e);
            }
            setProgress(((i+1) / refs.length) * 100);
            if ((i+1) % 100 === 0 || i === refs.length - 1) setStatus('진행 ' + (i+1) + '/' + refs.length);
        }
        log('완료: 삭제 ' + deleted + ', 없음 ' + missing);
        setStatus('캐시 청소 완료');
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        setRunning(false);
    }
}

function uniqueAssetRefs(refs) {
    const out = [];
    const seen = new Set();
    for (const ref of refs || []) {
        if (!ref || typeof ref.path !== 'string' || !ref.path.startsWith('assets/')) continue;
        if (seen.has(ref.path)) continue;
        seen.add(ref.path);
        out.push(ref);
    }
    return out;
}

async function runCharCacheFillMissing() {
    if (isRunning) return;
    if (!currentScanResult || !currentScanResult.refs || currentScanResult.refs.length === 0) {
        log('진단을 먼저 실행해주세요.');
        return;
    }
    if (!currentScanResult.supportsCache) {
        log('이 저장소 모드에서는 누락 캐시 보충이 적용되지 않습니다.');
        return;
    }
    if (typeof caches === 'undefined') {
        log('caches API 사용 불가');
        return;
    }
    if (typeof readImage !== 'function') {
        log('readImage API 사용 불가');
        return;
    }

    const allRefs = uniqueAssetRefs(currentScanResult.refs);
    let refs = allRefs;
    const scannedCache = currentScanResult.cacheSummary;
    if (scannedCache && scannedCache.available && Array.isArray(scannedCache.missingPaths)) {
        const missingSet = new Set(scannedCache.missingPaths);
        refs = allRefs.filter(ref => missingSet.has(ref.path));
        if (refs.length === 0) {
            log('진단 기준으로 누락된 캐시가 없습니다.');
            setStatus('누락 캐시 없음');
            return;
        }
    }
    const scope = resultScopeText(currentScanResult) + ' ' + refs.length + '개 자산';
    if (!confirm(
        scope + '에 대해 risuCache에 없는 항목만 다시 채웁니다.\n\n' +
        '이미 캐시된 항목은 건드리지 않고, 원본 저장소에서 readImage로 읽을 수 있는 자산만 추가합니다. 계속할까요?'
    )) return;

    setRunning(true);
    setProgress(0);
    setStatus('누락 캐시 보충 중...');
    log('');
    log('--- 누락 캐시 보충 (readImage -> risuCache) ---');

    try {
        const cache = await caches.open('risuCache');
        const origin = location.origin;
        let filled = 0, already = 0, empty = 0, errors = 0;

        const job = await runAdaptiveAssetJobs(refs, async ref => {
            const encoded = strToHex(ref.path);
            const url = cacheUrlForAssetPath(ref.path, origin);
                const matched = await cache.match(url);
                if (matched) {
                    already++;
                } else {
                    const data = normalizeBinary(await readImage(ref.path));
                    const size = byteSize(data);
                    if (!data || size <= 0) {
                        empty++;
                    } else {
                        const type = await detectImageType(data);
                        const contentType = contentTypeFromDetected(type, ref.path);
                        await cache.put(url, new Response(data, {
                            status: 200,
                            headers: {
                                'content-type': contentType,
                                'cache-control': 'max-age=604800'
                            }
                        }));
                        filled++;
                        if (filled <= 20 || filled % 1000 === 0) {
                            log('+ ' + ref.path + ' -> /sw/img/' + encoded + ' (' + size + 'B, ' + contentType + ')');
                        }
                    }
                }
        }, {
            onFailure: (e, ref) => {
                errors++;
                if (errors <= 20) log('error: ' + ref.path + ': ' + (e && e.message ? e.message : e));
            },
            onProgress: state => {
                setProgress(state.completed / Math.max(1, state.total) * 100);
                setStatus('누락 캐시 보충 ' + state.completed + '/' + state.total + ' · 병렬 ' + state.concurrency);
            },
            onRetry: state => log('일시 오류: 병렬 ' + state.concurrency + '개로 감속, ' + state.waitMs + 'ms 후 재시도'),
        });

        log('');
        log('완료. 채움 ' + filled + ', 이미 있음 ' + already + ', 원본 없음/빈값 ' + empty + ', errors ' + errors);
        log('재시도 ' + job.retries + '회. 정상 캐시는 덮어쓰지 않았습니다.');
        setStatus('누락 캐시 보충 완료');
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        setRunning(false);
    }
}

async function chooseBestExistingVariant(storage, byBase, targetKey) {
    const base = basePath(targetKey);
    const variants = (byBase.get(base) || []).filter(k => k !== targetKey);
    let bestKey = '';
    let bestSize = 0;
    for (const vk of variants) {
        try {
            if (!(await storage.exists(vk))) continue;
            const data = await storage.get(vk);
            const size = byteSize(data);
            if (size > bestSize) {
                bestSize = size;
                bestKey = vk;
            }
        } catch (_) {}
    }
    return bestKey;
}

async function buildLocalRemapMap(storage, scanResult) {
    const refs = scanResult.refs || [];
    const byBase = scanResult.byBase || new Map();
    const map = new Map();
    let live = 0, missing = 0, unresolved = 0;

    for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        try {
            const path = ref.path;
            const exists = await storage.exists(path);
            if (!exists) {
                missing++;
                const best = await chooseBestExistingVariant(storage, byBase, path);
                if (best) {
                    map.set(path, best);
                } else {
                    unresolved++;
                }
            } else {
                live++;
            }
        } catch (e) {
            unresolved++;
        }
        if ((i + 1) % 100 === 0 || i === refs.length - 1) {
            setProgress(((i + 1) / Math.max(1, refs.length)) * 45);
            setStatus('로컬 리매핑 후보 검사 ' + (i + 1) + '/' + refs.length);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    return { map, live, missing, unresolved };
}

function mappedPath(value, pathMap) {
    if (typeof value !== 'string') return value;
    return pathMap.get(value) || value;
}

function remapCharRefs(char, pathMap) {
    if (!char) return 0;
    let changed = 0;
    const replaceField = (obj, key) => {
        if (!obj || typeof obj[key] !== 'string') return;
        const next = mappedPath(obj[key], pathMap);
        if (next !== obj[key]) {
            obj[key] = next;
            changed++;
        }
    };

    replaceField(char, 'image');

    if (Array.isArray(char.emotionImages)) {
        for (const em of char.emotionImages) {
            if (!em || typeof em[1] !== 'string') continue;
            const next = mappedPath(em[1], pathMap);
            if (next !== em[1]) {
                em[1] = next;
                changed++;
            }
        }
    }
    if (Array.isArray(char.additionalAssets)) {
        for (const a of char.additionalAssets) {
            if (!a || typeof a[1] !== 'string') continue;
            const next = mappedPath(a[1], pathMap);
            if (next !== a[1]) {
                a[1] = next;
                changed++;
            }
        }
    }
    if (Array.isArray(char.ccAssets)) {
        for (const a of char.ccAssets) {
            if (!a || typeof a.uri !== 'string') continue;
            const next = mappedPath(a.uri, pathMap);
            if (next !== a.uri) {
                a.uri = next;
                changed++;
            }
        }
    }
    if (char.vits && char.vits.files) {
        for (const k of Object.keys(char.vits.files)) {
            const next = mappedPath(char.vits.files[k], pathMap);
            if (next !== char.vits.files[k]) {
                char.vits.files[k] = next;
                changed++;
            }
        }
    }
    return changed;
}

function remapModuleRefs(module, pathMap) {
    if (!module || !Array.isArray(module.assets)) return 0;
    let changed = 0;
    for (const a of module.assets) {
        if (!a || typeof a[1] !== 'string') continue;
        const next = mappedPath(a[1], pathMap);
        if (next !== a[1]) {
            a[1] = next;
            changed++;
        }
    }
    return changed;
}

function commitLocalReferenceRemap(pathMap, scanResult) {
    let changed = 0;
    let committed = false;
    const mode = scanResult.mode || 'current';

    try {
        if (mode === 'current' && currentChar) {
            changed += remapCharRefs(currentChar, pathMap);
            if (changed > 0 && typeof setChar === 'function') {
                setChar(currentChar);
                committed = true;
            }
        } else if (mode === 'all') {
            const db = getDatabase();
            const chars = db.characters || [];
            for (const ch of chars) if (ch && (scanResult.includeTrash || !ch.trashTime)) changed += remapCharRefs(ch, pathMap);
            const modules = db.modules || [];
            if (scanResult.includeModules) for (const mod of modules) if (mod && (scanResult.includeTrash || !mod.trashTime)) changed += remapModuleRefs(mod, pathMap);
            if (changed > 0 && typeof setDatabaseLite === 'function') {
                setDatabaseLite(scanResult.includeModules ? { characters: chars, modules } : { characters: chars });
                committed = true;
            }
        } else if (mode === 'module') {
            const db = getDatabase();
            const modules = db.modules || [];
            for (const mod of modules) changed += remapModuleRefs(mod, pathMap);
            if (changed > 0 && typeof setDatabaseLite === 'function') {
                setDatabaseLite({ modules });
                committed = true;
            }
        }
    } catch (e) {
        log('DB 참조 저장 실패: ' + (e && e.message ? e.message : e));
    }

    return { changed, committed };
}

async function runLocalAssetRemap() {
    const scope = resultScopeText(currentScanResult) + ' ' + currentScanResult.refs.length + '개 자산';
    if (!confirm(
        scope + '에 대해 로컬 AppData/assets 실제 파일을 기준으로\n' +
        'DB 안의 assets/... 참조 경로를 같은 base의 실제 존재 파일로 재매칭합니다.\n\n' +
        '예: assets/abc.png가 없고 assets/abc.webp가 있으면 참조를 webp로 바꿉니다.\n' +
        '파일 복사/삭제는 하지 않습니다. 계속할까요?'
    )) return;

    setRunning(true);
    setProgress(0);
    setStatus('로컬 캐시 리매핑 중...');
    log('');
    log('--- 로컬 캐시 리매핑 (AppData/assets -> DB 참조 경로) ---');

    let storage = null;
    try {
        storage = createAssetStorage('local');
        log(await storage.open());

        const built = await buildLocalRemapMap(storage, currentScanResult);
        log('후보 검사: 존재 ' + built.live + ', 결손 ' + built.missing + ', 미해결 ' + built.unresolved);

        if (built.map.size === 0) {
            log('재매칭 가능한 참조가 없습니다.');
            setStatus('로컬 리매핑 대상 없음');
            setProgress(100);
            return;
        }

        let sample = 0;
        for (const pair of built.map.entries()) {
            if (sample >= 20) break;
            log('↻ ' + pair[0] + ' -> ' + pair[1]);
            sample++;
        }
        if (built.map.size > sample) log('... 외 ' + (built.map.size - sample) + '개');

        setProgress(70);
        setStatus('DB 참조 경로 갱신 중...');
        const result = commitLocalReferenceRemap(built.map, currentScanResult);

        log('');
        log('완료. 경로 후보 ' + built.map.size + ', 실제 변경 ' + result.changed + ', 저장호출 ' + (result.committed ? '성공' : '없음/실패'));
        log('파일은 복사/삭제하지 않았습니다. 화면이 바로 안 바뀌면 Risu를 새로고침하세요.');
        setStatus('로컬 캐시 리매핑 완료');
        setProgress(100);
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        try { if (storage) storage.close(); } catch (_) {}
        currentScanResult = null;
        setRunning(false);
    }
}
async function openPanel(table) {
    currentContext = null;
    try {
        const scopeHost = table && table.closest ? table.closest('[data-risu-asset-actions]') : null;
        const scope = scopeHost && scopeHost.getAttribute('data-risu-asset-scope');
        if (scope === 'module' || (!scope && table && isSettingsTable(table))) {
            currentChar = null;
            currentContext = resolveModuleTableContext(table && table.closest ? (table.closest('table.tabler') || table) : table);
            setSub((currentContext.label || '모듈 추가에셋') + ' (module)');
        } else {
            const ch = (!pocketAssetApi() && typeof getCharAsync === 'function')
                ? await getCharAsync()
                : ((typeof getChar === 'function') ? getChar() : null);
            if (!ch) {
                currentChar = null;
                setSub('캐릭터 감지 실패');
            } else {
                currentChar = ch;
                setSub((ch.name || '?') + ' (type: ' + (ch.type || '?') + ')');
            }
        }
    } catch (e) {
        currentChar = null;
        currentContext = null;
        setSub('getChar 예외: ' + e);
    }
    clearLog();
    setProgress(0);
    setStatus('진단 버튼을 눌러주세요');
    currentScanResult = null;
    setBtnEnabled('apply', false);
    setBtnEnabled('remap', false);
    setBtnEnabled('fill', false);
    setBtnEnabled('cache', false);
    updateRecoverySourceUI();
    const ov = $id(PANEL_ID);
    if (ov) ov.classList.add('visible');
}

// =========================================
// Inject a Lucide-style wrench button next to the asset add button.
// =========================================
const WRENCH_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>' +
    '</svg>';
const GLOBE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/>' +
    '<path d="M12 2a15.3 15.3 0 0 1 0 20M12 2a15.3 15.3 0 0 0 0 20"/>' +
    '</svg>';

function isSettingsTable(table) {
    if (!table || !table.closest) return false;
    return !!(
        table.closest('.rs-setting-cont') ||
        table.closest('.rs-setting-cont-2') ||
        table.closest('.rs-setting-cont-3') ||
        table.closest('.rs-setting-cont-4') ||
        table.closest('.rs-setting-cont-5') ||
        table.closest('[class*="rs-setting-cont"]')
    );
}

function cleanupInvalidButtons() {
    let buttons;
    try { buttons = document.querySelectorAll('.' + BTN_CLASS); }
    catch (e) { return; }
    for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        const host = btn.closest ? btn.closest('[data-risu-asset-actions], table.tabler') : null;
        if (!host) {
            btn.remove();
        }
    }
}

function realmAvailabilityKey(char) {
    return [
        char && char.chaId || '',
        recoveryNormalize(char && char.name),
        recoveryNormalize(char && (char.creator || (char.additionalData && char.additionalData.creator))),
        recoveryRealmId(char)
    ].join('|');
}

async function detectRealmAvailability(char) {
    const directId = recoveryRealmId(char);
    if (directId) return { found: true, id: directId, direct: true };
    const key = realmAvailabilityKey(char);
    if (realmAvailabilityCache.has(key)) return await realmAvailabilityCache.get(key);
    const pending = (async () => {
        try {
            const candidates = await findRealmRecoveryCandidates(char);
            const best = candidates[0];
            // Exact title (plus optional creator/asset evidence) normally
            // scores >= .82. Lower scores stay red and require manual review.
            if (best && best.id && best.score >= 0.8) return { found: true, id: best.id, candidate: best };
            return { found: false, id: '', candidates: candidates };
        } catch (error) {
            return { found: false, id: '', error: String(error && error.message || error) };
        }
    })();
    realmAvailabilityCache.set(key, pending);
    return await pending;
}

async function refreshRealmIndicator(button, char) {
    button.dataset.realmState = 'checking';
    button.dataset.realmId = '';
    button.title = '렐름 원본 확인 중';
    const result = await detectRealmAvailability(char);
    if (!button.isConnected) return;
    if (result.found) {
        button.dataset.realmState = 'found';
        button.dataset.realmId = result.id;
        button.title = '렐름 원본 있음 · 깨진 에셋만 복구';
    } else {
        button.dataset.realmState = 'missing';
        button.title = result.error ? '렐름 확인 실패 · 수동 검색 열기' : '확실한 렐름 원본 없음 · 수동 검색 열기';
    }
}

async function openRealmRecoveryFromIndicator(host, button) {
    await openPanel(host);
    switchPanelPage('realm');
    const id = String(button.dataset.realmId || '');
    if (!id) {
        log('자동으로 확정할 렐름 원본이 없습니다. 후보 찾기에서 직접 확인하시기 바랍니다.');
        setStatus('렐름 원본 수동 확인 필요');
        return;
    }
    const input = $id(PANEL_ID + '-realm-id');
    if (input) input.value = id;
    await runRealmAssetRecovery();
}

function injectButtons() {
    cleanupInvalidButtons();
    let hooked;
    try { hooked = Array.from(document.querySelectorAll('[data-risu-asset-actions]')); }
    catch (e) { return; }
    const targets = [];
    if (hooked.length > 0) {
        for (const actions of hooked) targets.push({ host: actions, actions: actions });
    } else {
        // Backward compatibility with Web/Local Risu before the stable hook.
        let tables;
        try { tables = document.querySelectorAll('table.tabler'); }
        catch (e) { return; }
        for (const table of tables || []) {
            const headerRow = table.querySelector('tr');
            const ths = headerRow && headerRow.querySelectorAll('th');
            if (!ths || ths.length !== 2) continue;
            targets.push({ host: table, actions: ths[ths.length - 1] });
        }
    }

    for (const target of targets) {
        const host = target.host;
        const actions = target.actions;
        const plusBtn = actions.querySelector('button:not(.' + BTN_CLASS + ')');
        if (!plusBtn) continue;
        if (!plusBtn.querySelector('svg')) continue;
        actions.style.width = 'auto';
        actions.style.minWidth = '64px';
        actions.style.whiteSpace = 'nowrap';

        let wrench = actions.querySelector('.' + WRENCH_CLASS);
        if (!wrench) {
            wrench = document.createElement('button');
            wrench.className = BTN_CLASS + ' ' + WRENCH_CLASS;
            wrench.type = 'button';
            wrench.title = '에셋 캐시 리매핑';
            wrench.innerHTML = WRENCH_SVG;
            wrench.addEventListener('click', async (e) => {
                e.stopPropagation();
                e.preventDefault();
                await openPanel(host);
            });
            actions.insertBefore(wrench, plusBtn);
        }

        const scopeHost = host.closest ? host.closest('[data-risu-asset-actions]') : null;
        const scope = scopeHost && scopeHost.getAttribute('data-risu-asset-scope');
        if (scope === 'module' || (!scope && isSettingsTable(host))) continue;
        if (actions.querySelector('.' + REALM_CLASS)) continue;
        const realm = document.createElement('button');
        realm.className = BTN_CLASS + ' ' + REALM_CLASS;
        realm.type = 'button';
        realm.dataset.realmState = 'checking';
        realm.title = '렐름 원본 확인 중';
        realm.innerHTML = GLOBE_SVG;
        realm.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            await openRealmRecoveryFromIndicator(host, realm);
        });
        actions.insertBefore(realm, wrench);
        try {
            const char = (typeof getChar === 'function') ? getChar() : null;
            if (char) void refreshRealmIndicator(realm, char);
            else {
                realm.dataset.realmState = 'missing';
                realm.title = '현재 캐릭터를 찾지 못함';
            }
        } catch (_) {
            realm.dataset.realmState = 'missing';
            realm.title = '렐름 원본 확인 실패';
        }
    }
}

function startObserver() {
    if (observer) return;
    try {
        // Use the page MutationObserver directly; v2.1 safeDocument does not expose one.
        observer = new MutationObserver(() => {
            try { injectButtons(); } catch (e) {}
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // Try an immediate injection pass too.
        injectButtons();
    } catch (e) {
        console.warn('[ImageRecovery] observer setup 실패:', e);
    }
}

// =========================================
// Cache remap entry point.
async function runCharCacheRemap() {
    if (isRunning) return;
    if (!currentScanResult || !currentScanResult.refs || currentScanResult.refs.length === 0) {
        log('진단을 먼저 실행해주세요.');
        return;
    }
    if ((currentScanResult.storageMode || assetStorageMode) === 'local') {
        await runLocalAssetRemap();
        return;
    }
    if (!currentScanResult.supportsCache) {
        log('이 저장소 모드에서는 캐시 덮어씌워 리매핑이 적용되지 않습니다.');
        return;
    }
    if (typeof caches === 'undefined') {
        log('caches API 사용 불가');
        return;
    }

    const scope = resultScopeText(currentScanResult) + ' ' + currentScanResult.refs.length + '개 자산';
    if (!confirm(
        scope + '에 대해 원본 에셋 저장소(' + modeLabel(currentScanResult.storageMode || assetStorageMode) + ')를 기준으로\n' +
        'risuCache의 /sw/img/<hex(path)> 항목을 다시 씁니다.\n\n' +
        '원본 저장소에 존재하는 자산만 처리합니다. 계속할까요?'
    )) return;

    setRunning(true);
    setProgress(0);
    setStatus('캐시 덮어씌워 리매핑 중...');
    log('');
    log('--- 캐시 덮어씌워 리매핑 (원본 저장소 -> risuCache) ---');

    let storage = null;
    try {
        const storageMode = currentScanResult.storageMode || assetStorageMode;
        storage = createAssetStorage(storageMode);
        log(await storage.open());
        const cache = await caches.open('risuCache');
        const refs = currentScanResult.refs;
        const origin = location.origin;
        let remapped = 0, skipped = 0, errors = 0;

        const job = await runAdaptiveAssetJobs(refs, async ref => {
                const data = await storage.get(ref.path);
                const size = byteSize(data);
                if (!data || size <= 0) {
                    skipped++;
                } else {
                    const type = await detectImageType(data);
                    const contentType = contentTypeFromDetected(type, ref.path);
                    const encoded = strToHex(ref.path);
                    const url = cacheUrlForAssetPath(ref.path, origin);
                    await cache.put(url, new Response(data, {
                        status: 200,
                        headers: {
                            'content-type': contentType,
                            'cache-control': 'max-age=604800'
                        }
                    }));
                    remapped++;
                    if (remapped <= 20 || remapped % 1000 === 0) {
                        log('✓ ' + ref.path + ' -> /sw/img/' + encoded + ' (' + size + 'B, ' + contentType + ')');
                    }
                }
        }, {
            onFailure: (e, ref) => {
                errors++;
                if (errors <= 20) log('error: ' + ref.path + ': ' + (e && e.message ? e.message : e));
            },
            onProgress: state => {
                setProgress(state.completed / Math.max(1, state.total) * 100);
                setStatus('캐시 덮어씌워 리매핑 ' + state.completed + '/' + state.total + ' · 병렬 ' + state.concurrency);
            },
            onRetry: state => log('일시 오류: 병렬 ' + state.concurrency + '개로 감속, ' + state.waitMs + 'ms 후 재시도'),
        });

        log('');
        log('완료. remap ' + remapped + ', skipped ' + skipped + ', errors ' + errors);
        log('재시도 ' + job.retries + '회');
        setStatus('캐시 덮어씌워 리매핑 완료');
    } catch (e) {
        log('예외: ' + (e && e.message ? e.message : e));
        setStatus('오류');
    } finally {
        try { if (storage) storage.close(); } catch (_) {}
        setRunning(false);
    }
}
makeStyle();
makePanel();
startObserver();

onUnload(() => {
    try {
        if (observer) { observer.disconnect(); observer = null; }
        const ov = $id(PANEL_ID);
        const style = $id(STYLE_ID);
        if (ov) ov.remove();
        if (style) style.remove();
        // Remove injected buttons.
        try {
            const injected = document.querySelectorAll('.' + BTN_CLASS);
            for (let i = 0; i < injected.length; i++) injected[i].remove();
        } catch (_) {}
    } catch (_) {}
});
