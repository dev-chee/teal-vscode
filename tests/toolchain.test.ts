import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { resolveToolchain, toolNames } from '../src/toolchain';

async function fixture(name: string): Promise<string> {
    return mkdtemp(path.join(tmpdir(), `teal-vscode-${name}-`));
}

async function tools(directory: string, names: readonly string[]): Promise<void> {
    await mkdir(directory, { recursive: true });
    await Promise.all(names.map((name) => writeFile(path.join(directory, `${name}.exe`), 'fixture')));
}

test('an explicit absolute directory is canonical and may expose only one tool', async () => {
    const root = await fixture('configured');
    try {
        const directory = path.join(root, '工具链 with spaces');
        await tools(directory, ['teal-lsp']);
        const result = await resolveToolchain(directory);
        assert.equal(result.directory, await import('node:fs/promises').then(({ realpath }) => realpath(directory)));
        assert.deepEqual(result.tools, { 'teal-lsp': path.join(result.directory, 'teal-lsp.exe') });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a configured relative or unreadable path fails without PATH fallback', async () => {
    const root = await fixture('invalid-configured');
    try {
        const fallback = path.join(root, 'fallback');
        await tools(fallback, toolNames);
        await assert.rejects(resolveToolchain('relative-tools', fallback), /absolute directory/);
        await assert.rejects(resolveToolchain(path.join(root, 'missing'), fallback), /does not exist/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('PATH chooses the first complete directory even when an earlier directory is partial', async () => {
    const root = await fixture('complete');
    try {
        const partial = path.join(root, 'partial');
        const complete = path.join(root, 'complete');
        await tools(partial, ['teal']);
        await tools(complete, toolNames);
        const result = await resolveToolchain('', [partial, complete].join(path.delimiter));
        assert.equal(result.directory, await import('node:fs/promises').then(({ realpath }) => realpath(complete)));
        assert.deepEqual(Object.keys(result.tools).sort(), [...toolNames].sort());
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('PATH returns the first partial directory and never combines tools across directories', async () => {
    const root = await fixture('partial');
    try {
        const first = path.join(root, 'first');
        const second = path.join(root, 'second');
        await tools(first, ['teal']);
        await tools(second, ['teal-lsp', 'teal-dap']);
        const result = await resolveToolchain('', [first, second].join(path.delimiter));
        assert.equal(result.directory, await import('node:fs/promises').then(({ realpath }) => realpath(first)));
        assert.deepEqual(Object.keys(result.tools), ['teal']);
        assert.equal(result.tools['teal-lsp'], undefined);
        assert.equal(result.tools['teal-dap'], undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('PATH ignores empty and relative entries, supports a quoted absolute directory, and rejects no tools', async () => {
    const root = await fixture('path');
    try {
        const directory = path.join(root, 'quoted directory');
        await tools(directory, ['teal-dap']);
        const result = await resolveToolchain('', ['', 'relative', `"${directory}"`].join(path.delimiter));
        assert.equal(result.directory, await import('node:fs/promises').then(({ realpath }) => realpath(directory)));
        assert.deepEqual(Object.keys(result.tools), ['teal-dap']);
        await assert.rejects(resolveToolchain('', path.join(root, 'missing')), /No Teal toolchain found/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
