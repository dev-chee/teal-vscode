import * as path from 'node:path';
import * as vscode from 'vscode';
import { CloseAction, ErrorAction, LanguageClient, State, type LanguageClientOptions } from 'vscode-languageclient/node';
import { stringArray } from './configuration';
import { isLocalTealDocument } from './documents';
import { executable, isSupported } from './environment';
import { LanguageSessions, type LanguageGroup, type LanguageSession } from './languageSessions';
import { languageServerEnvironment, releaseLanguageServerExecutable, stageLanguageServerExecutable } from './languageServerExecutable';
import type { Reporter } from './reporting';

interface Group extends LanguageGroup {
    folder: vscode.WorkspaceFolder;
    documents: { uri: string; path: string }[];
}

function globLiteral(value: string): string {
    return value.replace(/[?*[\]{}]/g, (character) => `[${character}]`);
}

/** VS Code 事件、文档和进程适配；会话调度规则集中在 LanguageSessions。 */
export class LanguageClients {
    private readonly sessions: LanguageSessions<Group>;
    private readonly subscriptions: vscode.Disposable[];

    constructor(private readonly reporter: Reporter) {
        this.sessions = new LanguageSessions({ groups: () => this.groups(), start: (group) => this.start(group), report: (error) => reporter.report(error) });
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
        const groups = new Map<string, Group>();
        for (const document of vscode.workspace.textDocuments) {
            if (!isLocalTealDocument(document)) continue;
            const parent = vscode.Uri.file(path.dirname(document.uri.fsPath));
            const folder = vscode.workspace.getWorkspaceFolder(document.uri) ?? { uri: parent, name: path.basename(parent.fsPath), index: 0 };
            const key = folder.uri.toString();
            const group = groups.get(key) ?? { key, root: folder.uri.fsPath, folder, documents: [] };
            group.documents.push({ uri: document.uri.toString(), path: document.uri.fsPath });
            groups.set(key, group);
        }
        return [...groups.values()];
    }

    private async start(group: Group): Promise<LanguageSession> {
        const config = vscode.workspace.getConfiguration('teal', group.folder.uri);
        const entryFiles = stringArray(config.get('lsp.entryFiles', []), 'teal.lsp.entryFiles').map((file) => path.resolve(group.root, file));
        const sourceCommand = await executable('teal-lsp', group.folder.uri);
        const command = await stageLanguageServerExecutable(sourceCommand);
        let client: LanguageClient | undefined;
        let started = false;
        let stopping = false;
        const subscriptions: vscode.Disposable[] = [];
        const dispose = async () => {
            stopping = true;
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
            const options: LanguageClientOptions = {
                documentSelector: group.documents.map((document) => ({ language: 'teal', scheme: 'file', pattern: globLiteral(document.path.replace(/\\/g, '/')) })),
                workspaceFolder: group.folder,
                initializationOptions: { entryFiles },
                outputChannel: this.reporter.output,
                traceOutputChannel: this.reporter.output,
                errorHandler: { error: () => ({ action: ErrorAction.Shutdown }), closed: () => ({ action: CloseAction.DoNotRestart }) },
                middleware: {
                    provideWorkspaceSymbols: async (query, token, next) => {
                        const symbols = await next(query, token);
                        return symbols?.filter((symbol) => this.sessions.owner(symbol.location.uri.fsPath) === group.key);
                    },
                },
            };
            const active = new LanguageClient('teal', `Teal (${group.folder.name})`, { command, args: [], options: { cwd: group.root, env: environment } }, options);
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

    async dispose(): Promise<void> {
        for (const subscription of this.subscriptions) subscription.dispose();
        await this.sessions.dispose();
    }
}
