import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { executableName } from '../src/platform';

const workspace = {
    isTrusted: true,
    getConfiguration: (_section: string, resource?: import('vscode').Uri) => ({ get: (key: string, fallback: unknown) => key === 'toolchain.path'
        ? configured : key === 'toolchain.release' ? (releases.get(resource?.fsPath ?? '') ?? release) : fallback }),
};
let configured = '';
let release = 'latest';
const releases = new Map<string, string>();
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

test('a valid bundled toolchain remains available when the managed update cannot be prepared', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-environment-bundled-')));
    const searchPath = process.env.PATH;
    try {
        const bundled = path.join(root, 'bundled');
        await mkdir(bundled);
        const cli = path.join(bundled, executableName('teal'));
        await writeFile(cli, 'bundled fixture'); await chmod(cli, 0o755);
        process.env.PATH = path.join(root, 'missing');
        configured = '';
        environment.setManagedToolchainProvider(async () => { throw new Error('offline'); });
        environment.setBundledToolchainProvider(async () => ({ directory: bundled, release: 'toolchain-v2.0.0' }));
        assert.equal(await environment.executable('teal'), cli);
    } finally {
        configured = '';
        environment.setManagedToolchainProvider(undefined);
        environment.setBundledToolchainProvider(undefined);
        process.env.PATH = searchPath;
        await rm(root, { recursive: true, force: true });
    }
});

test('bundled fallback honors each workspace pin and rechecks changes during preparation', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-environment-pin-')));
    const searchPath = process.env.PATH;
    try {
        const cli = path.join(root, executableName('teal'));
        await writeFile(cli, 'bundled fixture'); await chmod(cli, 0o755);
        process.env.PATH = path.join(root, 'missing');
        const first = { fsPath: path.join(root, 'first') } as import('vscode').Uri;
        const second = { fsPath: path.join(root, 'second') } as import('vscode').Uri;
        releases.set(first.fsPath, 'toolchain-v1.0.0');
        releases.set(second.fsPath, 'toolchain-v2.0.0');
        environment.setManagedToolchainProvider(async () => undefined);
        environment.setBundledToolchainProvider(async () => ({ directory: root, release: 'toolchain-v2.0.0' }));
        await assert.rejects(environment.executable('teal', first), /No Teal toolchain/);
        assert.equal(await environment.executable('teal', second), cli);
        for (release of ['latest', ' LATEST ', '']) assert.equal(await environment.executable('teal'), cli);
        release = 'toolchain-v2.0.0';
        environment.setManagedToolchainProvider(async () => { release = 'toolchain-v1.0.0'; return undefined; });
        await assert.rejects(environment.executable('teal'), /No Teal toolchain/);
    } finally {
        release = 'latest'; releases.clear();
        environment.setManagedToolchainProvider(undefined);
        environment.setBundledToolchainProvider(undefined);
        process.env.PATH = searchPath;
        await rm(root, { recursive: true, force: true });
    }
});

for (const change of ['release', 'path', 'missing release'] as const) {
    test(`toolchain selection retries when ${change} changes during bundled verification`, async () => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-environment-change-')));
        const searchPath = process.env.PATH;
        const originalRelease = 'toolchain-v1.0.0', nextRelease = 'toolchain-v2.0.0';
        try {
            const oldDirectory = path.join(root, 'old'), newDirectory = path.join(root, 'new');
            for (const directory of [oldDirectory, newDirectory]) {
                await mkdir(directory);
                const cli = path.join(directory, executableName('teal'));
                await writeFile(cli, 'fixture executable'); await chmod(cli, 0o755);
            }
            process.env.PATH = path.join(root, 'missing');
            release = originalRelease;
            const requested: string[] = [];
            environment.setManagedToolchainProvider(async () => {
                requested.push(release);
                return release === originalRelease ? oldDirectory : change === 'missing release' ? undefined : newDirectory;
            });
            let entered!: () => void, finish!: () => void;
            const waiting = new Promise<void>(resolve => { finish = resolve; });
            const verifying = new Promise<void>(resolve => { entered = resolve; });
            environment.setBundledToolchainProvider(async () => { entered(); await waiting; return undefined; });
            const pending = environment.executable('teal');
            await verifying;
            if (change === 'path') configured = newDirectory;
            else release = nextRelease;
            finish();
            if (change === 'missing release') await assert.rejects(pending, /No Teal toolchain/);
            else assert.equal(await pending, path.join(newDirectory, executableName('teal')));
            assert.deepEqual(requested, change === 'path' ? [originalRelease] : [originalRelease, nextRelease]);
        } finally {
            configured = ''; release = 'latest';
            environment.setManagedToolchainProvider(undefined);
            environment.setBundledToolchainProvider(undefined);
            process.env.PATH = searchPath;
            await rm(root, { recursive: true, force: true });
        }
    });
}
