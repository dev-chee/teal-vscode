import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { executableName } from '../src/platform';

const workspace = {
    isTrusted: true,
    getConfiguration: () => ({ get: () => configured }),
};
let configured = '';
const loader = Module as unknown as { _load(request: string, parent: NodeModule | undefined, isMain?: boolean): unknown };
const originalLoad = loader._load;
loader._load = (request, parent, isMain) => request === 'vscode' ? { workspace } : originalLoad.call(Module, request, parent, isMain);
const environment = createRequire(__filename)('../src/environment') as typeof import('../src/environment');
loader._load = originalLoad;

test('local toolchains and explicit errors do not wait for managed downloads', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-environment-local-')));
    const searchPath = process.env.PATH;
    let preparations = 0;
    try {
        process.env.PATH = root;
        environment.setManagedToolchainProvider(async () => { preparations++; throw new Error('unrelated managed download'); });
        configured = root;
        const cli = path.join(root, executableName('teal'));
        await writeFile(cli, 'fixture executable, never executed'); await chmod(cli, 0o755);
        assert.equal(await environment.executable('teal'), cli, 'an explicit single-binary toolchain remains usable');
        configured = path.join(root, 'absent');
        await assert.rejects(environment.executable('teal'), /does not exist/);
        configured = '';
        assert.equal(await environment.executable('teal'), cli, 'PATH toolchains retain priority');
        assert.equal(preparations, 0);
    } finally {
        configured = ''; environment.setManagedToolchainProvider(undefined);
        process.env.PATH = searchPath;
        await rm(root, { recursive: true, force: true });
    }
});

test('legacy PATH entries wait for the managed single-binary toolchain and recheck trust after preparation', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-environment-managed-')));
    const searchPath = process.env.PATH;
    try {
        const partial = path.join(root, 'partial'), managed = path.join(root, 'managed');
        await mkdir(partial); await mkdir(managed);
        const legacy = path.join(partial, executableName('teal-lsp'));
        await writeFile(legacy, 'legacy fixture'); await chmod(legacy, 0o755);
        const cli = path.join(managed, executableName('teal'));
        await writeFile(cli, 'managed fixture'); await chmod(cli, 0o755);
        process.env.PATH = partial;
        const resource = { fsPath: path.join(root, 'project/main.tl') } as import('vscode').Uri;
        environment.setManagedToolchainProvider(async uri => { assert.equal(uri, resource); return managed; });
        assert.equal(await environment.executable('teal', resource), cli);
        environment.setManagedToolchainProvider(async () => { workspace.isTrusted = false; return managed; });
        await assert.rejects(environment.executable('teal', resource), /Trust this workspace/);
    } finally {
        workspace.isTrusted = true; environment.setManagedToolchainProvider(undefined);
        process.env.PATH = searchPath;
        await rm(root, { recursive: true, force: true });
    }
});
