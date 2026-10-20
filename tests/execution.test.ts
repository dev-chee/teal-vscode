import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rename, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { saveProgram } from '../src/documents';
import { sameFilePath } from '../src/platform';
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

test('launch matches disk aliases and rejects aliases split by atomic saves', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-launch-identity-'));
    const program = path.join(root, 'main.tl');
    const alias = path.join(root, 'linked-main.tl');
    try {
        await writeFile(program, 'old');
        await link(program, alias);
        let saves = 0;
        const document = { uri: { scheme: 'file', fsPath: alias }, isDirty: true, isClosed: false,
            async save() { saves++; await writeFile(alias, 'new'); return true; } };
        assert.equal(await sameFilePath(program, alias), true);
        await saveProgram(program, [document]);
        assert.equal(saves, 1);
        assert.equal(await readFile(program, 'utf8'), 'new');
        // 编辑器原子保存会拆开硬链接；调试不能静默运行另一端的旧内容。
        document.save = async () => { const replacement = path.join(root, 'replacement'); await writeFile(replacement, 'changed'); await rename(replacement, alias); return true; };
        await assert.rejects(saveProgram(program, [document]), /no longer identifies/);
        assert.equal(await sameFilePath(program, alias), false);
        saves = 0;
        document.save = async () => { saves++; return true; };
        await saveProgram(program, [document]);
        assert.equal(saves, 0, 'distinct files on case-sensitive volumes must remain distinct');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('native case-insensitive volumes save alternate spelling of the launch path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-launch-case-'));
    const canonical = path.join(root, 'Main.tl');
    const alternate = path.join(root, 'main.tl');
    try {
        await writeFile(canonical, 'old');
        const aliasExists = await stat(alternate).then(() => true, () => false);
        if (!aliasExists) await writeFile(alternate, 'separate');
        let saves = 0;
        const document = { uri: { scheme: 'file', fsPath: canonical }, isDirty: true, isClosed: false,
            async save() { saves++; await writeFile(canonical, 'new'); return true; } };
        await saveProgram(alternate, [document]);
        assert.equal(saves, aliasExists ? 1 : 0);
        assert.equal(await readFile(alternate, 'utf8'), aliasExists ? 'new' : 'separate');
    } finally { await rm(root, { recursive: true, force: true }); }
});
