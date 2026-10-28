import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { Disposable } from 'vscode';
import { executableName } from '../src/platform';

const noop = () => ({ dispose() {} });
let directory: string;
const workspace = {
    isTrusted: true,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    onDidOpenTextDocument: noop, onDidGrantWorkspaceTrust: noop,
    onDidChangeWorkspaceFolders: noop, onDidChangeConfiguration: noop,
};
const api = {
    workspace,
    Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
    commands: { executeCommand: async () => {}, registerCommand: noop },
    debug: { registerDebugConfigurationProvider: noop, registerDebugAdapterDescriptorFactory: noop },
};
const loader = Module as unknown as { _load(request: string, parent: NodeModule | undefined, isMain?: boolean): unknown };
const original = loader._load;
loader._load = (request, parent, isMain) => {
    if (request === 'vscode') return api;
    if (request === './languageClient') return { LanguageClients: class { async refresh() {} async dispose() {} } };
    if (request === './workspaceToolchains') return { WorkspaceToolchains: class {
        async start() {} async directory() { return directory; } async dispose() {}
    } };
    return original.call(Module, request, parent, isMain);
};
const load = createRequire(__filename);
const extension = load('../src/extension') as typeof import('../src/extension');
const environment = load('../src/environment') as typeof import('../src/environment');
const { toolchainTestContext } = load('./helpers/extensionContext') as typeof import('./helpers/extensionContext');
loader._load = original;

test('host fixture contexts can activate and resolve a managed toolchain without a bundled directory', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-extension-context-')));
    const searchPath = process.env.PATH;
    const subscriptions: Disposable[] = [];
    try {
        directory = path.join(root, 'managed');
        await mkdir(directory);
        const cli = path.join(directory, executableName('teal'));
        await writeFile(cli, 'fixture, never executed'); await chmod(cli, 0o755);
        process.env.PATH = path.join(root, 'missing');
        await extension.activate(toolchainTestContext(root, subscriptions));
        assert.equal(await environment.executable('teal'), cli);
    } finally {
        await extension.deactivate();
        for (const subscription of subscriptions) subscription.dispose();
        process.env.PATH = searchPath;
        await rm(root, { recursive: true, force: true });
    }
});
