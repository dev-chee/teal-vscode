import * as path from 'node:path';
import * as vscode from 'vscode';
import { CloseAction, ErrorAction, LanguageClient, State, type LanguageClientOptions } from 'vscode-languageclient/node';
import { stringArray } from './configuration';
import { isLocalTealDocument } from './documents';
import { executable, isSupported } from './environment';
import { LanguageSessions, type LanguageGroup, type LanguageSession } from './languageSessions';
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
        const command = await executable('teal-lsp', group.folder.uri);
        const config = vscode.workspace.getConfiguration('teal', group.folder.uri);
        const entryFiles = stringArray(config.get('lsp.entryFiles', []), 'teal.lsp.entryFiles').map((file) => path.resolve(group.root, file));
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
        const client = new LanguageClient('teal', `Teal (${group.folder.name})`, { command, args: [], options: { cwd: group.root } }, options);
        let started = false;
        let stopping = false;
        const subscription = client.onDidChangeState((event) => {
            if (event.newState === State.Stopped && started && !stopping) {
                this.reporter.report(new Error(`Language server stopped for ${group.folder.name}. Run teal.restartServer to retry.`));
            }
        });
        const fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(group.folder, '**/*.tl'));
        const changed = (uri: vscode.Uri) => this.sessions.diskChanged({ uri: uri.toString(), path: uri.fsPath });
        const watcher = vscode.Disposable.from(fileWatcher, fileWatcher.onDidCreate(changed), fileWatcher.onDidDelete(changed), fileWatcher.onDidChange(changed));
        const session: LanguageSession = {
            isRunning: () => client.state === State.Running,
            dispose: async () => { stopping = true; subscription.dispose(); watcher.dispose(); await client.dispose(); },
        };
        this.reporter.output.appendLine(`[LSP] Starting ${command} in ${group.root}`);
        try { await client.start(); started = true; return session; }
        catch (error) { await session.dispose(); throw error; }
    }

    refresh(force = false): Promise<void> { return this.sessions.refresh(force); }

    async dispose(): Promise<void> {
        for (const subscription of this.subscriptions) subscription.dispose();
        await this.sessions.dispose();
    }
}
