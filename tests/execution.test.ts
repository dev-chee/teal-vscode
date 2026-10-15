import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { prepareDebugConfiguration } from '../src/debugOptions';

test('launch saves the file document even when a Git revision with the same path comes first', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-launch-save-'));
    const program = path.join(root, 'main.tl');
    const oldSource = 'fn main() { print("old"); }\n';
    const newSource = 'fn main() { print("new"); }\n';
    try {
        await writeFile(program, oldSource);
        let saves = 0;
        let canSave = true;
        const file = {
            uri: { scheme: 'file', fsPath: program }, isDirty: true, isClosed: false,
            async save() { saves++; if (!canSave) return false; await writeFile(program, newSource); return true; },
        };
        const revision = {
            uri: { scheme: 'git', fsPath: program }, isDirty: false, isClosed: false,
            async save() { throw new Error('A revision must never be saved'); },
        };
        const closed = { ...file, isClosed: true, async save() { throw new Error('A closed document must never be saved'); } };
        const documents = [revision, closed, file];
        const context = { baseDirectory: root, documents };
        const config = { type: 'teal', request: 'launch', name: 'test', program, cwd: root, console: 'integratedTerminal' };
        await assert.rejects(prepareDebugConfiguration({ ...config, cwd: path.join(root, 'missing') }, context));
        await assert.rejects(prepareDebugConfiguration({ ...config, permissionFile: 'missing.toml' }, context), /existing local file/);
        assert.equal(saves, 0, 'invalid configuration must not save the dirty source');
        assert.equal(await readFile(program, 'utf8'), oldSource);
        await prepareDebugConfiguration({ ...config }, context);
        assert.equal(saves, 1);
        assert.equal(await readFile(program, 'utf8'), newSource);

        canSave = false;
        await assert.rejects(prepareDebugConfiguration({ ...config }, context), /could not be saved/);
        assert.equal(saves, 2, 'save failure must abort launch');

        documents.splice(1);
        await prepareDebugConfiguration({ ...config }, context);
        assert.equal(saves, 2, 'a closed program may run from disk without saving the revision document');
    } finally { await rm(root, { recursive: true, force: true }); }
});
