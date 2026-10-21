import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as executables from '../src/languageServerExecutable';
import type { Reporter } from '../src/reporting';

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
const vscode = {
    workspace: {
        isTrusted: true,
        textDocuments: [{ uri: { scheme: 'file', fsPath: path.join(tmpdir(), 'main.tl'), toString: () => pathToFileURL(path.join(tmpdir(), 'main.tl')).toString() }, languageId: 'teal', isClosed: false }],
        getWorkspaceFolder: () => folder,
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
    Uri: { file: (file: string) => ({ fsPath: file, toString: () => pathToFileURL(file).toString() }) },
    RelativePattern: class {},
    Disposable: { from: (...items: Array<{ dispose(): void }>) => ({ dispose() { items.forEach(item => item.dispose()); } }) },
};
class Client {
    state = 2;
    constructor() { if (fault === 'constructor') throw new Error('client construction failed'); }
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
        const source = path.join(root, 'teal-lsp.exe');
        executableFile = source;
        await writeFile(source, 'fixture executable, never executed');
        entries = failure === 'configuration' ? [123] : [];
        fault = failure === 'configuration' || failure === 'none' ? undefined : failure;
        disposedClients = disposedWatchers = 0;
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
