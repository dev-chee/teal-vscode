import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import * as executables from '../src/languageServerExecutable';
import type { Reporter } from '../src/reporting';
import type { LanguageClientOptions } from 'vscode-languageclient/node';
import { isWithinRoot } from '../src/platform';

const loader = Module as unknown as { _load(request: string, parent: NodeModule | undefined, isMain?: boolean): unknown };
const originalLoad = loader._load;
const load = createRequire(__filename);
const noop = () => ({ dispose() {} });
let entries: unknown = [];
let fault: 'constructor' | 'watcher' | 'listener' | 'start' | undefined;
let executableFile = '';
let disposedClients = 0;
let disposedWatchers = 0;
const folder = { uri: { fsPath: tmpdir(), toString: () => pathToFileURL(tmpdir()).toString() }, name: 'fixture', index: 0 };
let folders: Array<typeof folder> = [];
const clientOptions: LanguageClientOptions[] = [];
const serverOptions: Array<{ command?: string; args?: string[] }> = [];
function fileUri(file: string) {
    const uri = { scheme: 'file', fsPath: file, query: '', fragment: '', toString: () => pathToFileURL(file).toString(), with: () => uri };
    return uri;
}
const vscode = {
    workspace: {
        isTrusted: true,
        textDocuments: [{ uri: { scheme: 'file', fsPath: path.join(tmpdir(), 'main.tl'), toString: () => pathToFileURL(path.join(tmpdir(), 'main.tl')).toString() }, languageId: 'teal', isClosed: false }],
        getWorkspaceFolder: (uri: { fsPath: string }) => folders.filter(item => isWithinRoot(item.uri.fsPath, uri.fsPath)).sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0] ?? folder,
        getConfiguration: () => ({ get: () => entries }),
        onDidOpenTextDocument: noop, onDidCloseTextDocument: noop,
        onDidChangeWorkspaceFolders: noop, onDidGrantWorkspaceTrust: noop, onDidChangeConfiguration: noop,
        createFileSystemWatcher: () => {
            if (fault === 'watcher') throw new Error('watcher setup failed');
            return { dispose() { disposedWatchers++; }, onDidCreate: () => {
                if (fault === 'listener') throw new Error('watcher listener failed');
                return noop();
            }, onDidChange: noop, onDidDelete: noop };
        },
    },
    Uri: { file: fileUri, parse: (value: string) => fileUri(fileURLToPath(value)) },
    RelativePattern: class {},
    Disposable: { from: (...items: Array<{ dispose(): void }>) => ({ dispose() { items.forEach(item => item.dispose()); } }) },
};
class Client {
    state = 2;
    constructor(_id: string, _name: string, server: unknown, options: LanguageClientOptions) {
        if (fault === 'constructor') throw new Error('client construction failed');
        serverOptions.push(server as { command?: string; args?: string[] });
        clientOptions.push(options);
    }
    onDidChangeState = noop;
    async start() { if (fault === 'start') throw new Error('client startup failed'); }
    async dispose() { disposedClients++; }
}

loader._load = (request, parent, isMain) => {
    if (request === 'vscode') return vscode;
    if (request === 'vscode-languageclient/node') return { LanguageClient: Client, State: { Running: 2 }, CloseAction: {}, ErrorAction: {} };
    if (request === './environment' && parent?.filename.endsWith('languageClient.js')) return { isSupported: () => true, executable: async () => executableFile };
    return originalLoad.call(Module, request, parent, isMain);
};
const { LanguageClients } = load('../src/languageClient') as typeof import('../src/languageClient');
loader._load = originalLoad;

for (const failure of ['configuration', 'constructor', 'watcher', 'listener', 'start', 'none'] as const) {
    test(`language client releases staged executables after ${failure}`, async t => {
        const root = await mkdtemp(path.join(tmpdir(), 'teal-client-lifecycle-'));
        const source = path.join(root, 'teal.exe');
        executableFile = source;
        await writeFile(source, 'fixture executable, never executed');
        entries = failure === 'configuration' ? [123] : [];
        fault = failure === 'configuration' || failure === 'none' ? undefined : failure;
        disposedClients = disposedWatchers = 0;
        serverOptions.length = 0;
        const errors: string[] = [];
        const copies: string[] = [];
        const stage = executables.stageLanguageServerExecutable;
        t.mock.method(executables, 'stageLanguageServerExecutable', async (file: string) => {
            const copy = await stage(file, 'win32');
            copies.push(copy);
            return copy;
        });
        const reporter = { report(error: Error) { errors.push(error.message); }, output: { appendLine() {} } } as unknown as Reporter;
        const clients = new LanguageClients(reporter);
        try {
            await clients.refresh();
            if (failure === 'none') {
                assert.deepEqual(errors, []);
                assert.equal(await readFile(copies[0], 'utf8'), 'fixture executable, never executed');
                assert.deepEqual(serverOptions[0]?.args, ['lsp']);
                await clients.dispose();
                assert.equal(disposedClients, 1);
                assert.equal(disposedWatchers, 1);
            } else {
                assert.equal(errors.length, 1);
                assert.match(errors[0], failure === 'configuration' ? /entryFiles.*array of strings/ : /failed/);
                if (failure === 'configuration') assert.equal(copies.length, 0, 'validate before copying');
            }
            for (const file of copies) await assert.rejects(readFile(file), /ENOENT/);
        } finally {
            await clients.dispose();
            await executables.disposeLanguageServerExecutables();
            await rm(root, { recursive: true, force: true });
        }
    });
}

test('existing clients map cross-root results to a child buffer opened after parent startup', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-client-uri-')));
    const documents = [...vscode.workspace.textDocuments];
    const actual = path.join(directory, 'real');
    const alias = path.join(directory, 'alias');
    const nested = path.join(actual, 'child');
    const inner = path.join(nested, 'inner.tl');
    const main = path.join(alias, 'main.tl');
    await mkdir(nested, { recursive: true });
    await symlink(actual, alias, 'junction');
    await writeFile(path.join(actual, 'main.tl'), '');
    await writeFile(inner, '');
    executableFile = path.join(directory, 'teal.exe');
    await writeFile(executableFile, 'fixture executable, never executed');
    folders = [{ uri: fileUri(alias), name: 'parent', index: 0 }, { uri: fileUri(nested), name: 'child', index: 1 }];
    vscode.workspace.textDocuments.splice(0, documents.length, { uri: fileUri(main), languageId: 'teal', isClosed: false });
    clientOptions.length = 0;
    fault = undefined; entries = [];
    const errors: unknown[] = [];
    const clients = new LanguageClients({ report: (error: unknown) => { errors.push(error); }, output: { appendLine() {} } } as unknown as Reporter);
    try {
        await clients.refresh();
        const parent = clientOptions[0];
        assert.equal(parent.uriConverters?.protocol2Code(pathToFileURL(inner).toString()).fsPath, path.join(alias, 'child', 'inner.tl'));
        vscode.workspace.textDocuments.push({ uri: fileUri(inner), languageId: 'teal', isClosed: false });
        await clients.refresh();
        assert.equal(clientOptions.length, 2, 'the parent client must stay alive');
        assert.equal(parent.uriConverters?.protocol2Code(pathToFileURL(inner).toString()).fsPath, inner, 'the existing client must prefer the new child buffer');
        vscode.workspace.textDocuments.pop();
        await clients.refresh();
        assert.equal(parent.uriConverters?.protocol2Code(pathToFileURL(inner).toString()).fsPath, path.join(alias, 'child', 'inner.tl'), 'removing the child must release its URI mapping');
        assert.deepEqual(errors, []);
    } finally {
        await clients.dispose();
        await executables.disposeLanguageServerExecutables();
        folders = [];
        vscode.workspace.textDocuments.splice(0, vscode.workspace.textDocuments.length, ...documents);
        await rm(directory, { recursive: true, force: true });
    }
});

test('diagnostics from a later linked child remain visible through its editor path', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-client-linked-child-')));
    const documents = [...vscode.workspace.textDocuments];
    const parent = path.join(directory, 'long-parent-workspace');
    const actual = path.join(directory, 'x');
    const alias = path.join(parent, 'linked-child');
    await mkdir(parent); await mkdir(actual);
    await symlink(actual, alias, 'junction');
    const main = path.join(parent, 'main.tl'), inner = path.join(alias, 'inner.tl');
    await writeFile(main, ''); await writeFile(inner, '');
    executableFile = path.join(directory, 'teal.exe');
    await writeFile(executableFile, 'fixture executable, never executed');
    folders = [{ uri: fileUri(parent), name: 'parent', index: 0 }, { uri: fileUri(alias), name: 'child', index: 1 }];
    vscode.workspace.textDocuments.splice(0, documents.length, { uri: fileUri(main), languageId: 'teal', isClosed: false });
    clientOptions.length = 0;
    fault = undefined; entries = [];
    const errors: unknown[] = [];
    const clients = new LanguageClients({ report: (error: unknown) => { errors.push(error); }, output: { appendLine() {} } } as unknown as Reporter);
    try {
        await clients.refresh();
        vscode.workspace.textDocuments.push({ uri: fileUri(inner), languageId: 'teal', isClosed: false });
        await clients.refresh();
        assert.equal(clientOptions.length, 2, 'the original parent client remains alive');
        const child = clientOptions[1];
        const editorUri = child.uriConverters!.protocol2Code(pathToFileURL(path.join(actual, 'inner.tl')).href);
        assert.equal(editorUri.fsPath, inner);
        const diagnostic = { message: 'child compiler error' } as import('vscode').Diagnostic;
        let published: readonly import('vscode').Diagnostic[] | undefined;
        await child.middleware!.handleDiagnostics!(editorUri, [diagnostic], (_uri, diagnostics) => { published = diagnostics; });
        assert.deepEqual(published, [diagnostic]);
        assert.deepEqual(errors, []);
    } finally {
        await clients.dispose();
        await executables.disposeLanguageServerExecutables();
        folders = [];
        vscode.workspace.textDocuments.splice(0, vscode.workspace.textDocuments.length, ...documents);
        await rm(directory, { recursive: true, force: true });
    }
});
