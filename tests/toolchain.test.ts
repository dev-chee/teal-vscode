import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { resolveToolchain, toolNames } from '../src/toolchain';
import { executableName } from '../src/platform';

async function fixture(name: string): Promise<string> {
    return mkdtemp(path.join(tmpdir(), `teal-vscode-${name}-`));
}

async function tools(directory: string, names: readonly string[]): Promise<void> {
    await mkdir(directory, { recursive: true });
    await Promise.all(names.map((name) => writeFile(path.join(directory, executableName(name)), 'fixture', { mode: 0o755 })));
}

test('an explicit absolute directory is canonical when it exposes teal', async () => {
    const root = await fixture('configured');
    try {
        const directory = path.join(root, '工具链 with spaces');
        await tools(directory, ['teal']);
        const result = await resolveToolchain(directory);
        assert.equal(result.directory, await import('node:fs/promises').then(({ realpath }) => realpath(directory)));
        assert.deepEqual(result.tools, { teal: path.join(result.directory, executableName('teal')) });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a configured relative or unreadable path fails without PATH fallback', async () => {
    const root = await fixture('invalid-configured');
    try {
        const fallback = path.join(root, 'fallback');
        const legacy = path.join(root, 'legacy');
        await tools(fallback, toolNames);
        await tools(legacy, ['teal-lsp']);
        await assert.rejects(resolveToolchain('relative-tools', fallback), /absolute directory/);
        await assert.rejects(resolveToolchain(path.join(root, 'missing'), fallback), /does not exist/);
        await assert.rejects(resolveToolchain(legacy, fallback), /does not contain the teal executable/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('PATH skips legacy multi-binary directories and selects the first single-binary toolchain', async () => {
    const root = await fixture('complete');
    try {
        const legacy = path.join(root, 'legacy');
        const current = path.join(root, 'current');
        await tools(legacy, ['teal-lsp', 'teal-dap']);
        await tools(current, toolNames);
        const result = await resolveToolchain('', [legacy, current].join(path.delimiter));
        assert.equal(result.directory, await import('node:fs/promises').then(({ realpath }) => realpath(current)));
        assert.deepEqual(Object.keys(result.tools).sort(), [...toolNames].sort());
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('PATH keeps the first single-binary toolchain and never combines directories', async () => {
    const root = await fixture('partial');
    try {
        const first = path.join(root, 'first');
        const second = path.join(root, 'second');
        await tools(first, ['teal']);
        await tools(second, ['teal']);
        const result = await resolveToolchain('', [first, second].join(path.delimiter));
        assert.equal(result.directory, await import('node:fs/promises').then(({ realpath }) => realpath(first)));
        assert.deepEqual(Object.keys(result.tools), ['teal']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('PATH ignores empty and relative entries, supports a quoted absolute directory, and rejects no tools', async () => {
    const root = await fixture('path');
    try {
        const directory = path.join(root, 'quoted directory');
        await tools(directory, ['teal']);
        const result = await resolveToolchain('', ['', 'relative', `"${directory}"`].join(path.delimiter));
        assert.equal(result.directory, await import('node:fs/promises').then(({ realpath }) => realpath(directory)));
        assert.deepEqual(Object.keys(result.tools), ['teal']);
        await assert.rejects(resolveToolchain('', path.join(root, 'missing')), /No Teal toolchain found/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});


test('Linux ignores Windows executables and files without execute permission', { skip: process.platform !== 'linux' }, async () => {
    const root = await fixture('linux-executable');
    try {
        await writeFile(path.join(root, 'teal.exe'), 'Windows fixture', { mode: 0o755 });
        await writeFile(path.join(root, 'teal'), 'Linux fixture', { mode: 0o644 });
        await assert.rejects(resolveToolchain(root), /does not contain the teal executable/);
        await chmod(path.join(root, 'teal'), 0o755);
        assert.deepEqual((await resolveToolchain(root)).tools, { teal: path.join(root, 'teal') });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
