import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { disposeLanguageServerExecutables, languageServerEnvironment, releaseLanguageServerExecutable, stageLanguageServerExecutable } from '../src/languageServerExecutable';

test('Windows stages the language server outside the source directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-lsp-test-'));
    try {
        const source = path.join(root, 'target', 'release', 'teal.exe');
        await mkdir(path.dirname(source), { recursive: true });
        await writeFile(source, 'original');
        const staged = await stageLanguageServerExecutable(source, 'win32');

        assert.notEqual(staged, source);
        assert.notEqual(path.dirname(staged), path.dirname(source));
        assert.equal(await readFile(staged, 'utf8'), 'original');
        await writeFile(source, 'rebuilt');
        assert.equal(await readFile(staged, 'utf8'), 'original');

        await releaseLanguageServerExecutable(staged);
        await assert.rejects(readFile(staged), /ENOENT/);
    } finally {
        await disposeLanguageServerExecutables();
        await rm(root, { recursive: true, force: true });
    }
});

test('Windows preserves a packaged runtime directory for the staged server', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-lsp-runtime-test-'));
    try {
        const source = path.join(root, 'teal.exe');
        await writeFile(source, 'fixture');
        await mkdir(path.join(root, 'runtime'));
        assert.deepEqual(await languageServerEnvironment(source, 'win32', {}), {
            TEAL_RUNTIME_DIR: path.join(root, 'runtime'),
        });
        assert.equal(await languageServerEnvironment(source, 'win32', { TEAL_RUNTIME_DIR: 'custom' }), undefined);
    } finally {
        await disposeLanguageServerExecutables();
        await rm(root, { recursive: true, force: true });
    }
});

test('non-Windows hosts use the configured language server directly', async () => {
    const source = path.join(tmpdir(), 'teal');
    assert.equal(await stageLanguageServerExecutable(source, 'linux'), source);
});

test('Windows retries staging after a shared temporary directory creation failure', async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-lsp-retry-'));
    const source = path.join(root, 'teal.exe');
    await writeFile(source, 'retry fixture');
    const failure = Object.assign(new Error('temporary directory creation failed'), { code: 'EACCES' });
    const create = t.mock.method(fs, 'mkdtemp', async () => { throw failure; });
    try {
        const attempts = await Promise.allSettled([
            stageLanguageServerExecutable(source, 'win32'),
            stageLanguageServerExecutable(source, 'win32'),
        ]);
        assert.ok(attempts.every(result => result.status === 'rejected' && result.reason === failure));
        assert.equal(create.mock.callCount(), 1, 'concurrent starts share directory creation');
        create.mock.restore();

        const copies = await Promise.all([
            stageLanguageServerExecutable(source, 'win32'),
            stageLanguageServerExecutable(source, 'win32'),
        ]);
        assert.notEqual(copies[0], copies[1]);
        for (const copy of copies) assert.equal(await readFile(copy, 'utf8'), 'retry fixture');
    } finally {
        create.mock.restore();
        await disposeLanguageServerExecutables().finally(() => rm(root, { recursive: true, force: true }));
    }
});

test('Windows recreates an idle staging directory removed by temporary file cleanup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-lsp-removed-'));
    const source = path.join(root, 'teal.exe');
    await writeFile(source, 'cleanup fixture');
    try {
        const first = await stageLanguageServerExecutable(source, 'win32');
        await releaseLanguageServerExecutable(first);
        await rm(path.dirname(first), { recursive: true });
        const copies = await Promise.all([
            stageLanguageServerExecutable(source, 'win32'),
            stageLanguageServerExecutable(source, 'win32'),
        ]);
        assert.notEqual(copies[0], copies[1]);
        for (const copy of copies) assert.equal(await readFile(copy, 'utf8'), 'cleanup fixture');
        await assert.rejects(stageLanguageServerExecutable(path.join(root, 'missing.exe'), 'win32'), { code: 'ENOENT' });
        for (const copy of copies) {
            await releaseLanguageServerExecutable(copy);
            await assert.rejects(readFile(copy), { code: 'ENOENT' });
        }
        const retry = await stageLanguageServerExecutable(source, 'win32');
        assert.equal(await readFile(retry, 'utf8'), 'cleanup fixture');
    } finally {
        await disposeLanguageServerExecutables().finally(() => rm(root, { recursive: true, force: true }));
    }
});

test('Windows disposal tolerates an in-flight temporary directory creation failure', async (t) => {
    const failure = new Error('temporary directory creation failed');
    t.mock.method(fs, 'mkdtemp', async () => { throw failure; });
    const attempt = stageLanguageServerExecutable('unused.exe', 'win32');
    const cleanup = disposeLanguageServerExecutables();
    await Promise.all([
        assert.rejects(attempt, error => error === failure),
        assert.doesNotReject(cleanup),
    ]);
});
