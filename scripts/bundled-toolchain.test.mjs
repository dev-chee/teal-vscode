import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { bundledToolchainPath, stageBundledToolchain } from './bundled-toolchain.mjs';
import { writeRuntimeFixture } from '../tests/helpers/toolchainFixture.cjs';

async function distribution(root, target = 'linux-x64') {
    const directory = path.join(root, 'source');
    await mkdir(directory, { recursive: true });
    const executable = path.join(directory, target.startsWith('win32-') ? 'teal.exe' : 'teal');
    await writeFile(executable, 'fixture executable', { mode: 0o755 });
    await chmod(executable, 0o755);
    const toolchain = path.join(directory, 'toolchain.json');
    await writeFile(toolchain, 'fixture formats');
    const files = await Promise.all([executable, toolchain].map(async file => {
        const content = await readFile(file);
        return { path: path.basename(file), size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
    }));
    await writeRuntimeFixture(directory, files);
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ formatVersion: 1, files,
        identity: { repository: 'dev-chee/teal-vscode', release: 'toolchain-v2.0.0', target },
    }));
    return directory;
}

test('a verified target distribution is staged into the VSIX-visible directory and then removed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-bundled-toolchain-'));
    try {
        const source = await distribution(root);
        const destination = path.join(root, 'dist', 'toolchain');
        const cleanup = await stageBundledToolchain(source, 'linux-x64', destination);
        assert.equal(await readFile(path.join(destination, 'teal'), 'utf8'), 'fixture executable');
        assert.equal(await readFile(path.join(source, 'toolchain.json'), 'utf8'), 'fixture formats');
        const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
        assert.deepEqual(manifest.identity, { repository: 'dev-chee/teal-vscode', release: 'toolchain-v2.0.0', target: 'linux-x64' });
        await cleanup();
        await assert.rejects(lstat(destination), /ENOENT/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('staging rejects unidentified releases and mismatched Unix targets before creating output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-bundled-toolchain-identity-'));
    try {
        const source = await distribution(root);
        const destination = path.join(root, 'dist', 'toolchain');
        await assert.rejects(stageBundledToolchain(source, 'darwin-arm64', destination), /release identity/);
        const file = path.join(source, 'manifest.json');
        const manifest = JSON.parse(await readFile(file, 'utf8'));
        delete manifest.identity;
        await writeFile(file, JSON.stringify(manifest));
        await assert.rejects(stageBundledToolchain(source, 'linux-x64', destination), /release identity/);
        await assert.rejects(lstat(destination), /ENOENT/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('staging never replaces an existing directory and requires a nonempty path file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-bundled-toolchain-existing-'));
    try {
        const source = await distribution(root);
        const destination = path.join(root, 'dist', 'toolchain');
        await mkdir(destination, { recursive: true });
        const marker = path.join(destination, 'keep.txt');
        await writeFile(marker, 'keep');
        await assert.rejects(stageBundledToolchain(source, 'linux-x64', destination), /Refusing to replace/);
        assert.equal(await readFile(marker, 'utf8'), 'keep');
        const empty = path.join(root, 'empty.txt');
        await writeFile(empty, ' \n');
        await assert.rejects(bundledToolchainPath(empty), /path file is empty/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('cleanup cannot remove a staging directory replaced by another task', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-bundled-toolchain-replaced-'));
    try {
        const source = await distribution(root);
        const destination = path.join(root, 'dist', 'toolchain');
        const cleanup = await stageBundledToolchain(source, 'linux-x64', destination);
        await rename(destination, path.join(root, 'previous-toolchain'));
        await mkdir(destination);
        const marker = path.join(destination, 'replacement.txt');
        await writeFile(marker, 'replacement');
        await cleanup();
        assert.equal(await readFile(marker, 'utf8'), 'replacement');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
