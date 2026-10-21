'use strict';

// Modules nothing uses, kept out of the browser ("보관한 모듈").
//
// A stored module stays in `modules` where it was (name, description, folder,
// favorite, asset manifest descriptor, links), so every list, folder and id
// lookup still finds it. Only its body — the fields that matter while the
// module is on or being edited (COLD_BODY_FIELDS) — moves to a kv row
// `module-cold/<id>/<archivedAt>`, and the entry carries a marker naming that
// row (COLD_MARKER). The browser fetches the body to show or edit the module;
// turning it on or editing it puts the body back in `modules`.
//
// - The move happens on the server, in the storage queue, against the
//   server's own copy (server.cjs /api/modules/cold): the row is written from
//   the module as it stands, then the same queue step removes the body from
//   the database and publishes the change as a db-patch, which every device
//   (the asking one included) lands. An edit from another device cannot slip
//   between the row and the removal.
// - Putting the body back is an ordinary edit from the browser (/api/patch).
// - Rows are immutable and never deleted automatically, like character
//   archive rows: a restored database.bin snapshot still finds its bodies.
//   Rows no stub names are orphans, reclaimed only by the dashboard's purge.
// - Every .bin export puts the bodies back (inlineColdModules), so upstream
//   RisuAI and older builds only ever see complete modules.

const COLD_PREFIX = 'module-cold/';
const COLD_FORMAT_VERSION = 1;
const COLD_MARKER = 'nodeOnlyColdModule';
/** Present only while the module is on or open in the editor. */
const COLD_BODY_FIELDS = Object.freeze(['lorebook', 'regex', 'trigger', 'cjs', 'backgroundEmbedding', 'customModuleToggle']);
// A body smaller than this is not worth a row and a fetch.
const COLD_MIN_BODY_BYTES = 4096;

function isColdableModuleId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 256 && !id.includes('/') && id !== '$embedded';
}
function isValidArchivedAt(v) {
    return Number.isInteger(v) && v > 0;
}
function coldRowId(id, archivedAt) { return `${id}/${archivedAt}`; }
function coldKey(id, archivedAt) { return COLD_PREFIX + coldRowId(id, archivedAt); }

// `module-cold/<id>/<archivedAt>` → { id, archivedAt, rowId } or null.
function parseColdKey(key) {
    if (typeof key !== 'string' || !key.startsWith(COLD_PREFIX)) return null;
    const rowId = key.slice(COLD_PREFIX.length);
    const slash = rowId.lastIndexOf('/');
    if (slash <= 0) return null;
    const id = rowId.slice(0, slash);
    const archivedAt = Number(rowId.slice(slash + 1));
    if (!isColdableModuleId(id) || !isValidArchivedAt(archivedAt)) return null;
    return { id, archivedAt, rowId };
}

/** The marker of a stored module, or null for a module in the database whole. */
function coldMarkerOf(module) {
    const marker = module && typeof module === 'object' ? module[COLD_MARKER] : null;
    return marker && typeof marker === 'object' && isValidArchivedAt(marker.archivedAt) ? marker : null;
}

function moduleBodyOf(module) {
    const body = {};
    for (const field of COLD_BODY_FIELDS) {
        if (module && Object.hasOwn(module, field) && module[field] !== undefined) body[field] = module[field];
    }
    return body;
}

function countOf(value) {
    return Array.isArray(value) ? value.length : 0;
}

/**
 * The module whole again: the stub's own fields (its catalog entry, which
 * may have changed while stored) with the row's body. The row's body wins
 * over a body field someone wrote into the stub meanwhile: that can only be
 * a partial write, and the row is what the module held.
 */
function mergeColdBody(stub, body) {
    const merged = { ...stub };
    delete merged[COLD_MARKER];
    for (const field of COLD_BODY_FIELDS) delete merged[field];
    for (const field of COLD_BODY_FIELDS) {
        if (body && Object.hasOwn(body, field) && body[field] !== undefined) merged[field] = body[field];
    }
    return merged;
}

function splitList(value) {
    return typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Everything that can turn a module on (process/modules.ts getModules): the
 * global list, every live bot's and chat's own list, and the module
 * integration of the settings and of every prompt preset (a preset hands its
 * list over when chosen). A name there matches a module's id or namespace.
 * Deactivated bots are not counted: activating one brings its modules back.
 * Mirrored by src/ts/process/moduleCold.ts referencedModuleNames.
 */
function referencedModuleNames(db) {
    const names = new Set();
    const addAll = (list) => {
        if (!Array.isArray(list)) return;
        for (const name of list) if (typeof name === 'string' && name) names.add(name);
    };
    addAll(db?.enabledModules);
    for (const name of splitList(db?.moduleIntergration)) names.add(name);
    for (const preset of Array.isArray(db?.botPresets) ? db.botPresets : []) {
        for (const name of splitList(preset?.moduleIntergration)) names.add(name);
    }
    for (const character of Array.isArray(db?.characters) ? db.characters : []) {
        addAll(character?.modules);
        for (const chat of Array.isArray(character?.chats) ? character.chats : []) addAll(chat?.modules);
    }
    return names;
}

function isModuleReferenced(module, names) {
    return names.has(module?.id) || (!!module?.namespace && names.has(module.namespace));
}

/** Why `module` cannot be stored now, or null. */
function coldRefusal(module, names, bodyBytes) {
    if (!module || typeof module !== 'object') return 'MODULE_NOT_FOUND';
    if (!isColdableModuleId(module.id)) return 'MODULE_BAD_ID';
    if (coldMarkerOf(module)) return 'MODULE_ALREADY_COLD';
    // An MCP module is a link to a server, not a body.
    if (module.mcp) return 'MODULE_MCP';
    if (isModuleReferenced(module, names)) return 'MODULE_IN_USE';
    if (bodyBytes < COLD_MIN_BODY_BYTES) return 'MODULE_TOO_SMALL';
    return null;
}

/**
 * Stored modules of a decoded database whose marker is new or names another
 * row than `prev` had, and whose row does not exist: a stub that would
 * point at nothing. `prev` may be undefined (cold write).
 */
function findDanglingColdModules(prev, next, hasRow) {
    const out = [];
    const before = new Map();
    for (const module of Array.isArray(prev?.modules) ? prev.modules : []) {
        const marker = coldMarkerOf(module);
        if (marker && module.id) before.set(module.id, marker.archivedAt);
    }
    for (const module of Array.isArray(next?.modules) ? next.modules : []) {
        const marker = coldMarkerOf(module);
        if (!marker) continue;
        if (before.get(module.id) === marker.archivedAt) continue;
        if (!hasRow(module.id, marker.archivedAt)) out.push(`${module.id}@${marker.archivedAt}`);
    }
    return out;
}

function patchTouchesModules(patch) {
    if (!Array.isArray(patch)) return true;
    return patch.some((op) => typeof op?.path === 'string' && (op.path === '' || op.path.startsWith('/modules')));
}

function createModuleColdStore({ kvGet, kvSet, kvDel, kvSize, kvList, encode, decode, normalize, hash, now = () => Date.now() }) {
    function hasRow(id, archivedAt) {
        return (kvSize(coldKey(id, archivedAt)) || 0) > 0;
    }

    // Decoded body of a row, or null when absent. Throws when the row exists
    // but is not this module's body at this version.
    async function readBody(id, archivedAt) {
        const raw = kvGet(coldKey(id, archivedAt));
        if (!raw) return null;
        const payload = normalize(await decode(raw));
        if (!payload || payload.id !== id || payload.archivedAt !== archivedAt
            || !payload.body || typeof payload.body !== 'object' || Array.isArray(payload.body)) {
            throw new Error(`stored module malformed: ${coldRowId(id, archivedAt)}`);
        }
        return payload.body;
    }

    /**
     * Write and read back the row for `module` (a live entry of the database).
     * Resolves to the marker the entry gets. The database is left alone.
     */
    async function writeRow(module) {
        const body = normalize(moduleBodyOf(module));
        let archivedAt = now();
        while (kvSize(coldKey(module.id, archivedAt))) archivedAt++;
        const encoded = encode({ v: COLD_FORMAT_VERSION, id: module.id, archivedAt, body });
        kvSet(coldKey(module.id, archivedAt), encoded);
        try {
            const verified = await readBody(module.id, archivedAt);
            if (!verified || hash(verified) !== hash(body)) throw new Error('read-back does not match');
        } catch (error) {
            kvDel(coldKey(module.id, archivedAt));
            throw new Error(`stored module verification failed for ${module.id}: ${error?.message || error}`);
        }
        return {
            archivedAt,
            bytes: encoded.length,
            lorebookCount: countOf(body.lorebook),
            regexCount: countOf(body.regex),
            triggerCount: countOf(body.trigger),
        };
    }

    /**
     * Store the modules `ids` of `db` (the server's live copy). Writes the
     * rows and returns the ops that take the bodies out, one result per id.
     * Ids that cannot be stored now (in use, already stored, …) are skipped
     * with a code; the database itself is not touched here.
     */
    async function planCold(db, ids) {
        const modules = Array.isArray(db?.modules) ? db.modules : [];
        const names = referencedModuleNames(db);
        const ops = [];
        const results = [];
        for (const id of ids) {
            const index = modules.findIndex((m) => m?.id === id);
            const module = index >= 0 ? modules[index] : null;
            const body = module ? moduleBodyOf(module) : {};
            const refusal = coldRefusal(module, names, module ? Buffer.byteLength(JSON.stringify(body)) : 0);
            if (refusal) {
                results.push({ id, ok: false, code: refusal });
                continue;
            }
            let marker;
            try {
                marker = await writeRow(module);
            } catch (error) {
                // The module stays whole; the others still go.
                results.push({ id, ok: false, code: 'MODULE_COLD_FAILED', error: String(error?.message || error) });
                continue;
            }
            for (const field of Object.keys(body)) ops.push({ op: 'remove', path: `/modules/${index}/${field}` });
            ops.push({ op: 'add', path: `/modules/${index}/${COLD_MARKER}`, value: marker });
            results.push({ id, ok: true, marker });
        }
        return { ops, results };
    }

    /**
     * Put the bodies back into a decoded database (export paths). Mutates
     * and returns `dbObj`. Throws COLD_MODULE_MISSING when a row is gone.
     */
    async function inlineColdModules(dbObj) {
        if (!Array.isArray(dbObj?.modules)) return dbObj;
        const missing = [];
        for (let i = 0; i < dbObj.modules.length; i++) {
            const module = dbObj.modules[i];
            const marker = coldMarkerOf(module);
            if (!marker) continue;
            let body = null;
            try { body = await readBody(module.id, marker.archivedAt); } catch { body = null; }
            if (!body) {
                missing.push(module.name || module.id);
                continue;
            }
            dbObj.modules[i] = mergeColdBody(module, body);
        }
        if (missing.length > 0) {
            const err = new Error(`Stored module data missing: ${missing.join(', ')}`);
            err.code = 'COLD_MODULE_MISSING';
            throw err;
        }
        return dbObj;
    }

    function referencedRowIds(dbObj) {
        const out = new Set();
        for (const module of Array.isArray(dbObj?.modules) ? dbObj.modules : []) {
            const marker = coldMarkerOf(module);
            if (marker && module.id) out.add(coldRowId(module.id, marker.archivedAt));
        }
        return out;
    }

    // Rows no stub of `dbObj` names, older than `graceMs` (a row just written
    // is named by no stub until its db-patch is in).
    function listOrphanRows(dbObj, graceMs) {
        const referenced = referencedRowIds(dbObj);
        const youngest = now() - graceMs;
        const rows = [];
        let bytes = 0;
        for (const key of kvList(COLD_PREFIX)) {
            const parsed = parseColdKey(key);
            if (parsed && (referenced.has(parsed.rowId) || parsed.archivedAt > youngest)) continue;
            const size = kvSize(key) || 0;
            rows.push({ key, size });
            bytes += size;
        }
        return { rows, bytes };
    }

    return { hasRow, readBody, writeRow, planCold, inlineColdModules, referencedRowIds, listOrphanRows };
}

module.exports = {
    COLD_PREFIX,
    COLD_MARKER,
    COLD_BODY_FIELDS,
    COLD_MIN_BODY_BYTES,
    coldMarkerOf,
    mergeColdBody,
    moduleBodyOf,
    referencedModuleNames,
    isModuleReferenced,
    coldRefusal,
    findDanglingColdModules,
    patchTouchesModules,
    parseColdKey,
    createModuleColdStore,
};
