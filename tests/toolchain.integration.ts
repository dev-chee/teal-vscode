import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runArguments } from '../src/configuration';
import { prepareDebugConfiguration } from '../src/debugOptions';
import { LanguageSessions, type LanguageGroup } from '../src/languageSessions';
import { executableName } from '../src/platform';
import { resolveToolchain } from '../src/toolchain';
import { ProtocolPeer } from './helpers/protocolPeer';

const toolchain = process.env.TEAL_TOOLCHAIN_PATH;
assert.ok(toolchain, 'Set TEAL_TOOLCHAIN_PATH to rebuilt native Teal executables');
const tool = (name: string) => path.join(toolchain, executableName(name));
const document = (file: string) => ({ path: file, uri: pathToFileURL(file).toString() });

test('CLI receives generated run arguments, Unicode arguments and synchronous terminal input', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-cli-integration-'));
    try {
        assert.equal(Object.keys((await resolveToolchain(toolchain)).tools).length, 4);
        const program = path.join(root, '中文 with spaces.tl');
        await writeFile(program, 'task main() { let args = argv(); if args[0] != "a b" { exit(17); } if args[1] != "中文" { exit(19); } if input() != "stdin value" { exit(18); } }\n');
        await writeFile(path.join(root, 'permissions.toml'), '[permissions]\nrules = []\n');
        const result = spawnSync(tool('teal'), runArguments(program, ['--tier', 'hosted', '--permission-file', 'permissions.toml'], ['a b', '中文']), { cwd: root, input: 'stdin value\n', encoding: 'utf8', timeout: Number(process.env.TEAL_TEST_TIMEOUT_MS ?? 20_000) });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('session coordination refreshes a real parent LSP after saving a nested dependency', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-lsp-integration-'));
    const peers: Array<{ group: LanguageGroup; peer: ProtocolPeer }> = [];
    const errors: unknown[] = [];
    await mkdir(path.join(root, 'child'));
    const main = document(path.join(root, 'main.tl'));
    const lib = document(path.join(root, 'child/lib.tl'));
    await writeFile(main.path, 'import "child/lib.tl" as lib;\nfn main() { let value: int = lib::value(); print(value); }\n');
    await writeFile(lib.path, 'pub fn value() -> int { return 1; }\n');
    const groups = [{ key: 'parent', root, documents: [main] }, { key: 'child', root: path.dirname(lib.path), documents: [lib] }];
    const sessions = new LanguageSessions({
        groups: () => groups,
        report: (error) => errors.push(error),
        start: async (group) => {
            const peer = new ProtocolPeer(tool('teal-lsp'), group.root);
            peers.push({ group, peer });
            try {
                await peer.request('initialize', { rootUri: pathToFileURL(group.root).toString(), capabilities: {}, initializationOptions: { entryFiles: [] } });
                peer.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
                for (const file of group.documents) peer.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: file.uri, languageId: 'teal', version: 1, text: await readFile(file.path, 'utf8') } } });
                await peer.request('textDocument/documentSymbol', { textDocument: { uri: group.documents[0].uri } });
                return { isRunning: () => peer.process.exitCode === null && peer.process.signalCode === null, dispose: () => peer.dispose() };
            } catch (error) { await peer.dispose(); throw error; }
        },
    });
    try {
        await sessions.refresh();
        assert.deepEqual(errors, []);
        const initial = await peers[0].peer.wait((message) => message.method === 'textDocument/publishDiagnostics' && message.params?.uri === main.uri);
        assert.ok(!initial.params?.diagnostics?.some((diagnostic) => diagnostic.severity === 1));
        await writeFile(lib.path, 'pub fn value() -> string { return "changed"; }\n');
        peers[1].peer.send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri: lib.uri, version: 2 }, contentChanges: [{ text: await readFile(lib.path, 'utf8') }] } });
        sessions.diskChanged(lib);
        await sessions.refresh();
        assert.deepEqual(errors, []);
        assert.equal(peers.length, 3);
        assert.equal(peers[2].group.key, 'parent');
        assert.equal(peers[1].peer.process.exitCode, null);
        const refreshed = await peers[2].peer.wait((message) => message.method === 'textDocument/publishDiagnostics' && message.params?.uri === main.uri);
        assert.ok(refreshed.params?.diagnostics?.some((diagnostic) => diagnostic.severity === 1 && diagnostic.message.includes('Expected int')));
    } finally { await sessions.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('normalized launch options reach real DAP and support stop, stack trace and continue', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-dap-integration-'));
    const peer = new ProtocolPeer(tool('teal-dap'), root);
    let child: ChildProcess | undefined;
    try {
        const program = path.join(root, 'main.tl');
        await writeFile(program, 'task main() { let value = 1; print(value); }\n');
        await writeFile(path.join(root, 'permissions.toml'), '[permissions]\nrules = []\n');
        const config = await prepareDebugConfiguration({ type: 'teal', request: 'launch', name: 'probe', program, tier: 'hosted', permissionFile: 'permissions.toml', stopOnEntry: true }, { baseDirectory: root, documents: [] });
        await peer.response(peer.dap('initialize', { adapterID: 'teal', supportsRunInTerminalRequest: true }));
        const seq = peer.dap('launch', config);
        const terminal = await peer.wait((message) => message.type === 'request' && message.command === 'runInTerminal');
        const args = terminal.arguments?.args;
        assert.ok(args);
        assert.equal(terminal.arguments?.kind, 'integrated');
        assert.equal(args[args.indexOf('--tier') + 1], 'hosted');
        assert.equal(args[args.indexOf('--permission-file') + 1], path.join(root, 'permissions.toml'));
        child = spawn(args[0], args.slice(1), { cwd: terminal.arguments?.cwd, stdio: 'ignore' });
        const exited = once(child, 'exit');
        void exited.catch(() => {});
        peer.send({ seq: 100, type: 'response', request_seq: terminal.seq, command: 'runInTerminal', success: true, body: { processId: child.pid } });
        await peer.response(seq);
        await peer.wait((message) => message.event === 'initialized');
        await peer.response(peer.dap('configurationDone'));
        await peer.wait((message) => message.event === 'stopped');
        const stack = await peer.response(peer.dap('stackTrace', { threadId: 1 }));
        assert.ok(stack.body?.stackFrames?.length);
        await peer.response(peer.dap('continue', { threadId: 1 }));
        await peer.wait((message) => message.event === 'terminated');
        assert.equal((await exited)[0], 0);
    } finally {
        await peer.dispose();
        if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
        await rm(root, { recursive: true, force: true });
    }
});
