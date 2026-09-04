const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/plugins/ImageRecovery.js'), 'utf8');
function context(extra = {}) {
    const elements = new Map();
    const document = { getElementById: id => elements.get(id) || null };
    const sandbox = vm.createContext({ document, navigator: { userAgent: 'Desktop' }, setTimeout, clearTimeout,
        TextEncoder, TextDecoder, Response, Uint8Array, ArrayBuffer, location: { origin: 'http://localhost:6001' }, ...extra });
    vm.runInContext(source.slice(0, source.lastIndexOf('\nmakeStyle();')), sandbox);
    return { sandbox, elements, run: code => vm.runInContext(code, sandbox) };
}
test('scheduler retries transient failures, lowers concurrency, and processes every item exactly once successfully', async () => {
    const { sandbox } = context();
    const attempts = new Map(), successes = [], progress = [], retries = [];
    const result = await sandbox.runAdaptiveAssetJobs([1, 2, 3, 4, 5], async item => {
        attempts.set(item, (attempts.get(item) || 0) + 1);
        if (item === 1 && attempts.get(item) < 3) throw new Error('Failed to fetch');
        successes.push(item);
    }, { concurrency: 4, delay: async () => {}, onRetry: state => retries.push(state), onProgress: state => progress.push(state) });
    assert.equal(result.completed, 5);
    assert.equal(result.failed, 0);
    assert.equal(result.retries, 2);
    assert.deepEqual(successes.sort(), [1, 2, 3, 4, 5]);
    assert.deepEqual(retries.map(item => item.concurrency), [2, 1]);
    assert.ok(progress.length <= 2);
});
test('permanent failure is not retried and mobile work is bounded to two lanes', async () => {
    const { sandbox } = context({ navigator: { userAgent: 'Android' } });
    let failures = 0, attempts = 0;
    const result = await sandbox.runAdaptiveAssetJobs([1], async () => { attempts++; throw new Error('403 Forbidden'); }, { onFailure: () => failures++ });
    assert.equal(attempts, 1);
    assert.equal(failures, 1);
    assert.equal(result.concurrency, 2);
});
test('external references and Pocket URL previews are collected', () => {
    const { sandbox } = context();
    const uri = 'external://local/' + 'b'.repeat(64);
    const refs = sandbox.collectCharRefs({ image: uri });
    assert.equal(refs[0].path, uri);
    assert.equal(sandbox.assetPathFromSrc('/api/external-assets/content/' + Buffer.from(uri).toString('hex')), uri);
});
test('manifest diagnostic pages stay bounded and do not download binaries', async () => {
    const { sandbox } = context();
    const offsets = [];
    const api = { getAssetManifestPage: async (_manifest, { offset, limit }) => {
        offsets.push(offset);
        assert.equal(limit, 128);
        return { total: 260, items: Array.from({ length: Math.min(limit, 260 - offset) }, (_, i) => ['asset', 'assets/' + (offset + i) + '.png']) };
    } };
    let count = 0;
    for await (const refs of sandbox.pocketOwnerReferencePages({ name: 'test', additionalAssetManifest: { id: 'm' } }, 'character', api)) count += refs.length;
    assert.equal(count, 260);
    assert.deepEqual(offsets, [0, 128, 256]);
});
test('empty/truncated manifest fails instead of claiming complete diagnosis', async () => {
    const { sandbox } = context();
    const pages = sandbox.pocketOwnerReferencePages({ assetManifest: { id: 'm' } }, 'module', { getAssetManifestPage: async () => ({ total: 2, items: [] }) });
    await assert.rejects(pages.next(), /Manifest/);
});
test('Pocket all scan excludes trash, includes modules, separates errors, and never touches browser cache or readImage', async () => {
    const checked = [];
    const { sandbox, run } = context({
        getDatabase: () => ({ characters: [{ chaId: 'a', name: 'active', image: 'assets/a.png' }, { chaId: 't', trashTime: 1, image: 'assets/trash.png' }], modules: [{ id: 'm', assets: [['x', 'assets/module.png']] }] }),
        Risuai: { assetStorageInfo: () => ({ kind: 'pocket' }), inspectAssets: async paths => {
            checked.push(...paths);
            return paths.map(path => ({ path, status: path.includes('module') ? 'error' : 'exists', code: 'EACCES' }));
        } },
        readImage: () => assert.fail('must not read image'),
        caches: { open: () => assert.fail('must not use SW cache') },
    });
    await sandbox.runCharScan('all');
    assert.deepEqual(checked, ['assets/a.png', 'assets/module.png']);
    assert.equal(run('currentScanResult.summary.missing'), 0);
    assert.equal(run('currentScanResult.summary.error'), 1);
    assert.equal(run('currentScanResult.supportsCache'), false);
});
test('Pocket diagnosis failure never becomes missing and unknown module is rejected', async () => {
    const { sandbox, run } = context({ Risuai: { assetStorageInfo: () => ({ kind: 'pocket' }), inspectAssets: async () => [] } });
    run("currentContext = { type: 'module', owner: null, refs: [{ path: 'assets/only-visible.png' }] }");
    await sandbox.runPocketAssetScan('current');
    assert.equal(run('currentScanResult'), null);
    assert.ok(run("logBuf.some(line => line.includes('현재 모듈 ID'))"));
});
test('V2.1 runtime makes the bridge available through Risuai without global credential access', () => {
    const core = fs.readFileSync(path.join(__dirname, '../src/ts/plugins/plugins.svelte.ts'), 'utf8');
    assert.match(core, /const Risuai = globalThis\.__pluginApis__/);
    assert.match(core, /inspectAssets: async/);
    assert.match(core, /forageStorage\.inspectAssetReferences\(paths\)/);
    const server = fs.readFileSync(path.join(__dirname, '../server/node/server.cjs'), 'utf8');
    assert.match(server, /app\.post\('\/api\/assets\/inspect',[\s\S]*?if \(!await checkAuth\(req, res\)\) return/);
});
test('recovery refuses to overwrite on access errors and supports external missing references', async () => {
    let status = 'error';
    const { sandbox } = context({ Risuai: {
        assetStorageInfo: () => ({ kind: 'pocket' }),
        inspectAssets: async paths => paths.map(path => ({ path, status, code: 'EACCES' })),
    } });
    const uri = 'external://local/' + 'a'.repeat(64);
    await assert.rejects(sandbox.recoveryReferenceMissing(uri), /덮어쓰지/);
    status = 'exists';
    assert.equal(await sandbox.recoveryReferenceMissing(uri), false);
    status = 'missing';
    assert.equal(await sandbox.recoveryReferenceMissing(uri), true);
});
test('switching characters cancels recovery and source manifest hydration is read-only', async () => {
    const { sandbox, run } = context({
        Risuai: { assetStorageInfo: () => ({ kind: 'pocket' }), getAssetManifestPage: async () => ({ total: 1, items: [['a', 'assets/a.png']] }) },
        getCharAsync: async () => ({ chaId: 'new' }),
    });
    run("currentChar = { chaId: 'old' }");
    await assert.rejects(sandbox.refreshCurrentRecoveryCharacter(), /변경/);
    const sourceChar = { additionalAssetManifest: { id: 'manifest' } };
    const hydrated = await sandbox.hydrateRecoverySourceCharacter(sourceChar);
    assert.equal(hydrated.additionalAssets.length, 1);
    assert.equal(sourceChar.additionalAssets, undefined);
});
