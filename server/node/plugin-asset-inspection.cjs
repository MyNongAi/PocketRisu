'use strict';

const { isExternalAssetUri, parseExternalAssetUri } = require('./external-assets.cjs');
const MAX_INSPECTION_BATCH = 128;

function validInternalReference(value) {
    return typeof value === 'string' && value.startsWith('assets/') && value.length <= 2048
        && !value.includes('\\') && !/[\x00-\x1f]/.test(value)
        && value.split('/').slice(1).every((part) => part && part !== '.' && part !== '..');
}

function validateInspectionBatch(paths) {
    if (!Array.isArray(paths) || paths.length > MAX_INSPECTION_BATCH
        || paths.some((value) => typeof value !== 'string' || value.length > 2048)) {
        throw Object.assign(new Error('Expected up to 128 asset references'), { statusCode: 400 });
    }
    return paths;
}

// Metadata only: do not call provider.get(), service.readWithMeta(), or kvGet().
// In particular, a failed stat must never be reported as a missing file.
async function inspectAssetReferences(paths, { statInternal, runtime }) {
    validateInspectionBatch(paths);
    const providers = new Map(runtime.providers.map((provider) => [provider.id, provider]));
    const result = new Array(paths.length);
    let next = 0;
    async function inspect(path) {
        const base = { path, status: 'unknown', size: null };
        try {
            let record;
            if (validInternalReference(path)) {
                const size = await statInternal(path);
                if (Number.isFinite(size)) return size > 0
                    ? { ...base, status: 'exists', source: 'internal', size }
                    : { ...base, status: 'error', code: 'EMPTY_ASSET', size };
                record = await runtime.manifestStore.findByInternalKey(path);
                if (!record) return { ...base, status: 'missing', code: 'INTERNAL_MISSING' };
            } else if (isExternalAssetUri(path)) {
                record = await runtime.manifestStore.get(path);
                if (!record) return { ...base, status: 'missing', code: 'MANIFEST_MISSING' };
            } else {
                return { ...base, status: 'unsupported', code: 'UNSUPPORTED_REFERENCE' };
            }
            const parsed = parseExternalAssetUri(record.uri);
            const provider = providers.get(parsed.providerId);
            let outcome;
            if (!provider || provider.capabilities?.unsupported || provider.capabilities?.stat !== true) {
                outcome = { ...base, status: 'unsupported', code: 'PROVIDER_STAT_UNSUPPORTED' };
            } else {
                try {
                    const info = await provider.stat(parsed.hash);
                    outcome = !info || typeof info !== 'object'
                        ? { ...base, status: 'error', code: 'UNKNOWN_METADATA' }
                        : info.size === 0
                        ? { ...base, status: 'error', code: 'EMPTY_ASSET', size: 0 }
                        : Number.isFinite(record.size) && Number.isFinite(info?.size) && record.size !== info.size
                        ? { ...base, status: 'error', code: 'SIZE_MISMATCH', size: info.size }
                        : { ...base, status: 'exists', source: 'external', size: info?.size ?? null };
                } catch (error) {
                    outcome = {
                        ...base,
                        status: error?.code === 'ASSET_NOT_FOUND' || error?.status === 404 ? 'missing' : 'error',
                        code: String(error?.code || 'PROVIDER_UNAVAILABLE'),
                        retryable: error?.retryable === true,
                    };
                }
            }
            if (outcome.status !== 'exists') {
                const fallbacks = await runtime.service.inspectFallbacks(record.uri);
                const fallback = fallbacks.find((candidate) => candidate.available);
                if (fallback) return {
                    ...base, status: 'exists', source: 'fallback-' + fallback.source,
                    size: fallback.size ?? null, warning: outcome.code,
                };
                // A failed fallback check is also indeterminate, not proof of absence.
                if (outcome.status === 'missing' && fallbacks.some((item) => item.error && item.error !== 'ENOENT')) {
                    return { ...base, status: 'error', code: 'FALLBACK_CHECK_FAILED' };
                }
            }
            return outcome;
        } catch (error) {
            return { ...base, status: 'error', code: String(error?.code || 'INSPECTION_FAILED'), retryable: error?.retryable === true };
        }
    }
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
        while (next < paths.length) {
            const index = next++;
            result[index] = await inspect(paths[index]);
        }
    }));
    return result;
}

module.exports = { MAX_INSPECTION_BATCH, validInternalReference, validateInspectionBatch, inspectAssetReferences };
