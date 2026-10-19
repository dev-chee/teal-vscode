import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { disposeLanguageServerExecutables, languageServerEnvironment, releaseLanguageServerExecutable, stageLanguageServerExecutable } from '../src/languageServerExecutable';

test('Windows stages the language server outside the source directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-lsp-test-'));
    try {
        const source = path.join(root, 'target', 'release', 'teal-lsp.exe');
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
        const source = path.join(root, 'teal-lsp.exe');
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
    const source = path.join(tmpdir(), 'teal-lsp');
    assert.equal(await stageLanguageServerExecutable(source, 'linux'), source);
});
