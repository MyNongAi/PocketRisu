'use strict';

// applyPatch(document, patch, true) and applyOperation(document, op, true,
// true, true, index) with fast-json-patch's decisions, for a rejected op
// cheaply.
//
// fast-json-patch 3.1.1 formats every JsonPatchError message with the
// document it was handed, JSON.stringify(tree, null, 2), twice (PatchError in
// helpers.js), and with validation on the document reaches an error from two
// places: validator(), which applyOperation calls with the document once the
// path walk finds the first missing key or reaches the last one, and
// applyOperation's own throws (TEST_OPERATION_FAILED, OPERATION_OP_INVALID
// at the root, OPERATION_PATH_ILLEGAL_ARRAY_INDEX,
// OPERATION_VALUE_OUT_OF_BOUNDS and OPERATION_PATH_UNRESOLVABLE). On a copy
// of the real 267MB client view one rejected op cost about 2.6 s of main
// thread and took heapUsed to about 2.6 GB, all of it for a message that
// compactPatchError (server.cjs) then cuts to its first line. validator()'s
// move/copy check also looks `from` up in a JSON copy of the whole document,
// on success as well.
//
// applyValidatedOperation first walks the op through the document the way
// applyOperation does and throws the first JsonPatchError applyOperation
// would throw, with the same name, index, operation and first message line
// but without the document. Only an op that passes the walk reaches
// applyOperation itself, with a validate callback that does what `true`
// does but hands validator() a placeholder instead of the document. A
// rejection the walk missed is still made there (at the library's cost).
//
// The walk mirrors core.js of fast-json-patch 3.1.1 (the version the lockfile
// pins; patch-validated-apply.test.ts checks it and fuzzes the two against
// each other). It assumes a plain JSON document, which the database views
// are (normalizeJSON at load, JSON request bodies): validator() looks `from`
// up in a JSON round trip of the document, here in the document itself.

const { applyOperation, applyPatch, validator, JsonPatchError, _areEquals } = require('fast-json-patch');
const { isInteger, unescapePathComponent } = require('fast-json-patch/commonjs/helpers.js');

// What validator() and the errors below get instead of the document.
// validator() only tests it for truthiness (its move/copy lookup is done
// here, on the document).
const DOCUMENT_PLACEHOLDER = '[document omitted]';

// The ops applyOperation handles at path "". validator() also lets through
// any Object.prototype member name ('toString', 'constructor', ...); at the
// root those are OPERATION_OP_INVALID, below it applyOperation calls them
// (see throwIfTestFails).
const ROOT_OPS = new Set(['add', 'replace', 'move', 'copy', 'test', 'remove', '_get']);

// A JsonPatchError as fast-json-patch builds it, without the document. The
// operation is set afterwards so that its value is not formatted either.
function patchError(message, name, index, operation) {
    const error = new JsonPatchError(message, name, index, undefined, DOCUMENT_PLACEHOLDER);
    error.operation = operation;
    return error;
}

// validator()'s `from` check for move and copy:
// validate([{ op: '_get', path: from }], document) applies that op with
// validation to a JSON copy of the document and fails the move or copy only
// on OPERATION_PATH_UNRESOLVABLE; a throw that is not a JsonPatchError (the
// prototype ban) propagates. _get only reads.
function fromIsUnresolvable(document, from) {
    try {
        applyValidatedOperation(document, { op: '_get', path: from, value: undefined }, 0);
    } catch (error) {
        if (error instanceof JsonPatchError) return error.name === 'OPERATION_PATH_UNRESOLVABLE';
        throw error;
    }
    return false;
}

// The path walk's validator call: with `true`, applyOperation calls
// validator(operation, 0, document, existingPathFragment).
function validateAgainstDocument(operation, index, document, existingPathFragment) {
    if (document && (operation.op === 'move' || operation.op === 'copy')) {
        validator(operation, index);
        if (fromIsUnresolvable(document, operation.from)) {
            throw patchError('Cannot perform the operation from a path that does not exist', 'OPERATION_FROM_UNRESOLVABLE', index, operation);
        }
        return;
    }
    validator(operation, index, document && DOCUMENT_PLACEHOLDER, existingPathFragment);
}

// A validateOperation callback for one applyOperation call. applyOperation
// calls it first as (operation, 0, document, operation.path), where `true`
// makes it call validator(operation, 0) without the document, and then from
// the path walk.
function createValidateCallback() {
    let first = true;
    return function validateOperation(operation, index, document, existingPathFragment) {
        if (!first) return validateAgainstDocument(operation, index, document, existingPathFragment);
        first = false;
        validator(operation, index);
    };
}

// applyOperation(document, operation, true, true, true, index) up to the
// point where it applies the op: throws the first JsonPatchError it would
// throw. Returns where it would apply the op, and where it would throw
// something else instead (the prototype ban), which it then throws itself.
// Kept in step with core.js line by line; validator errors carry index 0
// there, the walk's own ones the op's index.
function throwFirstPatchError(document, operation, index) {
    validator(operation, 0);
    if (operation.path === '') {
        if (!ROOT_OPS.has(operation.op)) {
            throw patchError('Operation `op` property is not one of operations defined in RFC-6902', 'OPERATION_OP_INVALID', index, operation);
        }
        if (operation.op === 'test' && !_areEquals(document, operation.value)) {
            throw patchError('Test operation failed', 'TEST_OPERATION_FAILED', index, operation);
        }
        return;
    }
    const keys = operation.path.split('/');
    const len = keys.length;
    let obj = document;
    let t = 1;
    let existingPathFragment;
    while (true) {
        let key = keys[t];
        if (key && key.indexOf('~') !== -1) key = unescapePathComponent(key);
        if (key === '__proto__' || (key === 'prototype' && keys[t - 1] === 'constructor')) return;
        if (existingPathFragment === undefined) {
            if (obj[key] === undefined) existingPathFragment = keys.slice(0, t).join('/');
            else if (t === len - 1) existingPathFragment = operation.path;
            if (existingPathFragment !== undefined) validateAgainstDocument(operation, 0, document, existingPathFragment);
        }
        t++;
        if (Array.isArray(obj)) {
            if (key === '-') {
                key = obj.length;
            } else if (!isInteger(key)) {
                throw patchError('Expected an unsigned base-10 integer value, making the new referenced value the array element with the zero-based index', 'OPERATION_PATH_ILLEGAL_ARRAY_INDEX', index, operation);
            } else {
                key = ~~key;
            }
            if (t >= len) {
                if (operation.op === 'add' && key > obj.length) {
                    throw patchError('The specified index MUST NOT be greater than the number of elements in the array', 'OPERATION_VALUE_OUT_OF_BOUNDS', index, operation);
                }
                throwIfTestFails(obj, key, operation, index);
                return;
            }
        } else if (t >= len) {
            throwIfTestFails(obj, key, operation, index);
            return;
        }
        obj = obj[key];
        if (t < len && (!obj || typeof obj !== 'object')) {
            throw patchError('Cannot perform operation at the desired path', 'OPERATION_PATH_UNRESOLVABLE', index, operation);
        }
    }
}

// At the apply point applyOperation runs objOps[operation.op] (the name
// coerced to a string) and throws TEST_OPERATION_FAILED when the value it
// returns has test === false: the test op when the values differ, and two
// Object.prototype names validator() lets through, valueOf (returns the op)
// and constructor (Object, returns the container).
function throwIfTestFails(obj, key, operation, index) {
    const name = String(operation.op);
    const failed = name === 'test' ? !_areEquals(obj[key], operation.value)
        : name === 'valueOf' ? operation.test === false
        : name === 'constructor' ? obj.test === false
        : false;
    if (failed) throw patchError('Test operation failed', 'TEST_OPERATION_FAILED', index, operation);
}

// applyOperation(document, operation, true, true, true, index): the same
// result, or a throw of the same kind; a JsonPatchError is built without the
// document.
function applyValidatedOperation(document, operation, index) {
    try {
        throwFirstPatchError(document, operation, index);
    } catch (error) {
        if (error instanceof JsonPatchError) throw error;
        // Anything else (a walk into null, the ban inside a `from`):
        // applyOperation gets there too and throws it itself.
    }
    return applyOperation(document, operation, createValidateCallback(), true, true, index);
}

// applyPatch(document, patch, true), op by op through applyValidatedOperation.
function applyValidatedPatch(document, patch) {
    // Its SEQUENCE_NOT_AN_ARRAY error carries no document.
    if (!Array.isArray(patch)) return applyPatch(document, patch, true);
    const results = new Array(patch.length);
    for (let i = 0; i < patch.length; i++) {
        results[i] = applyValidatedOperation(document, patch[i], i);
        document = results[i].newDocument;
    }
    results.newDocument = document;
    return results;
}

module.exports = {
    applyValidatedOperation,
    applyValidatedPatch,
    DOCUMENT_PLACEHOLDER,
};
