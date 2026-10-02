// Cheap look at a CHARX before importing it.
//
// Bot files that carry thousands of images are very often asset modules in
// disguise, and installing one as a bot writes every asset before anything
// can be undone. A large file is therefore stopped before its first write and
// the user picks bot, module or cancel (largeCharxImport.ts); the import then
// runs as a cancellable transaction (importTransaction.ts). Small files keep
// the old path untouched.
//
// Only the ZIP central directory is read: no entry is decompressed and nothing
// is written, so the check costs the same for a 2 GB archive as for a 2 MB one.

/** Decimal megabytes: 150 MB is exactly 150,000,000 bytes. */
export const LARGE_CHARX_BYTES = 150_000_000
export const LARGE_CHARX_ASSETS = 5_000

export type CharxDestination = 'character' | 'module'

export interface CharxStats {
    bytes: number
    /** Asset entries in the archive; null when its directory could not be read. */
    assets: number | null
}

export type CharxImportPlan =
    | { kind: 'normal' }
    | { kind: 'cancel', stats: CharxStats }
    | { kind: 'guarded', destination: CharxDestination, stats: CharxStats }

export function isCharxFileName(name: string): boolean {
    return name.toLowerCase().endsWith('.charx')
}

/** Either inclusive threshold makes a CHARX large. */
export function isLargeCharx(stats: CharxStats): boolean {
    return stats.bytes >= LARGE_CHARX_BYTES || (stats.assets ?? 0) >= LARGE_CHARX_ASSETS
}

/**
 * Entries the CHARX importer saves as assets (CharXImporter): everything but
 * folders, card.json/other JSON metadata and the embedded module.risum.
 */
export function isCharxAssetEntry(name: string): boolean {
    return !name.endsWith('/') && !name.toLowerCase().endsWith('.json') && name !== 'module.risum'
}

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50
const EOCD_SIZE = 22
const MAX_COMMENT = 65535
const READ_BLOCK = 65536

/**
 * Counts the asset entries of a CHARX from its ZIP central directory.
 * Throws when the archive has no readable directory.
 */
export async function inspectCharx(source: Uint8Array | Blob): Promise<CharxStats> {
    const size = source instanceof Uint8Array ? source.byteLength : source.size
    let cached = new Uint8Array(0)
    let cachedStart = 0
    const read = async (start: number, length: number): Promise<Uint8Array> => {
        if (source instanceof Uint8Array) return source.subarray(start, start + length)
        if (start < cachedStart || start + length > cachedStart + cached.length) {
            cachedStart = start
            cached = new Uint8Array(await source.slice(start, start + Math.max(length, READ_BLOCK)).arrayBuffer())
        }
        return cached.subarray(start - cachedStart, start - cachedStart + length)
    }

    const tailStart = Math.max(0, size - (EOCD_SIZE + MAX_COMMENT))
    const tail = await read(tailStart, size - tailStart)
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
    let end = -1
    for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
        if (view.getUint32(i, true) === EOCD_SIGNATURE && i + EOCD_SIZE + view.getUint16(i + 20, true) === tail.length) {
            end = i
            break
        }
    }
    if (end < 0) throw new Error('CHARX ZIP directory is missing or incomplete')
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) {
        throw new Error('Split CHARX archives are not supported')
    }
    let entries = view.getUint16(end + 10, true)
    let directorySize = view.getUint32(end + 12, true)
    let directoryOffset = view.getUint32(end + 16, true)
    const endOffset = tailStart + end

    if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
        if (endOffset < 20) throw new Error('Invalid CHARX ZIP64 locator')
        const locatorBytes = await read(endOffset - 20, 20)
        const locator = new DataView(locatorBytes.buffer, locatorBytes.byteOffset, locatorBytes.byteLength)
        if (locator.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE || locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) {
            throw new Error('Invalid CHARX ZIP64 locator')
        }
        const offset = Number(locator.getBigUint64(8, true))
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + 56 > endOffset - 20) {
            throw new Error('Invalid CHARX ZIP64 offset')
        }
        const recordBytes = await read(offset, 56)
        const record = new DataView(recordBytes.buffer, recordBytes.byteOffset, recordBytes.byteLength)
        if (record.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE || record.getUint32(16, true) || record.getUint32(20, true)) {
            throw new Error('Invalid CHARX ZIP64 directory')
        }
        entries = Number(record.getBigUint64(32, true))
        directorySize = Number(record.getBigUint64(40, true))
        directoryOffset = Number(record.getBigUint64(48, true))
        if (![entries, directorySize, directoryOffset].every(Number.isSafeInteger)) {
            throw new Error('CHARX ZIP64 directory is too large')
        }
    }
    if (directoryOffset + directorySize > endOffset) throw new Error('Invalid CHARX ZIP directory')

    const decoder = new TextDecoder()
    let assets = 0
    let position = directoryOffset
    for (let i = 0; i < entries; i++) {
        const header = await read(position, 46)
        if (header.length !== 46) throw new Error('Truncated CHARX ZIP entry')
        const entry = new DataView(header.buffer, header.byteOffset, header.byteLength)
        if (entry.getUint32(0, true) !== CENTRAL_ENTRY_SIGNATURE) throw new Error('Invalid CHARX ZIP entry')
        const nameLength = entry.getUint16(28, true)
        const name = decoder.decode(await read(position + 46, nameLength))
        if (isCharxAssetEntry(name)) assets++
        position += 46 + nameLength + entry.getUint16(30, true) + entry.getUint16(32, true)
        if (position > directoryOffset + directorySize) throw new Error('Truncated CHARX ZIP directory')
        // Keep the page responsive on archives with tens of thousands of entries.
        if (i % 2000 === 1999) await new Promise(resolve => setTimeout(resolve, 0))
    }
    return { bytes: size, assets }
}

/** Like inspectCharx, but an unreadable directory only loses the asset count. */
export async function readCharxStats(source: Uint8Array | Blob): Promise<CharxStats> {
    try {
        return await inspectCharx(source)
    } catch {
        return { bytes: source instanceof Uint8Array ? source.byteLength : source.size, assets: null }
    }
}

/**
 * Decides how a CHARX import proceeds. A stream cannot be inspected without
 * consuming it, and neither can a file that is not a CHARX, so both import as
 * before. `ask` resolves the user's choice, or null for cancel.
 */
export async function planCharxImport(
    name: string,
    data: Uint8Array | Blob | ReadableStream<Uint8Array>,
    ask: (stats: CharxStats) => Promise<CharxDestination | null>,
): Promise<CharxImportPlan> {
    if (!isCharxFileName(name) || data instanceof ReadableStream) return { kind: 'normal' }
    const stats = await readCharxStats(data)
    if (!isLargeCharx(stats)) return { kind: 'normal' }
    const destination = await ask(stats)
    return destination ? { kind: 'guarded', destination, stats } : { kind: 'cancel', stats }
}
