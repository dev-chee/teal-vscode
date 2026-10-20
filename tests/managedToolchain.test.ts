import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { parseSha256Digest, releaseAssetName, releaseApiUrl, validateAssetUrl, verifySha256 } from '../src/toolchainDownloadCore';

test('managed toolchain release URLs and asset names are deterministic', () => {
    assert.equal(releaseApiUrl('latest'), 'https://api.github.com/repos/dev-chee/teal/releases?per_page=50');
    assert.equal(releaseApiUrl('v0.1.0'), 'https://api.github.com/repos/dev-chee/teal/releases/tags/v0.1.0');
    assert.equal(releaseAssetName('teal', 'win32-x64'), 'teal-win32-x64.zip');
    assert.equal(releaseAssetName('teal-lsp', 'linux-x64'), 'teal-linux-x64.tar.gz');
});

test('managed toolchain requires HTTPS assets and valid SHA-256 digests', () => {
    const bytes = new TextEncoder().encode('teal fixture');
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(parseSha256Digest(`sha256:${digest}`), digest);
    assert.equal(verifySha256(bytes, digest), true);
    assert.equal(verifySha256(bytes, '0'.repeat(64)), false);
    assert.doesNotThrow(() => validateAssetUrl('https://github.com/dev-chee/teal-lang/releases/download/v0.1.0/teal-win32-x64.exe'));
    assert.throws(() => validateAssetUrl('http://example.invalid/tool'), /HTTPS/);
});

test('Windows ARM64 uses ZIP and Unix targets use tar.gz', () => {
    assert.equal(releaseAssetName('teal', 'win32-arm64'), 'teal-win32-arm64.zip');
    for (const target of ['darwin-arm64', 'linux-armhf', 'alpine-x64'] as const) {
        assert.equal(releaseAssetName('teal', target), `teal-${target}.tar.gz`);
    }
});
