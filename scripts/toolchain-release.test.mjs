import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveName, selectRelease, targets } from './toolchain-release.mjs';

test('release gate selects one complete stable release instead of mixing platform versions', () => {
    const complete = { tag_name: 'toolchain-v2.0.0', assets: targets.map((target) => ({ name: archiveName(target) })) };
    const partial = { tag_name: 'toolchain-v3.0.0', assets: [{ name: archiveName('win32-x64') }] };
    assert.equal(selectRelease([partial, complete]), complete);
    assert.equal(selectRelease([{ ...complete, draft: true }, { ...complete, prerelease: true }]), undefined);
    for (const missing of targets) assert.equal(selectRelease([{ ...complete, assets: complete.assets.filter((asset) => asset.name !== archiveName(missing)) }]), undefined);
    assert.equal(archiveName('win32-arm64'), 'teal-win32-arm64.zip');
    assert.equal(archiveName('alpine-arm64'), 'teal-alpine-arm64.tar.gz');
    assert.throws(() => archiveName('web'), /Unsupported target/);
});
