const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectAssetReferences, validateInspectionBatch } = require('./plugin-asset-inspection.cjs');
const hash = 'a'.repeat(64);
const uri = 'external://local/' + hash;
function setup(overrides = {}) {
    const record = { uri, size: 12 };
    return {
        statInternal: async () => null,
        runtime: {
            providers: [{ id: 'local', capabilities: { stat: true }, stat: async () => ({ size: 12 }), get: () => assert.fail('binary read') }],
            manifestStore: { get: async () => record, findByInternalKey: async () => record },
            service: { inspectFallbacks: async () => [], readWithMeta: () => assert.fail('binary read') },
        },
        ...overrides,
    };
}
test('internal and external assets use metadata only', async () => {
    const options = setup({ statInternal: async () => 12 });
    const result = await inspectAssetReferences(['assets/x.png', uri], options);
    assert.deepEqual(result.map(item => item.status), ['exists', 'exists']);
});
test('missing internal mapping is missing, but arbitrary host paths are unsupported', async () => {
    const options = setup();
    options.runtime.manifestStore.findByInternalKey = async () => null;
    const result = await inspectAssetReferences(['assets/missing.png', 'C:/secret', 'assets/../database/database.bin', 'https://example.com/x'], options);
    assert.deepEqual(result.map(item => item.status), ['missing', 'unsupported', 'unsupported', 'unsupported']);
});
test('403/network/provider errors are not file absence', async () => {
    const options = setup();
    for (const error of [{ status: 403 }, { code: 'HTTP_NETWORK_ERROR', retryable: true }, { code: 'FILESYSTEM_STAT_FAILED' }]) {
        options.runtime.providers[0].stat = async () => { throw error; };
        assert.equal((await inspectAssetReferences([uri], options))[0].status, 'error');
    }
});
test('404/not-found is missing and fallback restores available status without reads', async () => {
    const options = setup();
    options.runtime.providers[0].stat = async () => { throw { status: 404 }; };
    assert.equal((await inspectAssetReferences([uri], options))[0].status, 'missing');
    options.runtime.service.inspectFallbacks = async () => [{ source: 'trash', available: true, size: 12 }];
    const result = (await inspectAssetReferences([uri], options))[0];
    assert.equal(result.status, 'exists');
    assert.equal(result.source, 'fallback-trash');
});
test('unconfigured/stat-unsupported provider is not missing', async () => {
    const options = setup();
    options.runtime.providers = [];
    assert.equal((await inspectAssetReferences([uri], options))[0].status, 'unsupported');
});
test('size mismatch is an error, and fallback failure remains indeterminate', async () => {
    const options = setup();
    options.runtime.providers[0].stat = async () => ({ size: 13 });
    assert.equal((await inspectAssetReferences([uri], options))[0].code, 'SIZE_MISMATCH');
    options.runtime.providers[0].stat = async () => { throw { code: 'ASSET_NOT_FOUND' }; };
    options.runtime.service.inspectFallbacks = async () => [{ available: false, error: 'EACCES' }];
    assert.equal((await inspectAssetReferences([uri], options))[0].status, 'error');
});
test('batch validation and server lanes are bounded', async () => {
    assert.throws(() => validateInspectionBatch(Array(129).fill(uri)));
    assert.throws(() => validateInspectionBatch([{}]));
    const options = setup();
    let active = 0, peak = 0;
    options.runtime.providers[0].stat = async () => {
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active--;
        return { size: 12 };
    };
    assert.equal((await inspectAssetReferences(Array(20).fill(uri), options)).length, 20);
    assert.equal(peak, 4);
});
test('empty files and absent metadata are not marked healthy', async () => {
    const options = setup({ statInternal: async () => 0 });
    assert.equal((await inspectAssetReferences(['assets/empty.png'], options))[0].code, 'EMPTY_ASSET');
    options.runtime.providers[0].stat = async () => null;
    assert.equal((await inspectAssetReferences([uri], options))[0].code, 'UNKNOWN_METADATA');
    options.runtime.providers[0].stat = async () => ({ size: 0 });
    assert.equal((await inspectAssetReferences([uri], options))[0].code, 'EMPTY_ASSET');
});
