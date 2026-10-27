import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { LanguagePaths } from '../src/languagePaths';

test('linked workspace paths round-trip open and unopened files without capturing neighboring roots', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-language-paths-')));
    try {
        const actual = path.join(directory, 'real');
        const alias = path.join(directory, 'alias');
        await mkdir(actual);
        await symlink(actual, alias, 'junction');
        const name = '中文 # [uri].tl';
        await writeFile(path.join(actual, name), '');
        const paths = await LanguagePaths.create(alias, [{ path: path.join(alias, name) }]);
        for (const file of [name, path.join('nested', 'not-open.tl')]) {
            assert.equal(paths.toCanonical(path.join(alias, file)), path.join(actual, file));
            assert.equal(paths.toEditor(path.join(actual, file)), path.join(alias, file));
        }
        assert.equal(paths.toCanonical(alias), actual);
        assert.equal(paths.toEditor(actual), alias);
        for (const outside of [path.join(directory, 'external', 'source.tl'), `${actual}-sibling/other.tl`, `${alias}-sibling/other.tl`]) {
            assert.equal(paths.toCanonical(outside), outside);
            assert.equal(paths.toEditor(outside), outside);
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('opened documents inside linked subdirectories retain their editor identity outside the canonical root', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-document-paths-')));
    try {
        const root = path.join(directory, 'project');
        const external = path.join(directory, 'external');
        await mkdir(root); await mkdir(external);
        await writeFile(path.join(external, 'lib.tl'), '');
        await symlink(external, path.join(root, 'linked'), 'junction');
        const opened = path.join(root, 'linked', 'lib.tl');
        const canonical = path.join(external, 'lib.tl');
        const paths = await LanguagePaths.create(root, [{ path: opened }]);
        assert.equal(paths.toCanonical(opened), canonical);
        assert.equal(paths.toEditor(canonical), opened);
        assert.equal(paths.toEditor(path.join(external, 'unopened.tl')), path.join(external, 'unopened.tl'));
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing workspace inputs fall back to their original paths', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'teal-missing-paths-'));
    try {
        const root = path.join(directory, 'absent');
        const file = path.join(root, 'new.tl');
        const paths = await LanguagePaths.create(root, [{ path: file }]);
        assert.equal(paths.toCanonical(file), file);
        assert.equal(paths.toEditor(file), file);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an opened nested workspace document overrides the parent alias root fallback', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-nested-paths-')));
    try {
        const actual = path.join(directory, 'real');
        const alias = path.join(directory, 'alias');
        const nested = path.join(actual, 'child');
        await mkdir(nested, { recursive: true });
        await symlink(actual, alias, 'junction');
        const inner = path.join(nested, 'inner.tl');
        await writeFile(inner, '');
        const paths = await LanguagePaths.create(alias, [{ path: inner }]);
        assert.equal(paths.toEditor(inner), inner, 'references must reuse the buffer opened through the child workspace');
        assert.equal(paths.toCanonical(inner), inner);
        assert.equal(paths.toEditor(path.join(actual, 'not-open.tl')), path.join(alias, 'not-open.tl'));
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('duplicate path snapshots preserve the first editor identity', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-duplicate-paths-')));
    try {
        const actual = path.join(directory, 'real');
        const alias = path.join(directory, 'alias');
        await mkdir(actual);
        await symlink(actual, alias, 'junction');
        const realFile = path.join(actual, 'main.tl');
        const aliasFile = path.join(alias, 'main.tl');
        await writeFile(realFile, '');
        const paths = await LanguagePaths.create(alias, [{ path: aliasFile }, { path: aliasFile }, { path: realFile }]);
        assert.equal(paths.toCanonical(aliasFile), realFile);
        assert.equal(paths.toEditor(realFile), aliasFile);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
