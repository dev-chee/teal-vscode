import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { ExtensionContext } from 'vscode';
import { currentManagedToolchainTarget, installManagedToolchain, loadManagedToolchain } from '../src/managedToolchain';
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
    return { bytes, release: { tag_name: name, assets: toolchainTargets.map(platform => ({
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
                return Response.json([{ tag_name: 'partial-v2', assets: valid.release.assets.slice(0, 1) }, valid.release]);
            }
            downloads++;
            return new Response(valid.bytes);
        });
        const installed = await installManagedToolchain(ctx, 'latest', nativeTarget);
        assert.equal(installed.release, 'complete-v1');
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
            assert.deepEqual((await readdir(path.dirname(statePath(ctx)))).sort(), ['current.json', 'valid-v1']);
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
            assert.deepEqual(await installManagedToolchain(ctx, 'latest', nativeTarget), installed);
            assert.equal(await loadManagedToolchain(ctx), installed.directory);
        }
        assert.equal(downloads, 3);
    } finally { await rm(root, { recursive: true, force: true }); }
});
