import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { Uri } from 'vscode';
import { executableName } from '../src/platform';
import { LanguageSessions } from '../src/languageSessions';

const uri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href }) as Uri;
let folder: Uri;
let cached: string | undefined;
let candidate: string;
const api = {
    Uri: { file: uri, joinPath: (base: Uri, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    workspace: {
        isTrusted: true,
        get workspaceFolders() { return [{ uri: folder, name: 'workspace', index: 0 }]; },
        get textDocuments() { return [{ uri: uri(path.join(folder.fsPath, 'main.tl')), languageId: 'teal', isClosed: false }]; },
        getWorkspaceFolder: () => ({ uri: folder, name: 'workspace', index: 0 }),
        getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'toolchain.path' ? ''
            : key === 'toolchain.release' ? 'latest' : key === 'toolchain.autoUpdate' ? false : fallback }),
    },
};
const loader = Module as unknown as { _load(request: string, parent: NodeModule | undefined, isMain?: boolean): unknown };
const original = loader._load;
loader._load = (request, parent, isMain) => {
    if (request === 'vscode') return api;
    if (request === './managedToolchain') return {
        currentManagedToolchainTarget: () => 'linux-x64',
        loadManagedToolchain: async (_storage: unknown, _release: string, excluded: readonly string[] = []) =>
            cached && !excluded.includes(cached) ? cached : undefined,
        updateManagedToolchain: async () => { cached = candidate; return { directory: candidate }; },
    };
    return original.call(Module, request, parent, isMain);
};
const environment = createRequire(__filename)('../src/environment') as typeof import('../src/environment');
const { WorkspaceToolchains } = createRequire(__filename)('../src/workspaceToolchains') as typeof import('../src/workspaceToolchains');
loader._load = original;

for (const restoreFails of [false, true]) {
    test(`an update from the bundled LSP restores the previous selection and can retry (restore failure: ${restoreFails})`, async () => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-bundled-recovery-')));
        const searchPath = process.env.PATH;
        cached = undefined;
        folder = uri(path.join(root, 'workspace'));
        candidate = path.join(root, 'managed');
        const bundled = path.join(root, 'bundled');
        const bundledExecutable = path.join(bundled, executableName('teal'));
        const candidateExecutable = path.join(candidate, executableName('teal'));
        const attempts: string[] = [];
        let active: string | undefined;
        let failCandidate = true;
        let failRestore = false;
        const sessions = new LanguageSessions({
            groups: () => [{ key: folder.toString(), root: folder.fsPath, documents: api.workspace.textDocuments.map(document => ({ uri: document.uri.toString(), path: document.uri.fsPath })) }],
            start: async () => {
                const executable = await environment.executable('teal', folder);
                attempts.push(executable);
                if (executable === candidateExecutable && failCandidate) throw new Error('new LSP failed');
                if (executable === bundledExecutable && failRestore) throw new Error('bundled LSP restore failed');
                active = executable;
                return { isRunning: () => active === executable, dispose: async () => { active = undefined; } };
            },
            report: () => {},
        });
        const manager = new WorkspaceToolchains({ globalStorageUri: uri(path.join(root, 'storage')) }, (force, keys) => sessions.refreshScopes(keys, force), () => {});
        try {
            for (const directory of [bundled, candidate]) {
                await mkdir(directory);
                const executable = path.join(directory, executableName('teal'));
                await writeFile(executable, 'fixture, never executed'); await chmod(executable, 0o755);
            }
            process.env.PATH = path.join(root, 'missing');
            environment.setManagedToolchainProvider(resource => manager.directory(resource));
            environment.setBundledToolchainProvider(async () => ({ directory: bundled, release: 'toolchain-v2.0.0' }));
            await manager.start();
            await sessions.refresh();
            assert.equal(active, bundledExecutable);
            failRestore = restoreFails;
            const messages = (error: unknown): string => error instanceof AggregateError
                ? `${error.message} ${error.errors.map(messages).join(' ')}` : String(error);
            await assert.rejects(manager.check(), error => {
                assert.match(messages(error), /new LSP failed/);
                if (restoreFails) assert.match(messages(error), /bundled LSP restore failed/);
                return true;
            });
            assert.deepEqual(attempts, [bundledExecutable, candidateExecutable, bundledExecutable]);
            assert.equal(active, restoreFails ? undefined : bundledExecutable);
            assert.equal(await manager.directory(folder), undefined, 'the failed managed generation remains blocked');
            failCandidate = false; failRestore = false;
            await manager.check();
            assert.equal(active, candidateExecutable);
        } finally {
            await manager.dispose();
            await sessions.dispose();
            environment.setManagedToolchainProvider(undefined);
            environment.setBundledToolchainProvider(undefined);
            process.env.PATH = searchPath;
            await rm(root, { recursive: true, force: true });
        }
    });
}
