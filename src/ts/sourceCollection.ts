import { sha256HexPortable } from './cryptoFallback'

export const SOURCE_COLLECTION_FORMAT = 'pocketrisu-source-collection'
export const SOURCE_COLLECTION_VERSION = 1
/**
 * A part is intentionally kept well below the old 96 MiB ceiling. JSON text,
 * its parsed string and a decoded Uint8Array can coexist briefly on mobile.
 */
export const SOURCE_COLLECTION_MAX_PART_BYTES = 32 * 1024 * 1024
export const SOURCE_COLLECTION_MAX_ASSET_BYTES = 16 * 1024 * 1024

export type SourceCollectionKind = 'characters' | 'modules' | 'personas'

export interface SourceImportInfo {
    label: string
    bundleId: string
    importedAt: number
    /** Links independently downloaded character/module bundles from one export session. */
    collectionId?: string
    /** Original source id, retained only where another imported entity may reference it. */
    originalId?: string
    /** Pending source module ids; never used directly by the live module loader. */
    originalModuleIds?: string[]
}

export interface SourceCollectionAsset {
    path: string
    data: string
    size: number
    sha256: string
}

export interface SourceCollectionOmittedAsset {
    path: string
    size: number
    reason: 'too-large' | 'read-failed'
}

export interface SourceCollectionPart {
    format: typeof SOURCE_COLLECTION_FORMAT
    version: typeof SOURCE_COLLECTION_VERSION
    bundleId: string
    /** Optional in v1 for compatibility with collection files made before relationship support. */
    collectionId?: string
    kind: SourceCollectionKind
    sourceLabel: string
    createdAt: number
    partIndex: number
    last: boolean
    entities: unknown[]
    assets: SourceCollectionAsset[]
    omittedAssets: SourceCollectionOmittedAsset[]
}

export interface SourceCollectionHeader {
    bundleId: string
    collectionId?: string
    kind: SourceCollectionKind
    sourceLabel: string
    createdAt: number
    partIndex: number
    last: boolean
}

const bundleIdPattern = /^[a-zA-Z0-9._-]{8,128}$/
const sha256Pattern = /^[a-f0-9]{64}$/
const embeddedAssetPattern = /(^|[^a-zA-Z0-9_/])assets\/[^\s"'`()<>\\{}\[\],;]+/g
const MAX_ENTITIES_PER_PART = 10_000
const MAX_ASSETS_PER_PART = 10_000
const MAX_OMITTED_ASSETS_PER_PART = 10_000
const MAX_ENTITY_GRAPH_NODES = 2_000_000
const MAX_ENTITY_DEPTH = 64
const MAX_ENTITY_STRING_LENGTH = 8 * 1024 * 1024
const MAX_ENTITY_KEY_LENGTH = 4096

function isSafeAssetPath(value: string): boolean {
    if (!value.startsWith('assets/') || value.length > 512) return false
    const name = value.slice('assets/'.length)
    return !!name && name !== '.' && name !== '..' && ![/[\/\\]/, /[\u0000-\u001f\u007f]/].some((pattern) => pattern.test(name))
}

function expectedBase64Length(size: number): number {
    return Math.ceil(size / 3) * 4
}

function hasCanonicalBase64Shape(value: string, size: number): boolean {
    if (value.length !== expectedBase64Length(size)) return false
    const padding = size === 0 || size % 3 === 0 ? 0 : 3 - (size % 3)
    const contentLength = value.length - padding
    for (let index = 0; index < contentLength; index++) {
        const code = value.charCodeAt(index)
        const valid =
            (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            code === 43 ||
            code === 47
        if (!valid) return false
    }
    for (let index = contentLength; index < value.length; index++) {
        if (value.charCodeAt(index) !== 61) return false
    }
    return true
}

function validateEntityPayloads(entities: unknown[]): void {
    let nodes = 0
    const seen = new WeakSet<object>()
    const stack = entities.map((value) => ({ value, depth: 0 }))
    while (stack.length > 0) {
        const current = stack.pop()!
        nodes += 1
        if (nodes > MAX_ENTITY_GRAPH_NODES) throw new Error('Collection entity payload is too complex')
        if (current.depth > MAX_ENTITY_DEPTH) throw new Error('Collection entity payload is nested too deeply')

        const value = current.value
        if (typeof value === 'string') {
            if (value.length > MAX_ENTITY_STRING_LENGTH) throw new Error('Collection entity string is too large')
            continue
        }
        if (value === null || typeof value === 'boolean') continue
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new Error('Collection entity contains a non-finite number')
            continue
        }
        if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
            throw new Error('Collection entity contains a non-JSON value')
        }
        if (seen.has(value)) throw new Error('Collection entity payload contains a cycle or shared object')
        seen.add(value)

        if (Array.isArray(value)) {
            for (const item of value) stack.push({ value: item, depth: current.depth + 1 })
            continue
        }
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (key.length > MAX_ENTITY_KEY_LENGTH) throw new Error('Collection entity key is too large')
            stack.push({ value: item, depth: current.depth + 1 })
        }
    }
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
    return value as Record<string, unknown>
}

export function parseSourceCollectionPart(value: unknown): SourceCollectionPart {
    const source = requireRecord(value, 'Collection part must be an object')
    if (source.format !== SOURCE_COLLECTION_FORMAT || source.version !== SOURCE_COLLECTION_VERSION) {
        throw new Error('Unsupported source collection format')
    }
    if (typeof source.bundleId !== 'string' || !bundleIdPattern.test(source.bundleId)) {
        throw new Error('Invalid collection bundle id')
    }
    if (source.collectionId !== undefined && (
        typeof source.collectionId !== 'string' || !bundleIdPattern.test(source.collectionId)
    )) {
        throw new Error('Invalid collection relationship id')
    }
    if (source.kind !== 'characters' && source.kind !== 'modules' && source.kind !== 'personas') {
        throw new Error('Invalid collection kind')
    }
    if (
        typeof source.sourceLabel !== 'string' ||
        !source.sourceLabel.trim() ||
        source.sourceLabel.length > 120 ||
        /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/i.test(source.sourceLabel)
    ) {
        throw new Error('Invalid collection source label')
    }
    if (!Number.isSafeInteger(source.createdAt) || Number(source.createdAt) <= 0) {
        throw new Error('Invalid collection creation time')
    }
    if (!Number.isSafeInteger(source.partIndex) || Number(source.partIndex) < 0) {
        throw new Error('Invalid collection part index')
    }
    if (
        typeof source.last !== 'boolean' ||
        !Array.isArray(source.entities) ||
        !Array.isArray(source.assets) ||
        (source.omittedAssets !== undefined && !Array.isArray(source.omittedAssets))
    ) {
        throw new Error('Invalid collection part payload')
    }
    const rawOmittedAssets = (source.omittedAssets ?? []) as unknown[]
    if (
        source.entities.length > MAX_ENTITIES_PER_PART ||
        source.assets.length > MAX_ASSETS_PER_PART ||
        rawOmittedAssets.length > MAX_OMITTED_ASSETS_PER_PART
    ) {
        throw new Error('Collection part contains too many entries')
    }
    validateEntityPayloads(source.entities)

    const assets = source.assets.map((rawAsset, index): SourceCollectionAsset => {
        const asset = requireRecord(rawAsset, `Invalid asset at index ${index}`)
        if (typeof asset.path !== 'string' || !isSafeAssetPath(asset.path)) {
            throw new Error(`Invalid asset path at index ${index}`)
        }
        if (typeof asset.data !== 'string') throw new Error(`Invalid asset data at index ${index}`)
        if (
            !Number.isSafeInteger(asset.size) ||
            Number(asset.size) < 0 ||
            Number(asset.size) > SOURCE_COLLECTION_MAX_ASSET_BYTES
        ) {
            throw new Error(`Invalid asset size at index ${index}`)
        }
        if (!hasCanonicalBase64Shape(asset.data, Number(asset.size))) {
            throw new Error(`Invalid asset base64 at index ${index}`)
        }
        if (typeof asset.sha256 !== 'string' || !sha256Pattern.test(asset.sha256)) {
            throw new Error(`Invalid asset hash at index ${index}`)
        }
        return {
            path: asset.path,
            data: asset.data,
            size: Number(asset.size),
            sha256: asset.sha256,
        }
    })

    const omittedAssets = rawOmittedAssets.map((rawAsset, index): SourceCollectionOmittedAsset => {
        const asset = requireRecord(rawAsset, `Invalid omitted asset at index ${index}`)
        if (typeof asset.path !== 'string' || !isSafeAssetPath(asset.path)) {
            throw new Error(`Invalid omitted asset path at index ${index}`)
        }
        if (!Number.isSafeInteger(asset.size) || Number(asset.size) < 0) {
            throw new Error(`Invalid omitted asset size at index ${index}`)
        }
        if (asset.reason === 'too-large') {
            if (Number(asset.size) <= SOURCE_COLLECTION_MAX_ASSET_BYTES) {
                throw new Error(`Invalid oversized omitted asset size at index ${index}`)
            }
            return { path: asset.path, size: Number(asset.size), reason: 'too-large' }
        }
        if (asset.reason === 'read-failed') {
            if (Number(asset.size) !== 0) {
                throw new Error(`Invalid unreadable omitted asset size at index ${index}`)
            }
            return { path: asset.path, size: 0, reason: 'read-failed' }
        }
        throw new Error(`Invalid omitted asset reason at index ${index}`)
    })

    const suppliedPaths = new Set(assets.map((asset) => asset.path))
    for (const omitted of omittedAssets) {
        if (suppliedPaths.has(omitted.path)) {
            throw new Error(`Asset cannot be both supplied and omitted: ${omitted.path}`)
        }
    }

    return {
        format: SOURCE_COLLECTION_FORMAT,
        version: SOURCE_COLLECTION_VERSION,
        bundleId: source.bundleId,
        collectionId: source.collectionId as string | undefined,
        kind: source.kind,
        sourceLabel: source.sourceLabel.trim(),
        createdAt: Number(source.createdAt),
        partIndex: Number(source.partIndex),
        last: source.last,
        entities: source.entities,
        assets,
        omittedAssets,
    }
}

export function sourceCollectionHeader(part: SourceCollectionPart): SourceCollectionHeader {
    return {
        bundleId: part.bundleId,
        collectionId: part.collectionId,
        kind: part.kind,
        sourceLabel: part.sourceLabel,
        createdAt: part.createdAt,
        partIndex: part.partIndex,
        last: part.last,
    }
}

export function validateSourceCollectionHeaders(headers: readonly SourceCollectionHeader[]): SourceCollectionHeader[] {
    if (headers.length === 0) throw new Error('No collection parts were selected')
    const [first] = headers
    for (const header of headers) {
        if (
            header.bundleId !== first.bundleId ||
            header.collectionId !== first.collectionId ||
            header.kind !== first.kind ||
            header.sourceLabel !== first.sourceLabel ||
            header.createdAt !== first.createdAt
        ) {
            throw new Error('Collection parts belong to different bundles')
        }
    }
    const sorted = [...headers].sort((a, b) => a.partIndex - b.partIndex)
    for (let index = 0; index < sorted.length; index++) {
        if (sorted[index].partIndex !== index) throw new Error(`Collection part ${index} is missing or duplicated`)
        if (sorted[index].last !== (index === sorted.length - 1)) {
            throw new Error('Collection end marker is missing or appears before the final part')
        }
    }
    return sorted
}

function collectStrings(value: unknown, output: Set<string>, seen: WeakSet<object>): void {
    if (typeof value === 'string') {
        if (isSafeAssetPath(value)) output.add(value)
        embeddedAssetPattern.lastIndex = 0
        for (const match of value.matchAll(embeddedAssetPattern)) {
            const token = match[0].slice(match[1]?.length ?? 0)
            if (isSafeAssetPath(token)) output.add(token)
        }
        return
    }
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, output, seen)
    } else {
        for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, output, seen)
    }
}

export function collectSourceCollectionAssetPaths(value: unknown): string[] {
    const output = new Set<string>()
    collectStrings(value, output, new WeakSet())
    return [...output].sort((a, b) => a.localeCompare(b))
}

export function validateSourceCollectionAssetCoverage(
    entities: unknown,
    assetPaths: Iterable<string>,
): void {
    const referenced = new Set(collectSourceCollectionAssetPaths(entities))
    const supplied = new Set(assetPaths)
    for (const path of referenced) {
        if (!supplied.has(path)) throw new Error(`Referenced asset is missing from collection: ${path}`)
    }
    for (const path of supplied) {
        if (!referenced.has(path)) throw new Error(`Unreferenced asset is present in collection: ${path}`)
    }
}

export function safeCollectionAssetFileName(path: string): string {
    const name = path.slice('assets/'.length)
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
    return /^[a-zA-Z0-9]{1,12}$/.test(extension) ? `collection.${extension.toLowerCase()}` : 'collection.bin'
}

function rewriteString(value: string, mapping: ReadonlyMap<string, string>): string {
    if (mapping.has(value)) return mapping.get(value) ?? value
    embeddedAssetPattern.lastIndex = 0
    return value.replace(embeddedAssetPattern, (match, prefix: string) => {
        const token = match.slice(prefix.length)
        const replacement = mapping.get(token)
        return replacement !== undefined ? `${prefix}${replacement}` : match
    })
}

function rewriteValue(value: unknown, mapping: ReadonlyMap<string, string>, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === 'string') return rewriteString(value, mapping)
    if (!value || typeof value !== 'object') return value
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
    const old = seen.get(value)
    if (old) return old
    if (Array.isArray(value)) {
        const next: unknown[] = []
        seen.set(value, next)
        for (const item of value) next.push(rewriteValue(item, mapping, seen))
        return next
    }
    // A collection is untrusted JSON. A null-prototype target prevents an own
    // "__proto__" key from invoking Object.prototype's legacy setter while
    // references are rewritten.
    const next: Record<string, unknown> = Object.create(null)
    seen.set(value, next)
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        next[key] = rewriteValue(item, mapping, seen)
    }
    return next
}

export function rewriteSourceCollectionAssets<T>(value: T, mapping: ReadonlyMap<string, string>): T {
    return rewriteValue(value, mapping, new WeakMap()) as T
}

export function bytesToBase64(bytes: Uint8Array): string {
    let result = ''
    const chunkSize = 0x8000
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
    }
    return btoa(result)
}

export function base64ToBytes(value: string): Uint8Array {
    const decoded = atob(value)
    const bytes = new Uint8Array(decoded.length)
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index)
    return bytes
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const subtle = globalThis.crypto?.subtle
    if (typeof subtle?.digest === 'function') {
        try {
            const digest = await subtle.digest('SHA-256', bytes as BufferSource)
            return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
        } catch {
            // Insecure mobile WebViews sometimes expose a partial Crypto object
            // whose digest still rejects. The constant-memory fallback below is
            // deterministic and does not weaken integrity verification.
        }
    }
    return sha256HexPortable(bytes)
}

export async function decodeAndVerifyCollectionAsset(asset: SourceCollectionAsset): Promise<Uint8Array> {
    if (
        !Number.isSafeInteger(asset.size) ||
        asset.size < 0 ||
        asset.size > SOURCE_COLLECTION_MAX_ASSET_BYTES
    ) {
        throw new Error(`Invalid asset encoding: ${asset.path}`)
    }
    if (asset.data.length !== expectedBase64Length(asset.size)) {
        throw new Error(`Asset size mismatch: ${asset.path}`)
    }
    if (!hasCanonicalBase64Shape(asset.data, asset.size)) {
        throw new Error(`Asset size mismatch or invalid base64 encoding: ${asset.path}`)
    }
    const bytes = base64ToBytes(asset.data)
    if (bytes.length !== asset.size) throw new Error(`Asset size mismatch: ${asset.path}`)
    if (await sha256Hex(bytes) !== asset.sha256) throw new Error(`Asset hash mismatch: ${asset.path}`)
    return bytes
}
