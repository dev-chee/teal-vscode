import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Mocha from 'mocha';
import * as vscode from 'vscode';
import { DebugConfigurations } from '../src/execution';

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true });
    if (process.env.TEAL_TEST_GREP) mocha.grep(process.env.TEAL_TEST_GREP);
    mocha.suite.emit('pre-require', globalThis, __filename, mocha);
    mocha.suite.timeout(60_000);

    suite('Teal extension host', () => {
        async function waitFor<T>(action: () => Promise<T | undefined>, message: string): Promise<T> {
            const deadline = Date.now() + 12_000;
            let result: T | undefined;
            while (Date.now() < deadline) {
                result = await action();
                if (result !== undefined) return result;
                await new Promise((resolve) => setTimeout(resolve, 150));
            }
            throw new Error(message);
        }

        async function closeAndRemove(directory: string): Promise<void> {
            // Keep opened fixture files until the extension host exits: on Windows the LSP
            // subprocess owns them. The host's isolated temp profile is reclaimed on exit.
            void directory;
        }

        test('cold-starts from a Teal document, registers commands, and recognizes a Teal document', async () => {
            const toolchain = process.env.TEAL_TOOLCHAIN_PATH;
            assert.ok(toolchain, 'TEAL_TOOLCHAIN_PATH must point at rebuilt Teal executables');
            await vscode.workspace.getConfiguration('teal').update('toolchain.path', toolchain, vscode.ConfigurationTarget.Global);
            for (const command of ['teal.restartServer', 'teal.runFile', 'teal.debugFile', 'teal.showOutput', 'teal.openSettings']) {
                assert.ok(!(await vscode.commands.getCommands(true)).includes(command), 'test requires a cold extension host before opening Teal');
            }
            const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-host-'));
            try {
                const source = path.join(root, '中文 path.tl');
                await writeFile(source, 'fn main() { print("ok"); }\n');
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
                assert.equal(document.languageId, 'teal');
                await vscode.window.showTextDocument(document);
                const extension = vscode.extensions.getExtension('dev-chee.teal-vscode');
                assert.ok(extension, 'extension must be discoverable by its published identifier');
                await waitFor(async () => extension.isActive ? extension : undefined, 'opening a Teal document must activate the extension without extension.activate()');
                for (const command of ['teal.restartServer', 'teal.runFile', 'teal.debugFile', 'teal.showOutput', 'teal.openSettings']) {
                    assert.ok((await vscode.commands.getCommands(true)).includes(command), `${command} must be registered after language activation`);
                }
            } finally {
                await closeAndRemove(root);
            }
        });

        test('recognizes generated builtin interface files without treating them as executable source', async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-interface-'));
            try {
                const source = path.join(root, 'builtin.tli');
                await writeFile(source, 'builtin global {\n    fn print(values: printable...);\n}\n');
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
                assert.equal(document.languageId, 'teal-interface');
                const extension = vscode.extensions.getExtension('dev-chee.teal-vscode')!;
                assert.ok(extension.packageJSON.contributes.grammars.some((grammar: { language: string }) => grammar.language === document.languageId));
                assert.deepEqual(vscode.languages.getDiagnostics(document.uri), []);
            } finally { await closeAndRemove(root); }
        });

        test('debug configurations default to integrated terminal and reject invalid attach input', async () => {
            const configurations = new DebugConfigurations();
            const [defaultConfig] = configurations.provideDebugConfigurations();
            assert.equal(defaultConfig.console, 'integratedTerminal');
            await assert.rejects(
                configurations.resolveDebugConfigurationWithSubstitutedVariables(undefined, {
                    type: 'teal', request: 'attach', name: 'bad', host: 'not-an-ip', port: 0, token: '',
                }),
                /attach host/,
            );
        });

        test('resolves tier and permissionFile using debug cwd and rejects legacy launch options', async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-launch-'));
            try {
                const source = path.join(root, 'main.tl');
                const permissionFile = path.join(root, '权限 with spaces.toml');
                await writeFile(source, 'task main() {}\n');
                await writeFile(permissionFile, '[permissions]\nrules = []\n');
                const configurations = new DebugConfigurations();
                for (const tier of ['embedded', 'hosted', 'agentic']) {
                    const config = await configurations.resolveDebugConfigurationWithSubstitutedVariables(undefined, {
                        type: 'teal', request: 'launch', name: 'current', program: source,
                        cwd: root, console: 'integratedTerminal', tier, permissionFile: path.basename(permissionFile),
                        allow: ['unused_variable'], args: ['中文 argument'],
                    });
                    assert.equal(config.tier, tier);
                    assert.equal(config.permissionFile, permissionFile);
                    assert.deepEqual(config.allow, ['unused_variable']);
                    assert.deepEqual(config.args, ['中文 argument']);
                }
                for (const removed of [{ runtimeProfile: 'native' }, { allowCapabilities: [] }, { allowReadFiles: [] }]) {
                    await assert.rejects(configurations.resolveDebugConfigurationWithSubstitutedVariables(undefined, {
                        type: 'teal', request: 'launch', name: 'legacy', ...removed,
                    }), /was removed/);
                }
            } finally {
                await closeAndRemove(root);
            }
        });

        test('serves concrete LSP results for UTF-16 paths, unsaved changes, rename, diagnostics, formatting, and semantic tokens', async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-lsp-'));
            try {
                const source = path.join(root, '中文 space [lsp].tl');
                await writeFile(source, 'fn helper(value: int) -> int { return value; }\nfn main() { let answer = helper(1); }\n');
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
                await vscode.window.showTextDocument(document);
                await new Promise((resolve) => setTimeout(resolve, 900));
                const position = new vscode.Position(1, 28);
                const completion = await vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[]>('vscode.executeCompletionItemProvider', document.uri, position);
                const labels = Array.isArray(completion) ? completion.map((item) => item.label) : completion?.items.map((item) => item.label);
                assert.ok(labels?.some((label) => label === 'helper'), 'completion must include the declared helper');
                const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position);
                assert.ok(hover?.some((item) => item.contents.some((content) => typeof content === 'string' ? content.includes('helper') : content.value.includes('helper'))), 'hover must identify helper');
                const definition = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', document.uri, position);
                assert.ok(definition?.some((item) => item.uri.toString() === document.uri.toString() && item.range.start.line === 0), 'definition must point to helper declaration');
                const references = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', document.uri, position);
                assert.ok(references && references.length >= 2, 'references must include declaration and use');
                const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', document.uri);
                const symbolLine = (item: vscode.DocumentSymbol | vscode.SymbolInformation) => item instanceof vscode.SymbolInformation ? item.location.range.start.line : item.range.start.line;
                assert.ok(symbols?.some((item) => item.name === 'helper' && symbolLine(item) === 0), 'symbols must retain the helper declaration location');
                assert.ok(symbols?.some((item) => item.name === 'value' && symbolLine(item) === 0), 'symbols must retain the parameter declaration location');
                assert.ok(symbols?.some((item) => item.name === 'main' && symbolLine(item) === 1), 'symbols must retain the main declaration location');
                assert.ok(symbols?.some((item) => item.name === 'answer' && symbolLine(item) === 1), 'symbols must retain the local declaration location');
                const workspace = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', 'helper');
                assert.ok(workspace?.some((item) => item.name === 'helper'), 'workspace symbol must include helper');
                const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', document.uri, { insertSpaces: true, tabSize: 4 });
                assert.ok(edits && edits.length > 0, 'formatting provider must produce the canonical document edits');
                const semantic = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', document.uri);
                assert.ok(semantic && semantic.data.length >= 10, 'semantic tokens must encode declarations and uses');
                const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', document.uri, new vscode.Position(1, 32));
                assert.equal(signature?.signatures[0]?.label, 'fn helper(value: int) -> int', 'signature help must expose the declared Teal signature');
                const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', document.uri, position, 'renamed');
                const renamed = rename?.get(document.uri) ?? [];
                assert.equal(renamed.length, 2, 'rename must edit both declaration and call');
                assert.ok(renamed.every((edit) => edit.newText === 'renamed'), 'rename edits must use the requested identifier');

                const editor = vscode.window.activeTextEditor;
                assert.ok(editor && editor.document.uri.toString() === document.uri.toString());
                await editor.edit((builder) => builder.replace(new vscode.Range(1, 24, 1, 30), 'missing_name'));
                const diagnostics = await waitFor(async () => {
                    const items = vscode.languages.getDiagnostics(document.uri);
                    return items.find((item) => /missing_name|unknown|unresolved/i.test(item.message));
                }, 'unsaved edits must be sent to LSP diagnostics');
                assert.equal(diagnostics.range.start.line, 1, 'diagnostic must refer to the unsaved second-line edit');
            } finally {
                await closeAndRemove(root);
            }
        });

        test('keeps nested multi-root workspace symbols isolated to one language client', async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-multiroot-'));
            const nested = path.join(root, 'nested root');
            const outer = path.join(root, 'outer.tl');
            const inner = path.join(nested, 'inner.tl');
            const anchorCount = vscode.workspace.workspaceFolders?.length ?? 0;
            try {
                await writeFile(outer, 'fn outer_symbol() { }\n');
                await mkdir(nested, { recursive: true });
                await writeFile(inner, 'fn inner_symbol() { }\n');
                assert.ok(anchorCount >= 1, 'the test runner must retain its initial workspace anchor');
                assert.equal(vscode.workspace.updateWorkspaceFolders(anchorCount, 0,
                    { uri: vscode.Uri.file(root), name: 'outer root' },
                    { uri: vscode.Uri.file(nested), name: 'nested root' }), true);
                await waitFor(async () => vscode.workspace.workspaceFolders?.length === anchorCount + 2 ? true : undefined, 'two workspace roots must be installed');
                const outerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(outer));
                const innerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(inner));
                await vscode.window.showTextDocument(outerDocument);
                await vscode.window.showTextDocument(innerDocument);
                const symbols = await waitFor(async () => {
                    const items = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', 'symbol');
                    return items?.filter((item) => item.name === 'outer_symbol' || item.name === 'inner_symbol').length === 2 ? items : undefined;
                }, 'both roots must publish workspace symbols');
                const matched = symbols.filter((item) => item.name === 'outer_symbol' || item.name === 'inner_symbol');
                assert.equal(matched.filter((item) => item.name === 'outer_symbol').length, 1, 'outer declaration must not be duplicated by the nested server');
                assert.equal(matched.filter((item) => item.name === 'inner_symbol').length, 1, 'nested declaration must not be duplicated by the outer server');
                assert.ok(matched.some((item) => item.name === 'inner_symbol'
                    && path.normalize(item.location.uri.fsPath).toLocaleLowerCase() === path.normalize(inner).toLocaleLowerCase()), 'nested symbol must retain its exact file URI');
            } finally {
                await vscode.commands.executeCommand('workbench.action.closeAllEditors');
                if ((vscode.workspace.workspaceFolders?.length ?? 0) > anchorCount) {
                    vscode.workspace.updateWorkspaceFolders(anchorCount, (vscode.workspace.workspaceFolders?.length ?? 0) - anchorCount);
                    await waitFor(async () => vscode.workspace.workspaceFolders?.length === anchorCount ? true : undefined, 'test workspace roots must be removed');
                }
                await closeAndRemove(root);
            }
        });

        test('refreshes LSP symbols after disk create, change, delete, and an explicit restart', async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-watch-'));
            const initial = path.join(root, 'initial.tl');
            const created = path.join(root, 'created.tl');
            const symbols = async (query: string) => vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query);
            try {
                await writeFile(initial, 'fn watch_initial() { }\n');
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(initial)));
                await waitFor(async () => (await symbols('watch_initial'))?.some((item) => item.name === 'watch_initial') ? true : undefined, 'initial LSP symbol must be available');
                await writeFile(created, 'fn watch_created() { }\n');
                await waitFor(async () => (await symbols('watch_created'))?.some((item) => item.name === 'watch_created') ? true : undefined, 'watcher create must restart LSP and publish the new file');
                await writeFile(created, 'fn watch_changed() { }\n');
                await waitFor(async () => (await symbols('watch_changed'))?.some((item) => item.name === 'watch_changed') ? true : undefined, 'watcher change must refresh LSP symbols');
                await vscode.workspace.fs.delete(vscode.Uri.file(created));
                await waitFor(async () => ((await symbols('watch_changed')) ?? []).every((item) => item.name !== 'watch_changed') ? true : undefined, 'watcher delete must remove stale LSP symbols');
                await vscode.commands.executeCommand('teal.restartServer');
                await waitFor(async () => (await symbols('watch_initial'))?.some((item) => item.name === 'watch_initial') ? true : undefined, 'explicit restart must restore LSP symbols');
            } finally {
                await vscode.commands.executeCommand('workbench.action.closeAllEditors');
                await closeAndRemove(root);
            }
        });

        test('recovers from a missing configured tool without blocking a later real LSP session', async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-missing-tool-'));
            const source = path.join(root, 'recovered.tl');
            const missing = path.join(root, 'missing tools');
            try {
                await writeFile(source, 'fn recovered_symbol() { }\n');
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
                await vscode.window.showTextDocument(document);
                await vscode.workspace.getConfiguration('teal', document.uri).update('toolchain.path', missing, vscode.ConfigurationTarget.Global);
                const failedRun = await vscode.commands.executeCommand<vscode.TaskExecution | undefined>('teal.runFile', document.uri);
                assert.equal(failedRun, undefined, 'missing Teal executable must be reported instead of starting a task');
                await vscode.workspace.getConfiguration('teal', document.uri).update('toolchain.path', process.env.TEAL_TOOLCHAIN_PATH!, vscode.ConfigurationTarget.Global);
                await vscode.commands.executeCommand('teal.restartServer');
                await waitFor(async () => (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', 'recovered_symbol'))?.some((item) => item.name === 'recovered_symbol') ? true : undefined,
                    'restoring the toolchain must allow a later LSP session to start');
            } finally {
                await closeAndRemove(root);
            }
        });

        test('launches the real integrated-terminal DAP adapter and observes a stopped protocol session', async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-dap-'));
            const source = path.join(root, 'debuggee.tl');
            const stopped: vscode.DebugSession[] = [];
            const received: string[] = [];
            const adapterErrors: string[] = [];
            const trace: string[] = [];
            const terminalOutput: string[] = [];
            let stage = 'startDebugging';
            let session: vscode.DebugSession | undefined;
            const shellIntegration = vscode.window as unknown as {
                onDidStartTerminalShellExecution?: (listener: (event: { terminal: vscode.Terminal; execution: { read(): AsyncIterable<string> } }) => void) => vscode.Disposable;
            };
            const shellListener = shellIntegration.onDidStartTerminalShellExecution?.((event) => {
                if (event.terminal.name !== 'Teal Debuggee') return;
                void (async () => { for await (const line of event.execution.read()) terminalOutput.push(line); })();
            });
            const record = (direction: string, message: Record<string, unknown>) => {
                const safe = JSON.stringify(message)
                    .replace(/("token"\s*:\s*")[^"]*/gi, '$1<redacted>')
                    .replace(/("--token"\s*,\s*")[^"]*/gi, '$1<redacted>');
                trace.push(`${direction}:${safe}`);
            };
            const tracker = vscode.debug.registerDebugAdapterTrackerFactory('teal', {
                createDebugAdapterTracker(session) {
                    return {
                        onWillReceiveMessage(message) { record('adapter->client', message); if (typeof message.command === 'string') received.push(message.command); },
                        onDidSendMessage(message) { record('client->adapter', message); if (message.type === 'event' && message.event === 'stopped') stopped.push(session); },
                        onError(error) { adapterErrors.push(error.name); },
                    };
                },
            });
            try {
                await writeFile(source, 'fn main() {\n    let value = 1;\n    let next_value = value + 1;\n    print(next_value);\n}\n');
                await writeFile(path.join(root, 'permissions.toml'), '[permissions]\nrules = []\n');
                vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(source), new vscode.Position(1, 4)))]);
                assert.equal(await vscode.debug.startDebugging(undefined, {
                    type: 'teal', request: 'launch', name: 'DAP integration', program: source,
                    cwd: root, console: 'integratedTerminal', stopOnEntry: true,
                    tier: 'hosted', permissionFile: 'permissions.toml',
                }), true, 'VS Code must accept the Teal launch configuration');
                const deadline = Date.now() + 35_000;
                while (!stopped[0] && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
                stage = 'received stopped';
                session = stopped[0];
                assert.ok(session, `DAP must emit stopped after integrated-terminal launch; requests=${received.join(',')}; adapterErrors=${adapterErrors.join(',')}; terminal=${terminalOutput.join('')}; trace=${trace.join(' | ')}`);
                assert.ok(received.includes('launch'), 'tracker must observe the DAP launch request');
                stage = 'stackTrace';
                const stack = await session.customRequest('stackTrace', { threadId: 1 }) as { stackFrames: Array<{ id: number }> };
                trace.push(`stackTrace:${JSON.stringify(stack)}`);
                assert.ok(stack.stackFrames.length > 0, 'stopped session must expose a stack frame');
                stage = 'scopes';
                const scopes = await session.customRequest('scopes', { frameId: stack.stackFrames[0].id }) as { scopes: Array<{ variablesReference: number }> };
                assert.ok(scopes.scopes.some((scope) => scope.variablesReference > 0), 'stack frame must expose expandable scopes');
                const variables = await session.customRequest('variables', { variablesReference: scopes.scopes.find((scope) => scope.variablesReference > 0)!.variablesReference }) as { variables: unknown[] };
                trace.push(`scopes:${JSON.stringify(scopes)} variables:${JSON.stringify(variables)}`);
                assert.ok(Array.isArray(variables.variables), 'scope variables response must be an array');
                stage = 'next';
                await session.customRequest('next', { threadId: 1 });
                const second = await waitFor(async () => stopped[1], 'next must produce a second stopped event');
                stage = 'continue';
                await second.customRequest('continue', { threadId: 1 });
            } catch (error) {
                throw new Error(`DAP failed during ${stage}; ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            } finally {
                try { if (session?.id && vscode.debug.activeDebugSession?.id === session.id) await vscode.debug.stopDebugging(session); }
                catch (error) { trace.push(`cleanup:${String(error)}`); }
                const reportDirectory = process.env.TEAL_TEST_REPORT_DIR
                    ?? path.join(vscode.extensions.getExtension('dev-chee.teal-vscode')!.extensionPath, 'target', 'test-gate', 'local-vscode');
                await mkdir(reportDirectory, { recursive: true });
                await writeFile(path.join(reportDirectory, 'dap-trace.json'), JSON.stringify({ stopped: stopped.length, trace, terminalOutput, adapterErrors }, null, 2));
                tracker.dispose();
                shellListener?.dispose();
                await closeAndRemove(root);
            }
        });

        test('launches the real external-terminal DAP debuggee at a source breakpoint and exits after continue', async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-dap-external-'));
            const source = path.join(root, 'external-debuggee.tl');
            const stopped: Array<{ session: vscode.DebugSession; reason: unknown }> = [];
            const trace: string[] = [];
            const adapterErrors: string[] = [];
            let terminated = false;
            const tracker = vscode.debug.registerDebugAdapterTrackerFactory('teal', {
                createDebugAdapterTracker(session) {
                    return {
                        onWillReceiveMessage(message) { trace.push(`request:${message.command ?? message.event ?? message.type}`); },
                        onDidSendMessage(message) {
                            trace.push(`response:${message.command ?? message.event ?? message.type}:${JSON.stringify(message.body ?? {})}`);
                            if (message.type === 'event' && message.event === 'stopped') stopped.push({ session, reason: message.body?.reason });
                            if (message.type === 'event' && message.event === 'terminated') terminated = true;
                        },
                        onError(error) { adapterErrors.push(error.message); },
                    };
                },
            });
            try {
                await writeFile(source, 'fn main() {\n    let value = 1;\n    print(value);\n}\n');
                vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(source), new vscode.Position(2, 4)))]);
                assert.equal(await vscode.debug.startDebugging(undefined, {
                    type: 'teal', request: 'launch', name: 'DAP external terminal', program: source,
                    cwd: root, console: 'externalTerminal', stopOnEntry: false,
                }), true, 'VS Code must accept the external-terminal launch configuration');
                const event = await waitFor(async () => stopped[0], `external-terminal launch did not stop at the requested breakpoint; ${trace.join(' | ')}; errors=${adapterErrors.join(' | ')}`);
                assert.equal(event.reason, 'breakpoint', 'external-terminal launch must stop for the source breakpoint, not entry');
                const stack = await event.session.customRequest('stackTrace', { threadId: 1 }) as { stackFrames: Array<{ id: number }> };
                assert.ok(stack.stackFrames.length > 0, 'external-terminal breakpoint must expose a stack frame');
                await event.session.customRequest('continue', { threadId: 1 });
                await waitFor(async () => terminated ? true : undefined, 'external-terminal debuggee must terminate after continue');
            } finally {
                try { await vscode.debug.stopDebugging(); } catch { /* the debuggee may have already terminated */ }
                tracker.dispose();
                await closeAndRemove(root);
            }
        });

        test('runs a Teal file through ProcessExecution with program arguments and terminal stdin', async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-run-'));
            const source = path.join(root, '运行 with input.tl');
            let taskExecution: vscode.TaskExecution | undefined;
            const ended = new Promise<vscode.TaskProcessEndEvent>((resolve) => {
                const listener = vscode.tasks.onDidEndTaskProcess((event) => {
                    if (event.execution === taskExecution) {
                        listener.dispose();
                        resolve(event);
                    }
                });
            });
            try {
                await writeFile(source, 'task main() {\n    let args = argv();\n    if args[0] != "argument with spaces" { exit(17); }\n    if args[1] != "中文 argument" { exit(19); }\n    if input() != "stdin value" { exit(18); }\n}\n');
                await vscode.workspace.getConfiguration('teal', vscode.Uri.file(source)).update('run.args', ['argument with spaces', '中文 argument'], vscode.ConfigurationTarget.Global);
                taskExecution = await vscode.commands.executeCommand<vscode.TaskExecution>('teal.runFile', vscode.Uri.file(source));
                assert.ok(taskExecution, 'teal.runFile must return the started ProcessExecution task');
                const terminal = await waitFor(async () => vscode.window.terminals.find((item) => item.name.includes('运行 with input')),
                    'teal.runFile must create a terminal for its ProcessExecution');
                terminal.sendText('stdin value', true);
                const event = await Promise.race([
                    ended,
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('teal.runFile did not finish after terminal stdin')), 20_000)),
                ]);
                assert.equal(event.exitCode, 0, 'Teal program must receive configured argv and terminal stdin');
            } finally {
                await vscode.workspace.getConfiguration('teal', vscode.Uri.file(source)).update('run.args', [], vscode.ConfigurationTarget.Global);
                await closeAndRemove(root);
            }
        });

        test('attaches to a pipe-captured debuggee and reports its actual post-authentication exit', async () => {
            const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-attach-'));
            const source = path.join(root, 'attach.tl');
            const port = 47_000 + Math.floor(Math.random() * 1_000);
            const token = 'attach-test-token';
            const stderr: string[] = [];
            const stopped: vscode.DebugSession[] = [];
            const tracker = vscode.debug.registerDebugAdapterTrackerFactory('teal', {
                createDebugAdapterTracker(session) {
                    return { onDidSendMessage(message) { if (message.type === 'event' && message.event === 'stopped') stopped.push(session); } };
                },
            });
            try {
                await writeFile(source, 'fn main() {\n    let value = 1;\n    print(value);\n}\n');
                const child = spawn(path.join(process.env.TEAL_TOOLCHAIN_PATH!, 'teal-dap.exe'), [
                    '--debuggee', '--listen', `127.0.0.1:${port}`, '--token', token, '--program', source, '--stop-on-entry',
                ], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', (chunk: string) => stderr.push(chunk));
                await waitFor(async () => stderr.join('').includes('listening on') ? true : undefined, 'debuggee must announce its listening endpoint');
                assert.equal(await vscode.debug.startDebugging(undefined, {
                    type: 'teal', request: 'attach', name: 'Teal attach probe', host: '127.0.0.1', port, token,
                }), true, 'VS Code must accept Teal attach configuration');
                const session = await waitFor(async () => stopped[0], `attached stop-on-entry debuggee did not stop; stderr=${stderr.join('')}`);
                const stack = await session.customRequest('stackTrace', { threadId: 1 }) as { stackFrames: Array<{ id: number }> };
                assert.ok(stack.stackFrames.length > 0, 'attached stopped debuggee must expose a stack frame');
                await session.customRequest('continue', { threadId: 1 });
                const [exitCode] = await Promise.race([
                    once(child, 'exit').then(([code]) => [code] as const),
                    new Promise<readonly [null]>((resolve) => setTimeout(() => resolve([null]), 15_000)),
                ]);
                await vscode.debug.stopDebugging();
                if (exitCode === null) child.kill();
                assert.notEqual(exitCode, null, `debuggee did not exit after attach; stderr=${stderr.join('')}`);
                assert.equal(exitCode, 0, `debuggee failed after authentication; stderr=${stderr.join('')}`);
            } finally {
                await vscode.debug.stopDebugging();
                tracker.dispose();
                await closeAndRemove(root);
            }
        });
    });

    return new Promise((resolve, reject) => {
        mocha.run((failures: number) => failures ? reject(new Error(`${failures} extension host tests failed`)) : resolve());
    });
}
