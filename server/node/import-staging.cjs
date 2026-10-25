'use strict';

// Unpacks a downloaded bot or module file on the server, so the browser that
// imports it receives only the card data (the user's request, 2026-10-25: a
// Proton import over a phone's mobile data cost about twice the file's size,
// once down to the phone and once back up as assets).
//
// Every asset is written to storage here, as the client's importer would have
// saved it (assets/<sha256>.png, through the same store), and the file sent
// to the client keeps its format with each asset's bytes replaced by a stub
// that names the stored object. The client runs its usual importer on that
// file; saveAsset recognizes a stub of this response by its nonce and returns
// the stored reference without uploading anything (src/ts/stagedAssets.ts).
// The importers themselves are unchanged, so a staged import makes the same
// bot or module a whole-file import makes.
//
// Formats, each read the way its client importer reads it:
// - CHARX (.charx, or a .jpg/.jpeg with the archive after the picture):
//   CharXImporter (src/ts/process/processzip.ts), streaming fflate.Unzip.
// - PNG card: the PNG branch of importCharacterProcess and PngChunk.
// - .risum module: readModule (src/ts/process/modules.ts).
// Anything else, or a file that does not parse, is not staged: the caller
// sends it whole, as before.

const crypto = require('crypto');
const fflate = require('fflate');

const STUB_PREFIX = 'PRSTAGE1:';
// CharXImporter skips entries larger than this.
const MAX_ASSET_SIZE_BYTES = 50 * 1024 * 1024;
// The slices CharXImporter feeds fflate (deep recursion otherwise).
const UNZIP_PUSH_SLICE_BYTES = 32 * 1024;
// Asset writes in flight at once; the unzipper waits for room.
const MAX_PENDING_WRITES = 8;

// src/ts/rpack/rpack_map.bin: bytes 0-255 encode, 256-511 decode.
const RPACK_MAP = Buffer.from(
    'xA0eC70rP1X8RW71ZlNPGuC7MJSGumu/QVBvm+/etxBhFyDfMomonW2ryZAADF2v0sFW5RZkkYJldJfKI9ZS0f+0oOgvilg4WmAZlknb18g7PkNLpWNHqmopkvQVz2I0eNMdPOIFjipXDhvNTC3yQCwleUgPsnq1p2w35px7VH7+h9yaAuQzouuxLgPdmaaw59WIGIN89r7hXJ/DIUYfCE7QdhJf7v2PROqjXosoCTWeacwKx4UHrUrzd+ln1NqEgJO2TXP6JyZ/BMb78XI5UcI2qWis+O3FucvOdaQ9gdlCcByVEbzYjJj5WaET9xR9s+xxwOON8AGuWzEGJCI6uCz3hIvJZfu2n66zAy0BaXQf5KPs7lw0IZNKD2riYgKeIpz9PPxxx8atWWcFcG2KRBL6JIZfr9F6R87+UGPdUQZvGOBSqAmdVnNMuFNsw6AOGc8+DX4HMmhG6kj5mS6rpEkgXlU1OAy807FYFnkoChrh8s3EOduiumBydn2V73/IwN43lL+1FIGSJUWs5/Vmpys2WsET40s66I2DG3wnsJpC64eq3FSOeCbSVynUt/gvj4l18EF3wh7/2BUR5QSXF/Mx0JsA18q0Tyo72bJr2l2hPzBhvZE9Tubfvk2CjB0jEJhk9IUze5BDu6mI8dalHPbMbrlbC5bt1enFywimgEA=',
    'base64',
);
const RPACK_ENCODE = RPACK_MAP.subarray(0, 256);
const RPACK_DECODE = RPACK_MAP.subarray(256, 512);

class StagingStopped extends Error {
    constructor() {
        super('The client stopped waiting for this file');
        this.name = 'StagingStopped';
    }
}

function newStagingNonce() {
    return crypto.randomBytes(16).toString('hex');
}

function rpack(data, map) {
    const out = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i++) out[i] = map[data[i]];
    return out;
}

function sha256Hex(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/** What every asset of these importers is saved as (saveAsset without a file name). */
function assetKeyOf(data) {
    return `assets/${sha256Hex(data)}.png`;
}

function stubBytes(nonce, ref) {
    return Buffer.from(`${STUB_PREFIX}${nonce}:${ref}\n`, 'utf-8');
}

/**
 * Writes assets with a few in flight. `room()` resolves once fewer than
 * MAX_PENDING_WRITES are pending; a failed write surfaces there and in
 * `settle()`, so the promises `write` returns never reject unobserved.
 */
function createAssetWriter(ctx) {
    const pending = new Set();
    const errors = [];
    let count = 0;
    let bytes = 0;
    return {
        /** Resolves to `shape(stub)` once `data` is stored. */
        write(data, shape = (stub) => stub) {
            count++;
            bytes += data.length;
            const stored = Promise.resolve()
                .then(() => ctx.writeAsset(assetKeyOf(data), data))
                .then((ref) => {
                    if (typeof ref !== 'string' || !ref) throw new Error('The asset store returned no reference');
                    return stubBytes(ctx.nonce, ref);
                });
            const tracked = stored.then(() => {}, (error) => { errors.push(error); });
            pending.add(tracked);
            tracked.finally(() => pending.delete(tracked));
            const result = stored.then(shape);
            // Awaited later, after settle(), which reports the failure first.
            result.catch(() => {});
            return result;
        },
        async room() {
            if (ctx.stopped?.()) throw new StagingStopped();
            while (pending.size >= MAX_PENDING_WRITES) await Promise.race(pending);
            if (errors.length > 0) throw errors[0];
        },
        async settle() {
            while (pending.size > 0) await Promise.race(pending);
            if (errors.length > 0) throw errors[0];
            if (ctx.stopped?.()) throw new StagingStopped();
        },
        get count() { return count; },
        get bytes() { return bytes; },
    };
}

// ─── .risum ─────────────────────────────────────────────────────────────────

/** The parts readModule reads, or null when it would refuse the file. */
function parseRisum(buf) {
    try {
        let pos = 0;
        if (buf.readUInt8(pos++) !== 111) return null;
        if (buf.readUInt8(pos++) !== 0) return null;
        const mainLen = buf.readUInt32LE(pos);
        pos += 4;
        const main = buf.subarray(pos, pos + mainLen);
        if (main.length !== mainLen) return null;
        pos += mainLen;
        const parsed = JSON.parse(rpack(main, RPACK_DECODE).toString('utf-8'));
        if (parsed?.type !== 'risuModule') return null;
        const assets = [];
        for (;;) {
            const mark = buf.readUInt8(pos++);
            if (mark === 0) break;
            if (mark !== 1) return null;
            const len = buf.readUInt32LE(pos);
            pos += 4;
            const data = buf.subarray(pos, pos + len);
            if (data.length !== len) return null;
            pos += len;
            assets.push(data);
        }
        // readModule fails an asset without metadata (after retrying for
        // fifteen seconds): leave such a file to it, whole.
        if (assets.length > (Array.isArray(parsed.module?.assets) ? parsed.module.assets.length : 0)) return null;
        return { main, assets };
    } catch {
        // Truncated: readModule throws reading it.
        return null;
    }
}

function lengthBytes(len) {
    const out = Buffer.allocUnsafe(4);
    out.writeUInt32LE(len, 0);
    return out;
}

async function stageRisum(buf, ctx, writer) {
    const parsed = parseRisum(buf);
    if (!parsed) return null;
    const stubs = [];
    for (const data of parsed.assets) {
        await writer.room();
        stubs.push(writer.write(rpack(data, RPACK_DECODE)));
    }
    await writer.settle();
    const parts = [Buffer.from([111, 0]), lengthBytes(parsed.main.length), parsed.main];
    for (const stub of await Promise.all(stubs)) {
        const encoded = rpack(stub, RPACK_ENCODE);
        parts.push(Buffer.from([1]), lengthBytes(encoded.length), encoded);
    }
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
}

// ─── CHARX ──────────────────────────────────────────────────────────────────

/**
 * Streams the archive through fflate.Unzip as CharXImporter does: an entry is
 * read when `wanted(file)` says so, and `onEntry(name, data)` gets it whole.
 */
async function walkZip(buf, wanted, onEntry, writer) {
    const unzip = new fflate.Unzip();
    unzip.register(fflate.UnzipInflate);
    let failure = null;
    unzip.onfile = (file) => {
        if (!wanted(file)) return;
        const parts = [];
        file.ondata = (err, dat, final) => {
            if (err) { failure ??= err; return; }
            if (dat && dat.length) parts.push(Buffer.from(dat.buffer, dat.byteOffset, dat.length));
            if (final) {
                try {
                    onEntry(file.name, Buffer.concat(parts));
                } catch (error) {
                    failure ??= error;
                }
            }
        };
        file.start();
    };
    if (buf.length === 0) unzip.push(new Uint8Array(0), true);
    for (let offset = 0; offset < buf.length; offset += UNZIP_PUSH_SLICE_BYTES) {
        const end = Math.min(offset + UNZIP_PUSH_SLICE_BYTES, buf.length);
        unzip.push(buf.subarray(offset, end), end === buf.length);
        if (failure) throw failure;
        if (writer) await writer.room();
    }
    if (failure) throw failure;
}

/** CharXImporter's test, precedence and all: `originalSize ?? (0 < MAX)`. */
function charxWouldRead(file) {
    // eslint-disable-next-line no-constant-binary-expression
    return Boolean(file.originalSize ?? 0 < MAX_ASSET_SIZE_BYTES);
}

async function stageCharx(buf, ctx, writer) {
    // First look for the card alone: an archive without one is refused by the
    // importer, so none of its assets are stored for nothing.
    let hasCard = false;
    await walkZip(buf, (file) => file.name === 'card.json', () => { hasCard = true; }, null);

    const out = {};
    const stubs = [];
    let moduleData = null;
    await walkZip(buf, charxWouldRead, (name, data) => {
        if (data.length > MAX_ASSET_SIZE_BYTES) return; // CharXImporter excludes it
        if (name === 'card.json') {
            out['card.json'] = [data, { level: 6 }];
        } else if (name === 'module.risum') {
            moduleData = data;
        } else if (name.endsWith('.json')) {
            // Ignored by the importer.
        } else if (hasCard) {
            // Its place in the archive is kept now; the stub fills it.
            out[name] = null;
            stubs.push(writer.write(data, (stub) => { out[name] = [stub, { level: 0 }]; }));
        }
    }, writer);
    if (moduleData) {
        // The bot keeps the module's scripts and lorebook; its assets are
        // saved and stubbed like any other (a module that does not parse
        // goes as it is, and the importer reports it).
        const staged = hasCard ? await stageRisum(moduleData, ctx, writer) : null;
        out['module.risum'] = [staged ?? moduleData, { level: 6 }];
    }
    await writer.settle();
    await Promise.all(stubs);
    // card.json first, then the rest in archive order (the importer reads
    // them in any order; one name twice keeps the last, as it does).
    const ordered = {};
    if (out['card.json']) ordered['card.json'] = out['card.json'];
    for (const [name, entry] of Object.entries(out)) if (name !== 'card.json') ordered[name] = entry;
    return Buffer.from(fflate.zipSync(ordered));
}

// ─── PNG ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const head = Buffer.allocUnsafe(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.allocUnsafe(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

function textChunk(key, value) {
    return pngChunk('tEXt', Buffer.concat([Buffer.from(key, 'utf-8'), Buffer.from([0]), Buffer.from(value, 'utf-8')]));
}

/**
 * The chunks PngChunk.readGenerator(returnTrimed) yields from a whole file,
 * or null when the file is cut off (then it is sent whole, as before).
 */
function readPng(buf) {
    const decoder = new TextDecoder();
    const texts = [];
    const trimmed = [buf.subarray(0, 8)];
    let pos = 8;
    while (pos < buf.length) {
        if (pos + 12 > buf.length) return null;
        const len = buf.readUInt32BE(pos);
        if (pos + 12 + len > buf.length) return null;
        const type = decoder.decode(buf.subarray(pos + 4, pos + 8));
        const chunk = buf.subarray(pos, pos + 12 + len);
        if (type === 'IEND') {
            trimmed.push(chunk);
            break;
        } else if (type === 'tEXt') {
            const data = buf.subarray(pos + 8, pos + 8 + len);
            let key = '';
            let value = '';
            for (let i = 0; i < 70; i++) {
                if (data[i] === 0) {
                    key = decoder.decode(data.subarray(0, i));
                    value = decoder.decode(data.subarray(i + 1));
                    break;
                }
            }
            texts.push({ key, value, chunk });
        } else {
            trimmed.push(chunk);
        }
        pos += 12 + len;
    }
    return { signature: buf.subarray(0, 8), texts, trimmed: Buffer.concat(trimmed) };
}

const PNG_IEND = pngChunk('IEND', Buffer.alloc(0));

async function stagePng(buf, ctx, writer) {
    const png = readPng(buf);
    if (!png) return null;
    // Without a card the importer refuses the file: send the picture-less
    // shell, and store nothing.
    if (!png.texts.some(({ key }) => key === 'chara' || key === 'ccv3')) {
        return Buffer.concat([png.signature, PNG_IEND]);
    }
    const chunks = [];
    for (const text of png.texts) {
        if (text.key === 'chara' || text.key === 'ccv3') {
            chunks.push(Promise.resolve(text.chunk));
        } else if (text.key.startsWith('chara-ext-asset_')) {
            await writer.room();
            chunks.push(writer.write(Buffer.from(text.value, 'base64'), (stub) => textChunk(text.key, stub.toString('base64'))));
        }
        // Other text chunks are ignored by the importer.
    }
    await writer.room();
    // The picture is what is left without the text chunks; the importer
    // saves it as the profile image. Its stub rides in a private chunk, which
    // the importer keeps in that leftover.
    const image = writer.write(png.trimmed, (stub) => pngChunk('prSt', stub));
    await writer.settle();
    return Buffer.concat([png.signature, ...(await Promise.all(chunks)), await image, PNG_IEND]);
}

// ─── Entry point ────────────────────────────────────────────────────────────

/** Which importer format a file name is staged as, or null. */
function stagedFormatOf(name) {
    const lower = String(name).toLowerCase();
    if (lower.endsWith('.charx') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'charx';
    if (lower.endsWith('.png')) return 'png';
    if (lower.endsWith('.risum')) return 'risum';
    return null;
}

/**
 * Stages `buf` (the whole file named `name`). Returns the file to send in
 * its place and what was stored, or null when this file is sent whole.
 *
 * ctx.writeAsset(key, data) stores one asset and resolves to the reference
 * saveAsset would have returned for it (an external:// URI or the key).
 * ctx.stopped() turns true once nobody waits for the result.
 */
async function stageImportFile(name, buf, ctx) {
    const format = stagedFormatOf(name);
    if (!format) return null;
    const writer = createAssetWriter(ctx);
    let data;
    try {
        if (format === 'charx') data = await stageCharx(buf, ctx, writer);
        else if (format === 'png') data = await stagePng(buf, ctx, writer);
        else data = await stageRisum(buf, ctx, writer);
    } finally {
        // Nothing is left running behind a failure.
        await writer.settle().catch(() => {});
    }
    if (!data) return null;
    return { format, data, assets: writer.count, assetBytes: writer.bytes };
}

module.exports = {
    StagingStopped,
    newStagingNonce,
    stageImportFile,
    stagedFormatOf,
    // For tests.
    STUB_PREFIX,
    RPACK_MAP,
    assetKeyOf,
    parseRisum,
    readPng,
    rpack,
    RPACK_ENCODE,
    RPACK_DECODE,
};
