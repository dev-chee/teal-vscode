import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { downloadVerifiedAsset } from '../src/toolchainTransferCore.cjs';

function digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

async function* chunks(...values: Uint8Array[]): AsyncGenerator<Uint8Array> {
    for (const value of values) yield value;
}

test('toolchain transfer streams, verifies, and atomically publishes an archive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-transfer-'));
    const destination = path.join(root, 'toolchain.tar.gz');
    const bytes = Buffer.from('streamed archive payload');
    try {
        let requested = false;
        const result = await downloadVerifiedAsset({
            name: 'toolchain.tar.gz', size: bytes.length, digest: `sha256:${digest(bytes)}`,
            browser_download_url: 'https://fixture.invalid/toolchain.tar.gz',
        }, destination, {
            timeoutMs: 1_000,
            fetcher: async (url: string, options: RequestInit) => {
                requested = true;
                assert.equal(url, 'https://fixture.invalid/toolchain.tar.gz');
                assert.ok(options.signal);
                return {
                    ok: true, status: 200, statusText: 'OK', body: chunks(bytes.subarray(0, 8), bytes.subarray(8)),
                    arrayBuffer: async () => { throw new Error('the transfer must not buffer the response'); },
                };
            },
        });
        assert.equal(requested, true);
        assert.equal(result.bytes, bytes.length);
        assert.deepEqual(await readFile(destination), bytes);
        assert.deepEqual(await readdir(root), ['toolchain.tar.gz']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('toolchain transfer removes partial files after digest or size failures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-transfer-failure-'));
    const destination = path.join(root, 'toolchain.tar.gz');
    const bytes = Buffer.from('four');
    const asset = {
        name: 'toolchain.tar.gz', size: bytes.length, digest: `sha256:${'0'.repeat(64)}`,
        browser_download_url: 'https://fixture.invalid/toolchain.tar.gz',
    };
    const fetcher = async () => ({ ok: true, status: 200, statusText: 'OK', body: chunks(bytes) });
    try {
        await assert.rejects(downloadVerifiedAsset(asset, destination, { fetcher, timeoutMs: 1_000 }), /does not match/);
        assert.deepEqual(await readdir(root), []);
        await assert.rejects(downloadVerifiedAsset({ ...asset, digest: `sha256:${digest(bytes)}` }, destination, {
            fetcher, timeoutMs: 1_000, maxBytes: bytes.length - 1,
        }), /too large/);
        assert.deepEqual(await readdir(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
