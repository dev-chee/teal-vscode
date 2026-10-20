import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { archiveName, targets } from './toolchain-release.mjs';

// POSIX 夹具保留真实 tar 权限位；Windows 对应安装路径由原生 CI 验证。
test('installer gate verifies archive digest, executable tools and every runtime resource', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-release-verification-'));
    try {
        const bundle = path.join(root, 'bundle');
        await mkdir(path.join(bundle, 'runtime'), { recursive: true });
        for (const tool of ['teal', 'teal-lsp', 'teal-dap', 'teal-fmt']) {
            const file = path.join(bundle, tool);
            await writeFile(file, '#!/bin/sh\nexit 0\n');
            await chmod(file, 0o755);
        }
        const content = Buffer.from('fixture runtime');
        await writeFile(path.join(bundle, 'runtime/resource.txt'), content);
        const runtimeManifest = { formatVersion: 1, files: [{ path: 'resource.txt', size: content.length, sha256: createHash('sha256').update(content).digest('hex') }] };
        const archive = path.join(root, 'fixture.tar.gz');
        const preload = path.join(root, 'mock-fetch.mjs');
        await writeFile(preload, `
            import { readFileSync } from 'node:fs';
            const release = JSON.parse(readFileSync(process.env.FIXTURE_RELEASE, 'utf8'));
            globalThis.fetch = async (url) => String(url).includes('/releases/tags/')
                ? Response.json(release) : new Response(readFileSync(process.env.FIXTURE_ARCHIVE));
        `);
        const invoke = async (corruptArchive, corruptRuntime) => {
            const manifest = structuredClone(runtimeManifest);
            if (corruptRuntime) manifest.files[0].sha256 = '0'.repeat(64);
            await writeFile(path.join(bundle, 'runtime/manifest.json'), JSON.stringify(manifest));
            const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'bundle'], { encoding: 'utf8' });
            assert.equal(packed.status, 0, packed.stderr);
            const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
            const release = { tag_name: 'toolchain-fixture', assets: targets.map((target) => ({ name: archiveName(target), digest: `sha256:${corruptArchive ? '0'.repeat(64) : digest}`, browser_download_url: 'https://example.invalid/fixture' })) };
            const metadata = path.join(root, 'release.json');
            await writeFile(metadata, JSON.stringify(release));
            await rm(path.join(root, 'target'), { recursive: true, force: true });
            return spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('./verify-toolchain.mjs', import.meta.url)), '--target', 'linux-x64', '--release', 'toolchain-fixture'], {
                cwd: root, encoding: 'utf8', timeout: 30_000,
                env: { ...process.env, FIXTURE_RELEASE: metadata, FIXTURE_ARCHIVE: archive, GITHUB_ENV: path.join(root, 'github-env'), GITHUB_TOKEN: '' },
            });
        };
        const success = await invoke(false, false);
        assert.equal(success.status, 0, success.stderr);
        const installed = await readFile(path.join(root, 'target/toolchain-path.txt'), 'utf8');
        assert.equal(await readFile(path.join(installed, 'runtime/resource.txt'), 'utf8'), content.toString());
        assert.match(await readFile(path.join(root, 'github-env'), 'utf8'), /TEAL_TOOLCHAIN_PATH=/);
        const badArchive = await invoke(true, false);
        assert.notEqual(badArchive.status, 0);
        assert.match(badArchive.stderr, /SHA-256 verification failed/);
        const badRuntime = await invoke(false, true);
        assert.notEqual(badRuntime.status, 0);
        assert.match(badRuntime.stderr, /Runtime digest mismatch/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
