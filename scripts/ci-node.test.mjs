import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function fixture(t, { os = 'Darwin', arch = 'x86_64', badDigest = false, existing = false } = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-ci-node-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = path.join(root, 'workspace with spaces');
    const tools = path.join(root, 'tools');
    const dist = `node-v22.23.4-${os === 'Darwin' ? 'darwin' : 'linux'}-${arch === 'x86_64' ? 'x64' : 'arm64'}`;
    const payload = path.join(root, 'payload');
    const bin = path.join(payload, dist, 'bin');
    await mkdir(bin, { recursive: true });
    await mkdir(project);
    await mkdir(tools);
    const node = '#!/bin/bash\nif [ "$1" = --version ]; then echo v22.23.4; fi\n';
    const npm = '#!/bin/bash\necho fixture-npm\n';
    await writeFile(path.join(bin, 'node'), node, { mode: 0o755 });
    await writeFile(path.join(bin, 'npm'), npm, { mode: 0o755 });
    // 隔离宿主的 Node/Homebrew；不可用的命令必须触发工作区安装。
    await writeFile(path.join(tools, 'node'), existing ? node : '#!/bin/bash\nexit 127\n', { mode: 0o755 });
    await writeFile(path.join(tools, 'npm'), npm, { mode: 0o755 });
    for (const command of ['mkdir', 'mktemp', 'rm', 'grep', 'tar', 'gzip', 'mv', os === 'Darwin' ? 'shasum' : 'sha256sum']) {
        const actual = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'fixture', command], { encoding: 'utf8' }).trim();
        await symlink(actual, path.join(tools, command));
    }
    await writeFile(path.join(tools, 'uname'), '#!/bin/bash\nif [ "$1" = -s ]; then echo "$FIXTURE_OS"; else echo "$FIXTURE_ARCH"; fi\n', { mode: 0o755 });
    const archive = path.join(root, 'node.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', payload, dist]);
    const digest = badDigest ? '0'.repeat(64) : createHash('sha256').update(await readFile(archive)).digest('hex');
    const checksums = path.join(root, 'SHASUMS256.txt');
    await writeFile(checksums, `${digest}  ${dist}.tar.gz\n`);
    const log = path.join(root, 'downloads');
    await writeFile(path.join(tools, 'curl'), `#!/bin/bash
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --output) output="$2"; shift 2 ;;
                https://*) url="$1"; shift ;;
                *) shift ;;
            esac
        done
        echo "$url" >> "$FIXTURE_LOG"
        case "$url" in
            "https://nodejs.org/dist/v22.23.4/$FIXTURE_DIST.tar.gz") /bin/cp "$FIXTURE_ARCHIVE" "$output" ;;
            https://nodejs.org/dist/v22.23.4/SHASUMS256.txt) /bin/cp "$FIXTURE_CHECKSUMS" "$output" ;;
            *) exit 42 ;;
        esac
    `, { mode: 0o755 });
    const invoke = () => spawnSync('/bin/bash', ['--noprofile', '--norc', '-ec',
        'source "$FIXTURE_BOOTSTRAP"; node --version; command -v node; command -v npm; echo "$PATH"'], {
        encoding: 'utf8', env: { ...process.env, PATH: tools, CI_PROJECT_DIR: project,
            FIXTURE_BOOTSTRAP: fileURLToPath(new URL('./ci-node.sh', import.meta.url)),
            FIXTURE_OS: os, FIXTURE_ARCH: arch, FIXTURE_DIST: dist, FIXTURE_ARCHIVE: archive,
            FIXTURE_CHECKSUMS: checksums, FIXTURE_LOG: log },
    });
    return { invoke, project, tools, dist, log };
}

for (const [os, arch] of [['Darwin', 'x86_64'], ['Darwin', 'arm64'], ['Linux', 'x86_64']]) {
    test(`Unix CI prepares Node and npm for ${os}/${arch} without a usable global Node`, { skip: process.platform === 'win32' }, async t => {
        const setup = await fixture(t, { os, arch });
        const result = setup.invoke();
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /v22\.23\.4/);
        assert.ok(result.stdout.includes(path.join(setup.project, 'target/ci/node', setup.dist, 'bin/node')));
        assert.ok(result.stdout.includes(path.join(setup.project, 'target/ci/npm/bin')));
        const downloads = await readFile(setup.log, 'utf8');
        assert.equal(downloads.trim().split('\n').length, 2);
        const repeated = setup.invoke();
        assert.equal(repeated.status, 0, repeated.stderr);
        assert.equal(await readFile(setup.log, 'utf8'), downloads, 'reuse the workspace installation');
        assert.deepEqual(await readdir(path.join(setup.project, 'target/ci/node')), [setup.dist]);
    });
}

test('Unix CI rejects a corrupt Node archive before installing it', { skip: process.platform === 'win32' }, async t => {
    const setup = await fixture(t, { badDigest: true });
    const result = setup.invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /FAILED|did NOT match/);
    assert.deepEqual(await readdir(path.join(setup.project, 'target/ci/node')), []);
});

test('Unix CI uses an available Node 22 and npm without downloading', { skip: process.platform === 'win32' }, async t => {
    const setup = await fixture(t, { existing: true });
    const result = setup.invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(path.join(setup.tools, 'node')));
    await assert.rejects(readFile(setup.log), /ENOENT/);
});
