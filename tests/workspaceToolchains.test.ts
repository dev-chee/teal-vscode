import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { Uri } from 'vscode';
import type { WorkspaceToolchains as Manager } from '../src/workspaceToolchains';

const uri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).toString() }) as Uri;
const folders = [uri(path.join(tmpdir(), 'teal-workspace-a')), uri(path.join(tmpdir(), 'teal-workspace-b'))];
let configurations: Array<{ release: string; autoUpdate: boolean }>;
let cached: Map<string, string>;
let candidate: string;
let metadata: string[];
const api = {
    Uri: { file: uri, joinPath: (base: Uri, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    workspace: {
        isTrusted: true, workspaceFolders: folders.map((uri, index) => ({ uri, index, name: String(index) })), textDocuments: folders.map(folder => ({ uri: uri(path.join(folder.fsPath, 'main.tl')), languageId: 'teal', isClosed: false })),
        getWorkspaceFolder: (resource: Uri) => api.workspace.workspaceFolders.find(folder => resource.fsPath.startsWith(folder.uri.fsPath)),
        getConfiguration: (_section: string, resource?: Uri) => ({ get: (key: string, fallback: unknown) => {
            const config = configurations[resource?.fsPath === folders[1].fsPath ? 1 : 0];
            return key === 'toolchain.path' ? '' : key === 'toolchain.release' ? config.release
                : key === 'toolchain.autoUpdate' ? config.autoUpdate : fallback;
        } }),
    },
};
const loader = Module as unknown as { _load(request: string, parent: NodeModule | undefined, isMain?: boolean): unknown };
const original = loader._load;
loader._load = (request, parent, isMain) => {
    if (request === 'vscode') return api;
    if (request === './environment') return { isSupported: () => true };
    if (request === './toolchain') return { resolveToolchain: async () => undefined, isCompleteToolchain: () => false };
    if (request === './managedToolchain') return {
        currentManagedToolchainTarget: () => 'linux-x64',
        loadManagedToolchain: async (_storage: unknown, release = 'latest', excluded: readonly string[] = []) => {
            const directory = cached.get(release);
            return directory && !excluded.includes(directory) ? directory : release === 'latest' && excluded.length ? '/old' : undefined;
        },
        updateManagedToolchain: async (_storage: unknown, release: string) => {
            metadata.push(release);
            const directory = release === 'latest' ? candidate : cached.get(release);
            if (directory) cached.set(release, directory);
            return directory ? { directory } : undefined;
        },
    };
    return original.call(Module, request, parent, isMain);
};
const { WorkspaceToolchains } = createRequire(__filename)('../src/workspaceToolchains') as typeof import('../src/workspaceToolchains');
loader._load = original;

function fixture(refresh: (force: boolean, keys?: readonly string[]) => Promise<void>) {
    configurations = [{ release: 'latest', autoUpdate: false }, { release: 'toolchain-v2.0.0', autoUpdate: false }];
    cached = new Map([['latest', '/old'], ['toolchain-v2.0.0', '/pinned']]);
    candidate = '/new'; metadata = [];
    return new WorkspaceToolchains({ globalStorageUri: uri('/storage') }, refresh, () => {});
}

test('folder opt-out suppresses automatic checks while keeping each configured cache', async () => {
    const manager = fixture(async () => {});
    try {
        await manager.start();
        assert.equal(await manager.directory(folders[0]), '/old');
        assert.equal(await manager.directory(folders[1]), '/pinned');
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.deepEqual(metadata, []);
    } finally { await manager.dispose(); }
});

test('failed LSP activation restores the old directory and explicit checking can retry', async () => {
    let fail = true;
    const attempts: string[] = [];
    const manager: Manager = fixture(async () => {
        const directory = await manager.directory(folders[0]);
        attempts.push(directory!);
        if (directory === '/new' && fail) throw new Error('new LSP failed');
    });
    try {
        await manager.start();
        await assert.rejects(manager.check(), /new LSP failed/);
        assert.equal(await manager.directory(folders[0]), '/old');
        assert.equal(await manager.directory(folders[1]), '/pinned');
        fail = false;
        await manager.check();
        assert.equal(await manager.directory(folders[0]), '/new');
        assert.equal(attempts.filter(directory => directory === '/new').length, 2);
    } finally { await manager.dispose(); }
});

test('cached startup failures fall back offline before any network request', async () => {
    const manager: Manager = fixture(async () => {
        if (await manager.directory(folders[0]) === '/bad') throw new Error('cached LSP failed');
    });
    cached.set('latest', '/bad');
    try {
        await manager.start();
        assert.equal(await manager.directory(folders[0]), '/old');
        assert.deepEqual(metadata, []);
    } finally { await manager.dispose(); }
});

test('an update refreshes only roots selecting that release', async () => {
    const calls: Array<readonly string[] | undefined> = [];
    const manager = fixture(async (_force, keys) => { calls.push(keys); });
    try {
        await manager.start();
        await manager.directory(folders[0]); await manager.directory(folders[1]);
        calls.length = 0;
        await manager.check();
        assert.deepEqual(calls, [[folders[0].toString()]]);
    } finally { await manager.dispose(); }
});

test('activation and rollback errors are both retained and later retries remain possible', async () => {
    let fail = false;
    const manager: Manager = fixture(async () => {
        const directory = await manager.directory(folders[0]);
        if (fail) throw new Error(directory === '/new' ? 'new failed' : 'restore failed');
    });
    try {
        await manager.start();
        await manager.directory(folders[0]);
        fail = true;
        await assert.rejects(manager.check(), error => {
            assert.ok(error instanceof AggregateError);
            assert.match(String(error.errors[0]), /new failed/);
            assert.match(String(error.errors[1]), /restore failed/);
            return true;
        });
        fail = false;
        await manager.check();
        assert.equal(await manager.directory(folders[0]), '/new');
    } finally { await manager.dispose(); }
});


test('a window with a missing fixed cache discovers another window installation offline', async () => {
    const manager = fixture(async () => {});
    cached.delete('toolchain-v2.0.0');
    try {
        await manager.start();
        assert.equal(await manager.directory(folders[1]), undefined);
        cached.set('toolchain-v2.0.0', '/installed-by-another-window');
        assert.equal(await manager.directory(folders[1]), '/installed-by-another-window');
        assert.deepEqual(metadata, []);
    } finally { await manager.dispose(); }
});

test('a delayed document refresh cannot restore a stale directory after an update', async () => {
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let first = true;
    const manager: Manager = fixture(async () => {
        if (first) { first = false; entered(); await gate; }
    });
    try {
        const starting = manager.start();
        await started;
        const updating = manager.check();
        await new Promise(resolve => setImmediate(resolve));
        const documents = manager.documentsChanged();
        await new Promise(resolve => setImmediate(resolve));
        finish();
        await Promise.all([starting, updating, documents]);
        assert.equal(await manager.directory(folders[0]), '/new');
    } finally { finish(); await manager.dispose(); }
});
