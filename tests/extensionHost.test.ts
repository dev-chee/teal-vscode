import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Mocha from 'mocha';
import * as vscode from 'vscode';
import { DebugConfigurations } from '../src/execution';
import { executableName, isWithinRoot } from '../src/platform';
import { waitForWatcher } from './watcherReadiness';

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

        async function updateFolders(...args: Parameters<typeof vscode.workspace.updateWorkspaceFolders>): Promise<void> {
            let changed = false;
            const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { changed = true; });
            try {
                if (!vscode.workspace.updateWorkspaceFolders(...args)) {
                    await waitFor(async () => changed ? true : undefined, 'previous workspace folder change must complete');
                    changed = false;
                    assert.equal(vscode.workspace.updateWorkspaceFolders(...args), true);
                }
                await waitFor(async () => changed ? true : undefined, 'workspace folder change must complete');
            } finally { listener.dispose(); }
        }

        async function closeAndRemove(directory: string): Promise<void> {
            for (const document of vscode.workspace.textDocuments) {
                if (document.uri.scheme !== 'file' || document.isClosed || !isWithinRoot(directory, document.uri.fsPath)) continue;
                if (document.isDirty) {
                    await vscode.window.showTextDocument(document);
                    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
                }
                // VS Code 可在关闭标签后缓存模型；释放夹具的语言归属，避免后续用例继续启动旧根。
                if (!document.isClosed && document.languageId === 'teal') await vscode.languages.setTextDocumentLanguage(document, 'plaintext');
            }
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            // 保留磁盘夹具到宿主退出，避免 Windows 进程持有工作目录时的删除冲突。
        }

        test('cold-starts from a Teal document, registers commands, and recognizes a Teal document', async () => {
            const toolchain = process.env.TEAL_TOOLCHAIN_PATH;
            assert.ok(toolchain, 'TEAL_TOOLCHAIN_PATH must point at rebuilt Teal executables');
            await vscode.workspace.getConfiguration('teal').update('toolchain.path', toolchain, vscode.ConfigurationTarget.Global);
            for (const command of ['teal.restartServer', 'teal.installToolchain', 'teal.runFile', 'teal.debugFile', 'teal.showOutput', 'teal.openSettings']) {
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
                for (const command of ['teal.restartServer', 'teal.installToolchain', 'teal.runFile', 'teal.debugFile', 'teal.showOutput', 'teal.openSettings']) {
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
                const position = new vscode.Position(1, 28);
                await waitFor(async () => {
                    const completion = await vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[]>('vscode.executeCompletionItemProvider', document.uri, position);
                    const labels = Array.isArray(completion) ? completion.map((item) => item.label) : completion?.items.map((item) => item.label);
                    return labels?.some((label) => label === 'helper') ? true : undefined;
                }, 'completion must include the declared helper');
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

        test('serves concrete LSP updates for external path dependencies, deletion recovery and manifest retargeting', async () => {
            const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-vscode-external-dependency-')));
            const app = path.join(root, 'app');
            const dependency = path.join(root, 'dep/src/lib.tl');
            const replacement = path.join(root, 'replacement/src/lib.tl');
            const main = vscode.Uri.file(path.join(app, 'src/main.tl'));
            const anchorCount = vscode.workspace.workspaceFolders?.length ?? 0;
            const manifest = (name: string, module: string) => `format = 10\nname = "${name}"\nversion = "1.0.0"\nlanguage_edition = "2026"\nmodules = ["${module}"]\n`;
            const appManifest = (relative: string) => manifest('app', 'main.tl')
                + `[dependencies]\ndep = { path = "${relative}", version = "1.0.0" }\n`;
            const errors = () => vscode.languages.getDiagnostics(main).filter(item => item.severity === vscode.DiagnosticSeverity.Error);
            const mismatch = (type: string) => errors().some(item => item.message.includes('Expected int') && item.message.includes(`type is ${type}`));
            const primeWatcher = (file: string) => waitForWatcher(
                () => writeFile(file, 'pub fn value() -> bool { return true; }\n'),
                () => mismatch('bool'),
                `external dependency watcher did not become ready: ${file}`,
            );
            try {
                for (const name of ['app', 'dep', 'replacement']) await mkdir(path.join(root, name, 'src'), { recursive: true });
                await writeFile(path.join(app, 'package.toml'), appManifest('../dep'));
                await writeFile(path.join(root, 'dep/package.toml'), manifest('dep', 'lib.tl'));
                await writeFile(path.join(root, 'replacement/package.toml'), manifest('dep', 'lib.tl'));
                await writeFile(dependency, 'pub fn value() -> int { return 1; }\n');
                await writeFile(replacement, 'pub fn value() -> int { return 2; }\n');
                await writeFile(main.fsPath, 'use dep::lib;\nfn main() {\n    let value: int = lib::value();\n    print(value);\n}\n');
                await vscode.workspace.getConfiguration('teal').update('toolchain.path', process.env.TEAL_TOOLCHAIN_PATH!, vscode.ConfigurationTarget.Global);
                await updateFolders(anchorCount, 0, { uri: vscode.Uri.file(app), name: 'consumer' });
                await waitFor(async () => vscode.workspace.workspaceFolders?.some(folder => folder.uri.fsPath.toLowerCase() === app.toLowerCase()) ? true : undefined, 'consumer workspace must be added');
                const document = await vscode.workspace.openTextDocument(main);
                await vscode.window.showTextDocument(document);
                const position = document.positionAt(document.getText().indexOf('lib::value') + 'lib::v'.length);
                const definition = () => vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', main, position);
                await waitFor(async () => {
                    const target = (await definition())?.[0];
                    return target?.uri.fsPath.toLowerCase() === dependency.toLowerCase() ? true : undefined;
                }, 'external dependency must initially resolve');
                assert.deepEqual(errors(), []);

                // 首次导航可能早于外部目录系统监听的安装，先用独特诊断确认完整事件链路。
                await primeWatcher(dependency);
                await writeFile(dependency, 'pub fn value() -> int { return 1; }\n');
                await waitFor(async () => errors().length === 0 ? true : undefined, 'watcher probe must recover before the single save');
                await writeFile(dependency, 'pub fn padding() -> int { return 0; }\npub fn value() -> string { return "changed"; }\n');
                await waitFor(async () => mismatch('string') ? true : undefined, 'external save must refresh consumer diagnostics without restart');
                assert.equal((await definition())?.[0]?.range.start.line, 1, 'navigation must use the changed dependency text');

                await rm(dependency);
                await waitFor(async () => errors().some(item => /module|source|not found|cannot|missing/i.test(item.message)) ? true : undefined, 'deleted external dependency must invalidate its consumer');
                await writeFile(dependency, 'pub fn value() -> int { return 3; }\n');
                await waitFor(async () => errors().length === 0 ? true : undefined, 'recreated external dependency must recover without restart');

                await writeFile(path.join(app, 'package.toml'), appManifest('../replacement'));
                await waitFor(async () => {
                    const target = (await definition())?.[0];
                    return target?.uri.fsPath.toLowerCase() === replacement.toLowerCase() ? true : undefined;
                }, 'manifest change must replace the watched dependency');
                await primeWatcher(replacement);
                await writeFile(replacement, 'pub fn value() -> string { return "replacement"; }\n');
                await waitFor(async () => mismatch('string') ? true : undefined, 'replacement dependency must be watched');
            } finally {
                await vscode.commands.executeCommand('workbench.action.closeAllEditors');
                if ((vscode.workspace.workspaceFolders?.length ?? 0) > anchorCount) {
                    await updateFolders(anchorCount, (vscode.workspace.workspaceFolders?.length ?? 0) - anchorCount);
                    await waitFor(async () => vscode.workspace.workspaceFolders?.length === anchorCount ? true : undefined, 'consumer workspace must be removed');
                }
                await closeAndRemove(root);
            }
        });

        for (const linked of [false, true]) {
            test(linked ? 'serves concrete LSP workspace symbols through linked roots and nested real roots'
                : 'keeps nested multi-root workspace symbols isolated to one language client', async () => {
                const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-vscode-multiroot-')));
                const actual = linked ? path.join(directory, 'real') : directory;
                const root = linked ? path.join(directory, 'a much longer workspace alias') : actual;
                const nested = path.join(actual, 'nested root');
                const outer = path.join(root, 'outer.tl');
                const inner = path.join(nested, 'inner.tl');
                const outerName = linked ? 'linked_outer_symbol' : 'direct_outer_symbol';
                const innerName = linked ? 'linked_inner_symbol' : 'direct_inner_symbol';
                const anchorCount = vscode.workspace.workspaceFolders?.length ?? 0;
                try {
                    await mkdir(nested, { recursive: true });
                    if (linked) await symlink(actual, root, 'junction');
                    await writeFile(outer, `fn ${outerName}() { }\n`);
                    await writeFile(inner, `fn ${innerName}() { }\n`);
                    assert.ok(anchorCount >= 1, 'the test runner must retain its initial workspace anchor');
                    await updateFolders(anchorCount, 0,
                        { uri: vscode.Uri.file(root), name: 'outer root' },
                        { uri: vscode.Uri.file(nested), name: 'nested root' });
                    await waitFor(async () => vscode.workspace.workspaceFolders?.length === anchorCount + 2 ? true : undefined, 'two workspace roots must be installed');
                    const outerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(outer));
                    const innerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(inner));
                    await vscode.window.showTextDocument(outerDocument);
                    await vscode.window.showTextDocument(innerDocument);
                    const symbols = await waitFor(async () => {
                        const items = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', 'symbol');
                        return items?.filter((item) => item.name === outerName || item.name === innerName).length === 2 ? items : undefined;
                    }, 'both roots must publish workspace symbols');
                    const matched = symbols.filter((item) => item.name === outerName || item.name === innerName);
                    assert.equal(matched.filter((item) => item.name === outerName).length, 1, 'outer declaration must not be duplicated by the nested server');
                    assert.equal(matched.filter((item) => item.name === innerName).length, 1, 'nested declaration must not be duplicated by the outer server');
                    assert.ok(matched.some((item) => item.name === innerName
                        && path.normalize(item.location.uri.fsPath).toLocaleLowerCase() === path.normalize(inner).toLocaleLowerCase()), `nested symbol must retain its exact file URI: expected ${inner}; got ${matched.map(item => item.location.uri.fsPath).join(', ')}`);
                } finally {
                    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
                    if ((vscode.workspace.workspaceFolders?.length ?? 0) > anchorCount) {
                        await updateFolders(anchorCount, (vscode.workspace.workspaceFolders?.length ?? 0) - anchorCount);
                        await waitFor(async () => vscode.workspace.workspaceFolders?.length === anchorCount ? true : undefined, 'test workspace roots must be removed');
                    }
                    await closeAndRemove(directory);
                }
            });
        }

        for (const linked of [false, true]) {
            test(`serves concrete LSP URI mappings for ${linked ? 'linked' : 'regular'} workspace buffers`, async () => {
                const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-vscode-uri-')));
                const actual = path.join(directory, 'real');
                const root = linked ? path.join(directory, 'alias') : actual;
                const name = '中文 # [uri].tl';
                const source = path.join(root, name);
                const anchorCount = vscode.workspace.workspaceFolders?.length ?? 0;
                const text = 'fn helper(value: int) -> int { return value; }\nfn main() { print(helper(1)); }\n';
                try {
                    await mkdir(actual);
                    if (linked) await symlink(actual, root, 'junction');
                    await writeFile(path.join(actual, name), text);
                    await vscode.workspace.getConfiguration('teal').update('toolchain.path', process.env.TEAL_TOOLCHAIN_PATH!, vscode.ConfigurationTarget.Global);
                    await updateFolders(anchorCount, 0, { uri: vscode.Uri.file(root), name: 'URI regression' });
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
                    const editor = await vscode.window.showTextDocument(document);
                    await waitFor(async () => (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', document.uri))?.some(item => item.name === 'helper') ? true : undefined,
                        'the opened document must be served before testing URI mapping');
                    const replace = (value: string) => editor.edit(builder => builder.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), value));
                    assert.equal(await replace(text.replace('helper(1)', 'helper(missing_uri_name)')), true);
                    await waitFor(async () => vscode.languages.getDiagnostics(document.uri).some(item => item.message.includes('missing_uri_name')) ? true : undefined,
                        'diagnostics must use the opened document URI');
                    assert.equal(await replace(text.replace('helper(1)', 'helper(7)')), true);
                    await waitFor(async () => vscode.languages.getDiagnostics(document.uri).length === 0 ? true : undefined, 'the corrected alias buffer must clear its diagnostic');
                    const position = document.positionAt(document.getText().indexOf('helper(7)') + 2);
                    const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', document.uri, position);
                    assert.equal(definitions?.[0]?.uri.toString(), document.uri.toString());
                    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', document.uri, position, 'renamed');
                    assert.equal(edit?.get(document.uri).length, 2, 'both rename edits must target the current buffer');
                    assert.equal(await vscode.workspace.applyEdit(edit!), true);
                    assert.ok(document.getText().includes('fn renamed(') && document.getText().includes('renamed(7)'));
                    assert.equal(document.isDirty, true);
                    assert.equal(await readFile(path.join(actual, name), 'utf8'), text, 'rename must preserve unsaved buffer ownership');
                    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
                } finally {
                    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
                    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
                    if ((vscode.workspace.workspaceFolders?.length ?? 0) > anchorCount) {
                        await updateFolders(anchorCount, (vscode.workspace.workspaceFolders?.length ?? 0) - anchorCount);
                    }
                    await closeAndRemove(directory);
                }
            });
        }

        test('serves concrete LSP diagnostics after a nested workspace takes ownership of a buffer', async () => {
            const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-vscode-diagnostics-')));
            const nested = path.join(root, 'child');
            const outer = vscode.Uri.file(path.join(root, 'outer.tl'));
            const inner = vscode.Uri.file(path.join(nested, 'inner.tl'));
            const probe = vscode.Uri.file(path.join(root, 'probe.tli'));
            const anchorCount = vscode.workspace.workspaceFolders?.length ?? 0;
            const errors = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter(item => item.severity === vscode.DiagnosticSeverity.Error);
            try {
                await mkdir(nested);
                await writeFile(outer.fsPath, 'fn main() { print(1); }\n');
                await writeFile(inner.fsPath, 'fn main() { print(missing_child_name); }\n');
                await vscode.workspace.getConfiguration('teal').update('toolchain.path', process.env.TEAL_TOOLCHAIN_PATH!, vscode.ConfigurationTarget.Global);
                await updateFolders(anchorCount, 0, { uri: vscode.Uri.file(root), name: 'parent' }, { uri: vscode.Uri.file(nested), name: 'child' });
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(outer));
                await waitFor(async () => (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', outer))?.some(item => item.name === 'main') ? true : undefined,
                    'the parent client must be running');
                await waitForWatcher(() => writeFile(probe.fsPath, 'builtin global { fn broken( }\n'),
                    () => errors(probe).length > 0 && errors(inner).some(item => item.message.includes('missing_child_name')),
                    'the parent must initially publish its closed child diagnostic');
                const document = await vscode.workspace.openTextDocument(inner);
                const editor = await vscode.window.showTextDocument(document);
                await waitFor(async () => (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', inner))?.some(item => item.name === 'main') ? true : undefined,
                    'the child client must take ownership');
                await waitFor(async () => errors(inner).some(item => item.message.includes('missing_child_name')) ? true : undefined,
                    'the child client must publish its initial diagnostic');
                const before = errors(inner).length;
                assert.ok(before > 0);
                const text = document.getText().replace('missing_child_name', '1');
                assert.equal(await editor.edit(builder => builder.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text)), true);
                await waitFor(async () => errors(inner).length < before ? true : undefined, 'the child client must clear its current diagnostic');
                assert.deepEqual(errors(inner), [], 'the parent must not retain its old disk diagnostic');
                assert.ok(errors(probe).length > 0, 'the parent must retain diagnostics it still owns');
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            } finally {
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
                await vscode.commands.executeCommand('workbench.action.closeAllEditors');
                if ((vscode.workspace.workspaceFolders?.length ?? 0) > anchorCount) {
                    await updateFolders(anchorCount, (vscode.workspace.workspaceFolders?.length ?? 0) - anchorCount);
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
            const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-vscode-dap-external-')));
            const source = path.join(root, 'external-debuggee.tl');
            const stopped: Array<{ session: vscode.DebugSession; reason: unknown }> = [];
            const trace: string[] = [];
            const adapterErrors: string[] = [];
            const exitCodes: unknown[] = [];
            const disconnectResponses: unknown[] = [];
            const reportDirectory = process.env.TEAL_TEST_REPORT_DIR
                ?? path.join(vscode.extensions.getExtension('dev-chee.teal-vscode')!.extensionPath, 'target', 'test-gate', 'local-vscode');
            await mkdir(reportDirectory, { recursive: true });
            let report = Promise.resolve();
            let stage = 'launch';
            let terminated = false;
            const record = (direction: string, message: unknown) => {
                const safe = JSON.stringify(message)
                    .replace(/("token"\s*:\s*")[^"]*/gi, '$1<redacted>')
                    .replace(/("--token"\s*,\s*")[^"]*/gi, '$1<redacted>');
                trace.push(`${direction}:${safe}`);
                const snapshot = JSON.stringify({ source, stage, stopped: stopped.length, terminated, exitCodes, disconnectResponses, adapterErrors, trace }, null, 2);
                // 启动请求可能停在编辑器或外部终端中；逐帧保存，以便宿主超时后仍能定位边界。
                report = report.then(() => writeFile(path.join(reportDirectory, 'dap-external-trace.json'), snapshot));
            };
            const tracker = vscode.debug.registerDebugAdapterTrackerFactory('teal', {
                createDebugAdapterTracker(session) {
                    return {
                        onWillReceiveMessage(message) { record('client->adapter', message); },
                        onDidSendMessage(message) {
                            if (message.type === 'event' && message.event === 'stopped') stopped.push({ session, reason: message.body?.reason });
                            if (message.type === 'event' && message.event === 'exited') exitCodes.push(message.body?.exitCode);
                            if (message.type === 'event' && message.event === 'terminated') terminated = true;
                            if (message.type === 'response' && message.command === 'disconnect') disconnectResponses.push(message.success);
                            record('adapter->client', message);
                        },
                        onError(error) { adapterErrors.push(error.message); record('error', error.message); },
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
                stage = 'breakpoint';
                const event = await waitFor(async () => stopped[0], `external-terminal launch did not stop at the requested breakpoint; ${trace.join(' | ')}; errors=${adapterErrors.join(' | ')}`);
                assert.equal(event.reason, 'breakpoint', 'external-terminal launch must stop for the source breakpoint, not entry');
                const stack = await event.session.customRequest('stackTrace', { threadId: 1 }) as { stackFrames: Array<{ id: number }> };
                assert.ok(stack.stackFrames.length > 0, 'external-terminal breakpoint must expose a stack frame');
                stage = 'continue';
                await event.session.customRequest('continue', { threadId: 1 });
                await waitFor(async () => terminated ? true : undefined, 'external-terminal debuggee must terminate after continue');
                assert.deepEqual(exitCodes, [0], 'external-terminal debuggee must report a successful process exit');
                await waitFor(async () => disconnectResponses.length ? true : undefined, 'completed debuggee must acknowledge disconnect');
                assert.deepEqual(disconnectResponses, [true], 'disconnect after normal termination must succeed');
            } finally {
                record('cleanup', stage);
                await report;
                try { await vscode.debug.stopDebugging(); } catch { /* the debuggee may have already terminated */ }
                tracker.dispose();
                await closeAndRemove(root);
            }
        });

        test('runs a Teal file through ProcessExecution with program arguments and terminal stdin', async () => {
            const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-vscode-run-')));
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
                const child = spawn(path.join(process.env.TEAL_TOOLCHAIN_PATH!, executableName('teal')), [
                    'dap', '--debuggee', '--listen', `127.0.0.1:${port}`, '--token', token, '--program', source, '--stop-on-entry',
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
