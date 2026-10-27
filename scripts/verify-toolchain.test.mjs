import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { archiveName, targets } from './toolchain-release.mjs';
import { validateToolchainArchiveListing, validateToolchainArchiveTypes } from '../src/toolchainDistributionCore.cjs';
import { writeRuntimeFixture } from '../tests/helpers/toolchainFixture.cjs';

test('archive listings allow runtime Teal sources and reject implementation files and links', () => {
    const valid = 'bundle/\nbundle/teal\nbundle/runtime/\nbundle/runtime/packages/\nbundle/runtime/packages/std/src/ui.tl\n';
    assert.doesNotThrow(() => validateToolchainArchiveListing(valid));
    for (const file of ['compiler.rs', 'runtime/compiler.rs', 'runtime/build.py', 'runtime/Cargo.toml',
        'runtime/.git/config.toml', 'runtime/../source.tl', 'runtime/target/source.tl']) {
        assert.throws(() => validateToolchainArchiveListing(`${valid}bundle/${file}\n`));
    }
    assert.doesNotThrow(() => validateToolchainArchiveTypes('drwxr-xr-x root\n-rw-r--r-- root/runtime/source.tl\n'));
    for (const type of ['l', 'h', 'b', 'c', 'p']) {
        assert.throws(() => validateToolchainArchiveTypes(`${type}rwxr-xr-x root/runtime/source.tl\n`), /link or special/);
    }
});

// POSIX 夹具保留真实 tar 权限位；Windows 对应安装路径由原生 CI 验证。
test('installer gate verifies archive digest, the teal executable and runtime sources', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-release-verification-'));
    try {
        const bundle = path.join(root, 'bundle');
        await mkdir(bundle, { recursive: true });
        for (const tool of ['teal']) {
            const file = path.join(bundle, tool);
            await writeFile(file, '#!/bin/sh\nexit 0\n');
            await chmod(file, 0o755);
        }
        const content = Buffer.from('fixture runtime');
        await writeFile(path.join(bundle, 'toolchain.json'), content);
        const runtimeManifest = { formatVersion: 1, files: [{ path: 'toolchain.json', size: content.length, sha256: createHash('sha256').update(content).digest('hex') }] };
        for (const tool of ['teal']) {
            const bytes = await readFile(path.join(bundle, tool));
            runtimeManifest.files.push({ path: tool, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
        await writeRuntimeFixture(bundle, runtimeManifest.files);
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
            if (corruptRuntime) manifest.files[corruptRuntime === 'source'
                ? manifest.files.findIndex(file => file.path === 'runtime/packages/std/src/ui.tl') : 0].sha256 = '0'.repeat(64);
            await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
            const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'bundle'], { encoding: 'utf8' });
            assert.equal(packed.status, 0, packed.stderr);
            const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
            const release = { tag_name: 'toolchain-fixture', assets: targets.map((target) => ({ name: archiveName(target), digest: `sha256:${corruptArchive ? '0'.repeat(64) : digest}`, browser_download_url: 'https://example.invalid/fixture' })) };
            const metadata = path.join(root, 'release.json');
            await writeFile(metadata, JSON.stringify(release));
            await rm(path.join(root, 'target'), { recursive: true, force: true });
            return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./verify-toolchain.mjs', import.meta.url)), '--target', 'linux-x64', '--release', 'toolchain-fixture'], {
                cwd: root, encoding: 'utf8', timeout: 30_000,
                env: { ...process.env, FIXTURE_RELEASE: metadata, FIXTURE_ARCHIVE: archive, GITHUB_ENV: path.join(root, 'github-env'), GITHUB_TOKEN: '' },
            });
        };
        const success = await invoke(false, false);
        assert.equal(success.status, 0, success.stderr);
        const installed = await readFile(path.join(root, 'target/toolchain-path.txt'), 'utf8');
        assert.equal(await readFile(path.join(installed, 'toolchain.json'), 'utf8'), content.toString());
        assert.match(await readFile(path.join(root, 'github-env'), 'utf8'), /TEAL_TOOLCHAIN_PATH=/);
        const badArchive = await invoke(true, false);
        assert.notEqual(badArchive.status, 0);
        assert.match(badArchive.stderr, /SHA-256 digest.*does not match/);
        const badRuntime = await invoke(false, true);
        assert.notEqual(badRuntime.status, 0);
        assert.match(badRuntime.stderr, /Distribution digest mismatch/);
        const badSource = await invoke(false, 'source');
        assert.notEqual(badSource.status, 0);
        assert.match(badSource.stderr, /Distribution digest mismatch: runtime\/packages\/std\/src\/ui.tl/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/** 通过真实脚本重复校验；只检查夹具文件，不执行其中的工具。 */
async function verifierFixture(t) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-verifier-rerun-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'work');
    await mkdir(cwd);
    // tar 按内容识别夹具格式；Windows 使用其原生的 .exe 入口布局。
    const target = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
    const targetRoot = path.join(cwd, 'target/toolchains', target);
    const selection = path.join(cwd, 'target/toolchain-path.txt');
    const exported = path.join(root, 'github-env');
    const preload = path.join(root, 'mock-fetch.mjs');
    await writeFile(preload, `
        import { readFileSync } from 'node:fs';
        globalThis.fetch = async url => String(url).startsWith('https://api.github.com/')
            ? Response.json(JSON.parse(readFileSync(process.env.FIXTURE_RELEASE, 'utf8')))
            : new Response(readFileSync(process.env.FIXTURE_ARCHIVE));
    `);
    let sequence = 0;
    async function invoke({ name = 'teal-0.1.0', content = 'original runtime', omit } = {}) {
        const payload = path.join(root, `payload-${sequence++}`);
        const bundle = path.join(payload, name);
        await mkdir(bundle, { recursive: true });
        for (const tool of ['teal']) {
            const file = path.join(bundle, tool + (target.startsWith('win32-') ? '.exe' : ''));
            await writeFile(file, 'fixture executable, never executed');
            await chmod(file, 0o755);
        }
        const resource = Buffer.from(content);
        await writeFile(path.join(bundle, 'toolchain.json'), resource);
        const files = [];
        for (const file of await readdir(bundle)) {
            const bytes = await readFile(path.join(bundle, file));
            files.push({ path: file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
        await writeRuntimeFixture(bundle, files);
        await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({ formatVersion: 1, files }));
        if (omit) await rm(path.join(bundle, omit === 'teal' && target.startsWith('win32-') ? 'teal.exe' : omit));
        const archive = path.join(payload, 'fixture.tar.gz');
        const packed = spawnSync('tar', ['-czf', archive, '-C', payload, name], { encoding: 'utf8' });
        assert.equal(packed.status, 0, packed.stderr);
        const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
        const metadata = path.join(payload, 'release.json');
        await writeFile(metadata, JSON.stringify({ tag_name: 'toolchain-fixture', assets: targets.map(platform => ({
            name: archiveName(platform), digest: `sha256:${digest}`, browser_download_url: 'https://example.invalid/fixture',
        })) }));
        return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./verify-toolchain.mjs', import.meta.url)), '--target', target, '--release', 'toolchain-fixture'], {
            cwd, encoding: 'utf8', timeout: 30_000,
            env: { ...process.env, FIXTURE_RELEASE: metadata, FIXTURE_ARCHIVE: archive, GITHUB_ENV: exported, GITHUB_TOKEN: '' },
        });
    }
    return { invoke, targetRoot, selection, exported };
}

for (const omit of ['teal', 'toolchain.json']) {
    test(`repeated verification rejects a missing ${omit} and preserves the previous selection`, async t => {
        const fixture = await verifierFixture(t);
        const first = await fixture.invoke();
        assert.equal(first.status, 0, first.stderr);
        const selected = await readFile(fixture.selection, 'utf8');
        const exported = await readFile(fixture.exported, 'utf8');
        const generations = await readdir(fixture.targetRoot);
        const broken = await fixture.invoke({ omit });
        assert.notEqual(broken.status, 0, 'old files must not fill holes in the new archive');
        assert.match(broken.stderr, /ENOENT/);
        assert.equal(await readFile(fixture.selection, 'utf8'), selected);
        assert.equal(await readFile(fixture.exported, 'utf8'), exported);
        assert.equal(await readFile(path.join(selected, 'toolchain.json'), 'utf8'), 'original runtime');
        assert.deepEqual(await readdir(fixture.targetRoot), generations, 'failed candidates must be removed without deleting the old installation');
    });
}

for (const name of ['teal-0.1.0', 'teal-0.2.0']) {
    test(`repeated verification accepts ${name} without changing a previously selected directory`, async t => {
        const fixture = await verifierFixture(t);
        const first = await fixture.invoke();
        assert.equal(first.status, 0, first.stderr);
        const previous = await readFile(fixture.selection, 'utf8');
        const next = await fixture.invoke({ name, content: 'updated runtime' });
        assert.equal(next.status, 0, next.stderr);
        const selected = await readFile(fixture.selection, 'utf8');
        assert.notEqual(selected, previous, 'each verified archive must retain its own directory');
        assert.equal(await readFile(path.join(selected, 'toolchain.json'), 'utf8'), 'updated runtime');
        assert.equal(await readFile(path.join(previous, 'toolchain.json'), 'utf8'), 'original runtime');
        assert.equal((await readFile(fixture.exported, 'utf8')).trim().split(/\r?\n/).at(-1), `TEAL_TOOLCHAIN_PATH=${selected}`);
    });
}
