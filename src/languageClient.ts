import * as path from 'node:path';
import * as vscode from 'vscode';
import { CloseAction, ErrorAction, LanguageClient, State, type LanguageClientOptions } from 'vscode-languageclient/node';
import { stringArray } from './configuration';
import { isLocalTealDocument } from './documents';
import { executable, isSupported } from './environment';
import { LanguagePaths, resolveDocumentPaths, type ResolvedDocumentPaths } from './languagePaths';
import { LanguageDiagnostics } from './languageDiagnostics';
import { LanguageSessions, type LanguageGroup, type LanguageSession } from './languageSessions';
import { languageServerEnvironment, releaseLanguageServerExecutable, stageLanguageServerExecutable } from './languageServerExecutable';
import type { Reporter } from './reporting';

interface Group extends LanguageGroup {
    folder: vscode.WorkspaceFolder;
    documents: { uri: string; path: string }[];
    allDocuments: { path: string }[];
    resolvePaths(): Promise<ResolvedDocumentPaths>;
}

function globLiteral(value: string): string {
    return value.replace(/[?*[\]{}]/g, (character) => `[${character}]`);
}

/** VS Code 事件、文档和进程适配；会话调度规则集中在 LanguageSessions。 */
export class LanguageClients {
    private readonly sessions: LanguageSessions<Group>;
    private readonly subscriptions: vscode.Disposable[];
    private readonly diagnostics = new Set<LanguageDiagnostics<vscode.Uri, vscode.Diagnostic>>();
    private readonly paths = new Map<string, LanguagePaths>();

    constructor(private readonly reporter: Reporter) {
        this.sessions = new LanguageSessions({ groups: () => this.groups(), start: (group) => this.start(group), report: (error) => reporter.report(error), changed: () => { for (const diagnostics of this.diagnostics) diagnostics.refresh(); } });
        this.subscriptions = [
            vscode.workspace.onDidOpenTextDocument(() => this.sessions.schedule()),
            vscode.workspace.onDidCloseTextDocument(() => this.sessions.schedule()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.sessions.schedule(true)),
            vscode.workspace.onDidGrantWorkspaceTrust(() => this.sessions.schedule(true)),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('teal')) { reporter.reset(); this.sessions.schedule(true); }
            }),
        ];
    }

    private groups(): Group[] {
        if (!isSupported() || !vscode.workspace.isTrusted) return [];
        const allDocuments = vscode.workspace.textDocuments.filter(isLocalTealDocument).map(document => ({ path: document.uri.fsPath }));
        let pathSnapshot: Promise<ResolvedDocumentPaths> | undefined;
        const resolvePaths = () => pathSnapshot ??= resolveDocumentPaths(allDocuments);
        const groups = new Map<string, Group>();
        for (const document of vscode.workspace.textDocuments) {
            if (!isLocalTealDocument(document)) continue;
            const parent = vscode.Uri.file(path.dirname(document.uri.fsPath));
            const folder = vscode.workspace.getWorkspaceFolder(document.uri) ?? { uri: parent, name: path.basename(parent.fsPath), index: 0 };
            const key = folder.uri.toString();
            const group = groups.get(key) ?? { key, root: folder.uri.fsPath, folder, documents: [], allDocuments, resolvePaths };
            group.documents.push({ uri: document.uri.toString(), path: document.uri.fsPath });
            groups.set(key, group);
        }
        return [...groups.values()];
    }

    private async start(group: Group): Promise<LanguageSession> {
        const config = vscode.workspace.getConfiguration('teal', group.folder.uri);
        const entryFiles = stringArray(config.get('lsp.entryFiles', []), 'teal.lsp.entryFiles').map((file) => path.resolve(group.root, file));
        const sourceCommand = await executable('teal', group.folder.uri);
        const command = await stageLanguageServerExecutable(sourceCommand);
        const diagnostics = new LanguageDiagnostics<vscode.Uri, vscode.Diagnostic>(group.key, file => this.sessions.owner(file));
        let clientPaths: LanguagePaths | undefined;
        let client: LanguageClient | undefined;
        let started = false;
        let stopping = false;
        const subscriptions: vscode.Disposable[] = [];
        const dispose = async () => {
            stopping = true;
            this.diagnostics.delete(diagnostics);
            diagnostics.dispose();
            if (clientPaths && this.paths.get(group.key) === clientPaths) this.paths.delete(group.key);
            const failures: unknown[] = [];
            for (const subscription of subscriptions.splice(0)) {
                try { subscription.dispose(); }
                catch (error) { failures.push(error); }
            }
            try { await client?.dispose(); }
            catch (error) { failures.push(error); }
            finally { await releaseLanguageServerExecutable(command); }
            if (failures.length) throw new AggregateError(failures, 'Language server cleanup failed.');
        };
        // 复制后的环境、客户端和监听器初始化也可能失败，统一纳入清理范围。
        try {
            const environment = await languageServerEnvironment(sourceCommand);
            // 跨工作区结果也优先复用已打开的缓冲区；本会话文档优先于其他别名。
            const paths = await LanguagePaths.create(group.root, [
                ...group.documents,
                ...group.allDocuments,
            ], await group.resolvePaths());
            clientPaths = paths;
            this.paths.set(group.key, paths);
            const activePaths = (file: string) => this.paths.get(this.sessions.owner(file) ?? group.key) ?? paths;
            const mapUri = (uri: vscode.Uri, map: (file: string) => string): vscode.Uri => {
                if (uri.scheme !== 'file') return uri;
                const file = map(uri.fsPath);
                return file === uri.fsPath ? uri : vscode.Uri.file(file).with({ query: uri.query, fragment: uri.fragment });
            };
            this.diagnostics.add(diagnostics);
            const options: LanguageClientOptions = {
                documentSelector: group.documents.map((document) => ({ language: 'teal', scheme: 'file', pattern: globLiteral(document.path.replace(/\\/g, '/')) })),
                workspaceFolder: group.folder,
                uriConverters: {
                    code2Protocol: uri => mapUri(uri, file => paths.toCanonical(file)).toString(),
                    protocol2Code: value => mapUri(vscode.Uri.parse(value), file => activePaths(file).toEditor(file)),
                },
                initializationOptions: { entryFiles },
                outputChannel: this.reporter.output,
                traceOutputChannel: this.reporter.output,
                errorHandler: { error: () => ({ action: ErrorAction.Shutdown }), closed: () => ({ action: CloseAction.DoNotRestart }) },
                middleware: {
                    handleDiagnostics: (uri, items, next) => diagnostics.update(uri, activePaths(uri.fsPath).toCanonical(uri.fsPath), items, next),
                    provideWorkspaceSymbols: async (query, token, next) => {
                        const symbols = await next(query, token);
                        return symbols?.filter((symbol) => this.sessions.owner(activePaths(symbol.location.uri.fsPath).toCanonical(symbol.location.uri.fsPath)) === group.key);
                    },
                },
            };
            const active = new LanguageClient('teal', `Teal (${group.folder.name})`, { command, args: ['lsp'], options: { cwd: group.root, env: environment } }, options);
            client = active;
            subscriptions.push(active.onDidChangeState((event) => {
                if (event.newState === State.Stopped && started && !stopping) {
                    this.reporter.report(new Error(`Language server stopped for ${group.folder.name}. Run teal.restartServer to retry.`));
                }
            }));
            const fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(group.folder, '**/*.tl'));
            subscriptions.push(fileWatcher);
            const changed = (uri: vscode.Uri) => this.sessions.diskChanged({ uri: uri.toString(), path: uri.fsPath });
            subscriptions.push(fileWatcher.onDidCreate(changed), fileWatcher.onDidDelete(changed), fileWatcher.onDidChange(changed));
            const session: LanguageSession = {
                isRunning: () => active.state === State.Running,
                dispose,
            };
            this.reporter.output.appendLine(`[LSP] Starting ${command} in ${group.root}`);
            await active.start();
            started = true;
            return session;
        } catch (error) {
            try { await dispose(); }
            catch (cleanup) { throw new AggregateError([error, cleanup], `Language server startup failed: ${String(error)}; cleanup also failed.`, { cause: cleanup }); }
            throw error;
        }
    }

    refresh(force = false): Promise<void> { return this.sessions.refresh(force); }

    refreshScopes(keys: readonly string[], force = false): Promise<void> { return this.sessions.refreshScopes(keys, force); }

    async dispose(): Promise<void> {
        for (const subscription of this.subscriptions) subscription.dispose();
        await this.sessions.dispose();
    }
}
