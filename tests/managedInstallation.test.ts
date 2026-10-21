import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { ExtensionContext } from 'vscode';
import { currentManagedToolchainTarget, installManagedToolchain, loadManagedToolchain, updateManagedToolchain } from '../src/managedToolchain';
import { executableName, toolchainTargets } from '../src/platform';
import { releaseAssetName } from '../src/toolchainDownloadCore';

const target = currentManagedToolchainTarget();
assert.ok(target, 'installation regressions require a supported native host');
const nativeTarget = target;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Defect = 'missing-runtime' | 'corrupt-runtime' | 'empty-tool' | 'missing-resource' | 'bad-manifest' | 'unsafe-path' | 'non-executable';

async function archive(root: string, name: string, defect?: Defect) {
    const fixture = path.join(root, name);
    const bundle = path.join(fixture, 'bundle');
    await mkdir(path.join(bundle, 'runtime'), { recursive: true });
    for (const tool of ['teal', 'teal-lsp', 'teal-dap', 'teal-fmt']) {
        const file = path.join(bundle, executableName(tool));
        await writeFile(file, defect === 'empty-tool' && tool === 'teal' ? '' : 'fixture executable');
        await chmod(file, defect === 'non-executable' && tool === 'teal' ? 0o600 : 0o755);
    }
    const content = Buffer.from(`runtime ${name}`);
    await writeFile(path.join(bundle, 'runtime/resource.txt'), content);
    const manifest = { formatVersion: defect === 'bad-manifest' ? 99 : 1, files: [{
        path: defect === 'unsafe-path' ? '../outside.txt' : 'resource.txt', size: content.length,
        sha256: defect === 'corrupt-runtime' ? '0'.repeat(64) : digest(content),
    }] };
    await writeFile(path.join(bundle, 'runtime/manifest.json'), JSON.stringify(manifest));
    if (defect === 'missing-runtime') await rm(path.join(bundle, 'runtime'), { recursive: true });
    if (defect === 'missing-resource') await rm(path.join(bundle, 'runtime/resource.txt'));
    const packed = path.join(fixture, 'fixture.tar.gz');
    // tar 在 Windows 和 Unix 均按内容识别格式；夹具只验证安装入口，不执行假工具。
    const result = spawnSync('tar', ['-czf', packed, '-C', fixture, 'bundle'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const bytes = await readFile(packed);
    return { bytes, release: { id: parseInt(digest(Buffer.from(name)).slice(0, 8), 16) + 1, tag_name: `toolchain-v${/v(\d+)$/.exec(name)?.[1] ?? 2}.0.0`, assets: toolchainTargets.map(platform => ({
        name: releaseAssetName('teal', platform), browser_download_url: `https://fixture.invalid/${name}`,
        digest: `sha256:${digest(bytes)}`, size: bytes.length,
    })) } };
}

function context(root: string): ExtensionContext {
    return { globalStorageUri: { fsPath: path.join(root, 'storage') } } as ExtensionContext;
}
const statePath = (ctx: ExtensionContext) => path.join(ctx.globalStorageUri.fsPath, 'managed-toolchain/current.json');

test('real installer selects the complete release, preserves runtime and reuses a validated cache', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-install-entry-')));
    try {
        const valid = await archive(root, 'complete-v1');
        const ctx = context(root);
        let downloads = 0;
        let metadata = 0;
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
            if (String(input).startsWith('https://api.github.com/')) {
                metadata++;
                return Response.json([{ tag_name: 'toolchain-v2.0.0', assets: valid.release.assets.slice(0, 1) }, valid.release]);
            }
            downloads++;
            return new Response(valid.bytes);
        });
        const installed = await installManagedToolchain(ctx, 'latest', nativeTarget);
        assert.equal(installed.release, 'toolchain-v1.0.0');
        assert.equal(await readFile(path.join(installed.directory, 'runtime/resource.txt'), 'utf8'), 'runtime complete-v1');
        assert.equal(await loadManagedToolchain(ctx), installed.directory);
        assert.deepEqual(await installManagedToolchain(ctx, 'latest', nativeTarget), installed);
        assert.equal(metadata, 2, 'latest must be resolved before reusing a cache');
        assert.equal(downloads, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('real installer rejects invalid distributions without changing the previous installation', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-install-reject-')));
    try {
        let selected = await archive(root, 'valid-v1');
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => String(input).startsWith('https://api.github.com/')
            ? Response.json([selected.release]) : new Response(selected.bytes));
        const ctx = context(root);
        const installed = await installManagedToolchain(ctx, 'latest', nativeTarget);
        const before = await readFile(statePath(ctx), 'utf8');
        const defects: Defect[] = ['missing-runtime', 'corrupt-runtime', 'empty-tool', 'missing-resource', 'bad-manifest', 'unsafe-path'];
        if (process.platform !== 'win32') defects.push('non-executable');
        for (const defect of defects) {
            selected = await archive(root, `invalid-${defect}`, defect);
            await assert.rejects(installManagedToolchain(ctx, 'latest', nativeTarget), defect);
            assert.equal(await readFile(statePath(ctx), 'utf8'), before, defect);
            assert.equal(await loadManagedToolchain(ctx), installed.directory, defect);
            assert.equal(await readFile(path.join(installed.directory, 'runtime/resource.txt'), 'utf8'), 'runtime valid-v1');
            assert.deepEqual((await readdir(path.dirname(statePath(ctx)))).sort(), ['current.json', 'installations']);
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('real installer repairs corrupt runtime and empty executables in a same-tag cache', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-install-repair-')));
    try {
        const valid = await archive(root, 'complete-v1');
        let downloads = 0;
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
            if (String(input).startsWith('https://api.github.com/')) return Response.json([valid.release]);
            downloads++;
            return new Response(valid.bytes);
        });
        const ctx = context(root);
        const installed = await installManagedToolchain(ctx, 'latest', nativeTarget);
        for (const file of ['runtime/resource.txt', executableName('teal')]) {
            await writeFile(path.join(installed.directory, file), '');
            assert.equal(await loadManagedToolchain(ctx), undefined, file);
            const repaired = await installManagedToolchain(ctx, 'latest', nativeTarget);
            assert.notEqual(repaired.directory, installed.directory);
            assert.equal(repaired.release, installed.release);
            assert.equal(await loadManagedToolchain(ctx), repaired.directory);
            installed.directory = repaired.directory;
        }
        assert.equal(downloads, 3);
    } finally { await rm(root, { recursive: true, force: true }); }
});

type CommitFault = 'move' | 'open' | 'write' | 'sync' | 'close' | 'publish';

test('real installer preserves the old selection on commit I/O failures and can retry', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-install-rollback-')));
    try {
        const old = await archive(root, 'v1');
        const next = await archive(root, 'v2');
        let selected = old;
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => String(input).startsWith('https://api.github.com/')
            ? Response.json([selected.release]) : new Response(selected.bytes));
        const ctx = context(root);
        const installed = await installManagedToolchain(ctx, 'latest', nativeTarget);
        const before = await readFile(statePath(ctx), 'utf8');
        selected = next;
        const realOpen = fs.open.bind(fs);
        const realRename = fs.rename.bind(fs);
        for (const fault of ['move', 'open', 'write', 'sync', 'close', 'publish'] as CommitFault[]) {
            await t.test(fault, async sub => {
                const failure = Object.assign(new Error(`injected ${fault}`), { code: fault === 'write' ? 'ENOSPC' : 'EACCES' });
                sub.mock.method(fs, 'rename', async (...[source, destination]: Parameters<typeof fs.rename>) => {
                    if ((fault === 'move' && String(destination).includes(`${path.sep}installations${path.sep}`))
                        || (fault === 'publish' && String(destination) === statePath(ctx))) throw failure;
                    return realRename(source, destination);
                });
                sub.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
                    if (fault === 'open') throw failure;
                    const handle = await realOpen(...args);
                    if (fault === 'write') {
                        const write = handle.writeFile.bind(handle);
                        sub.mock.method(handle, 'writeFile', async () => { await write('{"directory":'); throw failure; });
                    }
                    if (fault === 'sync') sub.mock.method(handle, 'sync', async () => { throw failure; });
                    if (fault === 'close') {
                        const close = handle.close.bind(handle);
                        sub.mock.method(handle, 'close', async () => { await close(); throw failure; });
                    }
                    return handle;
                });
                await assert.rejects(installManagedToolchain(ctx, 'latest', nativeTarget), error => error === failure);
                assert.equal(await readFile(statePath(ctx), 'utf8'), before);
                assert.equal(await loadManagedToolchain(ctx), installed.directory);
                assert.equal(await readFile(path.join(installed.directory, 'runtime/resource.txt'), 'utf8'), 'runtime v1');
                assert.ok(!(await readdir(path.dirname(statePath(ctx)))).some(name => name.startsWith('.staging-')));
            });
        }
        const recovered = await installManagedToolchain(ctx, 'latest', nativeTarget);
        assert.equal(recovered.release, 'toolchain-v2.0.0');
        assert.equal(await loadManagedToolchain(ctx), recovered.directory);
        assert.equal(await readFile(path.join(installed.directory, 'runtime/resource.txt'), 'utf8'), 'runtime v1');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('same-tag repair does not delete the previous generation when publishing fails', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-install-same-tag-')));
    try {
        const valid = await archive(root, 'v1');
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => String(input).startsWith('https://api.github.com/')
            ? Response.json([valid.release]) : new Response(valid.bytes));
        const ctx = context(root);
        const installed = await installManagedToolchain(ctx, 'latest', nativeTarget);
        const before = await readFile(statePath(ctx), 'utf8');
        await writeFile(path.join(installed.directory, 'runtime/resource.txt'), 'corrupt');
        const realRename = fs.rename.bind(fs);
        const fault = t.mock.method(fs, 'rename', async (...[source, destination]: Parameters<typeof fs.rename>) => {
            if (String(destination) === statePath(ctx)) throw Object.assign(new Error('injected publish failure'), { code: 'EACCES' });
            return realRename(source, destination);
        });
        await assert.rejects(installManagedToolchain(ctx, 'latest', nativeTarget), /injected publish/);
        assert.equal(await readFile(statePath(ctx), 'utf8'), before);
        assert.equal(await readFile(path.join(installed.directory, executableName('teal')), 'utf8'), 'fixture executable');
        fault.mock.restore();
        const repaired = await installManagedToolchain(ctx, 'latest', nativeTarget);
        assert.notEqual(repaired.directory, installed.directory);
        assert.equal(await loadManagedToolchain(ctx), repaired.directory);
        assert.equal(await readFile(path.join(repaired.directory, 'runtime/resource.txt'), 'utf8'), 'runtime v1');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('a publication error after rename is reconciled without deleting the selected generation', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-install-published-')));
    try {
        const valid = await archive(root, 'v1');
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => String(input).startsWith('https://api.github.com/')
            ? Response.json([valid.release]) : new Response(valid.bytes));
        const ctx = context(root);
        const rename = fs.rename.bind(fs);
        t.mock.method(fs, 'rename', async (...[source, destination]: Parameters<typeof fs.rename>) => {
            await rename(source, destination);
            if (String(destination) === statePath(ctx)) throw Object.assign(new Error('injected lost acknowledgment'), { code: 'EIO' });
        });
        const installed = await installManagedToolchain(ctx, 'latest', nativeTarget);
        assert.equal(await loadManagedToolchain(ctx), installed.directory);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('rollback cleanup failure preserves the previous installation and a later retry succeeds', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-install-cleanup-')));
    try {
        let selected = await archive(root, 'v1');
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => String(input).startsWith('https://api.github.com/')
            ? Response.json([selected.release]) : new Response(selected.bytes));
        const ctx = context(root);
        const installed = await installManagedToolchain(ctx, 'latest', nativeTarget);
        const before = await readFile(statePath(ctx), 'utf8');
        selected = await archive(root, 'v2');
        const primary = Object.assign(new Error('injected state open'), { code: 'ENOSPC' });
        const cleanup = Object.assign(new Error('injected rollback cleanup'), { code: 'EACCES' });
        const originalRm = fs.rm.bind(fs);
        const openFault = t.mock.method(fs, 'open', async () => { throw primary; });
        const rmFault = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
            if (String(args[0]).includes(`${path.sep}installations${path.sep}`)) throw cleanup;
            return originalRm(...args);
        });
        await assert.rejects(installManagedToolchain(ctx, 'latest', nativeTarget), error => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [primary, cleanup]);
            return true;
        });
        assert.equal(await readFile(statePath(ctx), 'utf8'), before);
        assert.equal(await loadManagedToolchain(ctx), installed.directory);
        openFault.mock.restore();
        rmFault.mock.restore();
        const recovered = await installManagedToolchain(ctx, 'latest', nativeTarget);
        assert.equal(await loadManagedToolchain(ctx), recovered.directory);
        assert.equal(recovered.release, 'toolchain-v2.0.0');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unconfirmed publication keeps the selected data and remains recoverable', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-install-uncertain-')));
    try {
        const valid = await archive(root, 'v1');
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => String(input).startsWith('https://api.github.com/')
            ? Response.json([valid.release]) : new Response(valid.bytes));
        const ctx = context(root);
        const rename = fs.rename.bind(fs);
        const read = fs.readFile.bind(fs);
        let publicationFailed = false;
        t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
            await rename(...args);
            if (String(args[1]) === statePath(ctx)) {
                publicationFailed = true;
                throw Object.assign(new Error('injected publication acknowledgment'), { code: 'EIO' });
            }
        });
        const readFault = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
            if (publicationFailed && String(args[0]) === statePath(ctx)) throw new Error('injected confirmation read');
            return read(...args);
        });
        await assert.rejects(installManagedToolchain(ctx, 'latest', nativeTarget), /publication acknowledgment/);
        readFault.mock.restore();
        const selected = JSON.parse(await readFile(statePath(ctx), 'utf8'));
        assert.equal(await loadManagedToolchain(ctx), selected.directory);
        assert.equal(await readFile(path.join(selected.directory, 'runtime/resource.txt'), 'utf8'), 'runtime v1');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent installations cannot roll back a different successful generation', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-install-concurrent-')));
    try {
        let selected = await archive(root, 'v1');
        let concurrent = false;
        let metadataReads = 0;
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
            if (String(input).startsWith('https://api.github.com/')) {
                if (concurrent) {
                    metadataReads++;
                }
                return Response.json([selected.release]);
            }
            return new Response(selected.bytes);
        });
        const ctx = context(root);
        const previous = await installManagedToolchain(ctx, 'latest', nativeTarget);
        selected = await archive(root, 'v2');
        concurrent = true;
        const rename = fs.rename.bind(fs);
        let failed = false;
        t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
            if (String(args[1]) === statePath(ctx) && !failed) {
                failed = true;
                throw new Error('injected one concurrent failure');
            }
            return rename(...args);
        });
        const results = await Promise.allSettled([
            installManagedToolchain(ctx, 'latest', nativeTarget),
            installManagedToolchain(ctx, 'latest', nativeTarget),
        ]);
        const successes = results.filter(result => result.status === 'fulfilled');
        assert.equal(successes.length, 1);
        assert.equal(metadataReads, 2, "the lock serializes metadata and publication across installers");
        assert.equal(await loadManagedToolchain(ctx), successes[0].value.directory);
        assert.equal(await readFile(path.join(previous.directory, 'runtime/resource.txt'), 'utf8'), 'runtime v1');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('combined state write and close failures are preserved without changing the selection', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-install-double-io-')));
    try {
        let selected = await archive(root, 'v1');
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => String(input).startsWith('https://api.github.com/')
            ? Response.json([selected.release]) : new Response(selected.bytes));
        const ctx = context(root);
        const installed = await installManagedToolchain(ctx, 'latest', nativeTarget);
        selected = await archive(root, 'v2');
        const originalOpen = fs.open.bind(fs);
        const writeError = new Error('injected write failure');
        const closeError = new Error('injected close failure');
        t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
            const handle = await originalOpen(...args);
            const close = handle.close.bind(handle);
            t.mock.method(handle, 'writeFile', async () => { throw writeError; });
            t.mock.method(handle, 'close', async () => { await close(); throw closeError; });
            return handle;
        });
        await assert.rejects(installManagedToolchain(ctx, 'latest', nativeTarget), error => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [writeError, closeError]);
            return true;
        });
        assert.equal(await loadManagedToolchain(ctx), installed.directory);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('temporary cleanup failure after publication cannot undo a successful installation', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-install-committed-')));
    try {
        const valid = await archive(root, 'v1');
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => String(input).startsWith('https://api.github.com/')
            ? Response.json([valid.release]) : new Response(valid.bytes));
        const ctx = context(root);
        const originalRm = fs.rm.bind(fs);
        t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
            if (path.basename(String(args[0])).startsWith('.staging-')) throw new Error('injected post-commit cleanup');
            return originalRm(...args);
        });
        const installed = await installManagedToolchain(ctx, 'latest', nativeTarget);
        assert.equal(await loadManagedToolchain(ctx), installed.directory);
        assert.deepEqual(await installManagedToolchain(ctx, 'latest', nativeTarget), installed);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('background updates share throttling, honor pins, migrate provenance and never downgrade', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-auto-install-')));
    try {
        let selected = await archive(root, 'v1');
        let metadata = 0, downloads = 0;
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
            if (String(input).startsWith('https://api.github.com/')) { metadata++; return Response.json(String(input).includes('/tags/') ? selected.release : [selected.release]); }
            downloads++; return new Response(selected.bytes);
        });
        const ctx = context(root);
        const first = await updateManagedToolchain(ctx, 'latest', nativeTarget);
        assert.ok(first);
        assert.equal(first.repository, 'dev-chee/teal-vscode');
        assert.ok(first.releaseId);
        assert.deepEqual(await updateManagedToolchain(ctx, 'latest', nativeTarget), first);
        assert.equal(metadata, 1);
        selected = await archive(root, 'v2');
        const next = await updateManagedToolchain(ctx, 'latest', nativeTarget, { force: true });
        assert.equal(next?.release, 'toolchain-v2.0.0');
        selected = await archive(root, 'v1');
        assert.deepEqual(await updateManagedToolchain(ctx, 'latest', nativeTarget, { force: true }), next);
        assert.equal(downloads, 2);
        const pinned = await updateManagedToolchain(ctx, 'toolchain-v1.0.0', nativeTarget);
        assert.equal(pinned?.release, 'toolchain-v1.0.0');
        const before = metadata;
        await updateManagedToolchain(ctx, 'toolchain-v1.0.0', nativeTarget);
        assert.equal(metadata, before);
        const legacy = { directory: pinned!.directory, release: pinned!.release, target: pinned!.target };
        await writeFile(statePath(ctx), JSON.stringify(legacy));
        assert.equal(await loadManagedToolchain(ctx), legacy.directory);
        const migrated = await updateManagedToolchain(ctx, 'toolchain-v1.0.0', nativeTarget);
        assert.notEqual(migrated?.directory, legacy.directory);
        assert.equal(migrated?.repository, 'dev-chee/teal-vscode');
        const saved = await readFile(statePath(ctx), 'utf8');
        await assert.rejects(updateManagedToolchain(ctx, 'latest', nativeTarget, { force: true, canCommit: async () => false }), /cancelled/);
        assert.equal(await readFile(statePath(ctx), 'utf8'), saved);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('configuration changes during a real download cancel publication and preserve the old toolchain', async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-update-cancel-')));
    try {
        let selected = await archive(root, 'v1');
        let allowed = true, cancelDownload = false;
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
            assert.ok(options?.signal, 'metadata and downloads have cancellation and time limits');
            if (String(input).startsWith('https://api.github.com/')) return Response.json([selected.release]);
            if (cancelDownload) allowed = false;
            return new Response(selected.bytes);
        });
        const ctx = context(root);
        const first = await installManagedToolchain(ctx, 'latest', nativeTarget);
        const before = await readFile(statePath(ctx), 'utf8');
        selected = await archive(root, 'v2'); cancelDownload = true;
        await assert.rejects(installManagedToolchain(ctx, 'latest', nativeTarget, undefined, { canCommit: async () => allowed }), /cancelled/);
        assert.equal(await readFile(statePath(ctx), 'utf8'), before);
        assert.equal(await loadManagedToolchain(ctx), first.directory);
    } finally { await rm(root, { recursive: true, force: true }); }
});
