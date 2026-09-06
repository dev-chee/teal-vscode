import * as path from 'node:path';
import * as vscode from 'vscode';
import { CloseAction, ErrorAction, LanguageClient, State, type LanguageClientOptions } from 'vscode-languageclient/node';
import { executable, isSupported, Reporter, stringArray } from './environment';

interface Group {
    folder: vscode.WorkspaceFolder;
    documents: vscode.TextDocument[];
}

interface Session {
    client: LanguageClient;
    signature: string;
    subscription: vscode.Disposable;
    watcher: vscode.Disposable;
}

function globLiteral(value: string): string {
    return value.replace(/[?*[\]{}]/g, (character) => `[${character}]`);
}

/** 以串行队列管理启动/停止，避免设置、文件事件与停用互相抢占子进程。 */
export class LanguageClients {
    private readonly sessions = new Map<string, Session>();
    private readonly subscriptions: vscode.Disposable[] = [];
    private queue: Promise<void> = Promise.resolve();
    private timer: NodeJS.Timeout | undefined;
    private readonly dirtyRoots = new Set<string>();
    private stopping = false;

    constructor(private readonly reporter: Reporter) {
        this.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(() => this.schedule()),
            vscode.workspace.onDidCloseTextDocument(() => this.schedule()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule(true)),
            vscode.workspace.onDidGrantWorkspaceTrust(() => this.schedule(true)),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('teal')) {
                    this.reporter.reset();
                    this.schedule(true);
                }
            }),
        );
    }

    private groups(): Map<string, Group> {
        const result = new Map<string, Group>();
        for (const document of vscode.workspace.textDocuments) {
            if (document.languageId !== 'teal' || document.uri.scheme !== 'file' || document.isClosed) continue;
            const parent = vscode.Uri.file(path.dirname(document.uri.fsPath));
            const folder = vscode.workspace.getWorkspaceFolder(document.uri)
                ?? { uri: parent, name: path.basename(parent.fsPath), index: 0 };
            const key = folder.uri.toString();
            const group = result.get(key) ?? { folder, documents: [] };
            group.documents.push(document);
            result.set(key, group);
        }
        return result;
    }

    private diskChanged(uri: vscode.Uri): void {
        // 打开的文件由 didChange 维护；保存本身不需要重启。
        if (vscode.workspace.textDocuments.some((doc) => doc.uri.toString() === uri.toString() && !doc.isClosed)) return;
        for (const [key, group] of this.groups()) {
            const relative = path.relative(group.folder.uri.fsPath, uri.fsPath);
            if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
                this.dirtyRoots.add(key);
            }
        }
        this.schedule();
    }

    private symbolOwner(uri: vscode.Uri): string | undefined {
        let owner: string | undefined;
        let length = -1;
        for (const [key, session] of this.sessions) {
            if (session.client.state !== State.Running) continue;
            const root = vscode.Uri.parse(key).fsPath;
            const relative = path.relative(root, uri.fsPath);
            if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && root.length > length) {
                owner = key;
                length = root.length;
            }
        }
        return owner;
    }

    private schedule(force = false): void {
        if (this.stopping) return;
        if (force) for (const key of this.sessions.keys()) this.dirtyRoots.add(key);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.refresh().catch((error: unknown) => this.reporter.report(error)); }, 400);
    }

    refresh(force = false): Promise<void> {
        const operation = this.queue.then(() => this.reconcile(force));
        this.queue = operation.catch(() => {});
        return operation;
    }

    private async stop(key: string, session: Session): Promise<void> {
        this.sessions.delete(key);
        session.subscription.dispose();
        session.watcher.dispose();
        await session.client.dispose();
    }

    private async reconcile(force: boolean): Promise<void> {
        const groups = this.stopping || !isSupported() || !vscode.workspace.isTrusted ? new Map<string, Group>() : this.groups();
        for (const [key, session] of this.sessions) {
            const group = groups.get(key);
            const signature = group?.documents.map((doc) => doc.uri.toString()).sort().join('\n');
            if (!group || force || this.dirtyRoots.has(key) || session.signature !== signature) await this.stop(key, session);
        }
        this.dirtyRoots.clear();
        for (const [key, group] of groups) {
            if (this.sessions.has(key) || this.stopping) continue;
            try {
                const command = await executable('teal-lsp', group.folder.uri);
                const config = vscode.workspace.getConfiguration('teal', group.folder.uri);
                const entryFiles = stringArray(config.get('lsp.entryFiles', []), 'teal.lsp.entryFiles')
                    .map((file) => path.resolve(group.folder.uri.fsPath, file));
                // 精确选择当前文档，嵌套工作区不会被两个服务器同时认领。
                const documentSelector = group.documents.map((doc) => ({
                    language: 'teal', scheme: 'file',
                    pattern: globLiteral(doc.uri.fsPath.replace(/\\/g, '/')),
                }));
                const options: LanguageClientOptions = {
                    documentSelector,
                    workspaceFolder: group.folder,
                    initializationOptions: { entryFiles },
                    outputChannel: this.reporter.output,
                    traceOutputChannel: this.reporter.output,
                    errorHandler: {
                        error: () => ({ action: ErrorAction.Shutdown }),
                        closed: () => ({ action: CloseAction.DoNotRestart }),
                    },
                    middleware: {
                        // 父根的磁盘扫描包含子根；工作区搜索只保留最具体的活动根结果。
                        provideWorkspaceSymbols: async (query, token, next) => {
                            const symbols = await next(query, token);
                            return symbols?.filter((symbol) => this.symbolOwner(symbol.location.uri) === key);
                        },
                    },
                };
                const client = new LanguageClient('teal', `Teal (${group.folder.name})`, {
                    command, args: [], options: { cwd: group.folder.uri.fsPath },
                }, options);
                const subscription = client.onDidChangeState((event) => {
                    if (event.newState === State.Stopped && !this.stopping && this.sessions.get(key)?.client === client) {
                        this.reporter.report(new Error(`Language server stopped for ${group.folder.name}. Run teal.restartServer to retry.`));
                    }
                });
                // 显式监视每个根，也覆盖工作区外文件；服务器只在初始化扫描磁盘。
                const fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(group.folder, '**/*.tl'));
                const watcher = vscode.Disposable.from(fileWatcher,
                    fileWatcher.onDidCreate((uri) => this.diskChanged(uri)),
                    fileWatcher.onDidDelete((uri) => this.diskChanged(uri)),
                    fileWatcher.onDidChange((uri) => this.diskChanged(uri)),
                );
                const session = { client, subscription, watcher, signature: group.documents.map((doc) => doc.uri.toString()).sort().join('\n') };
                this.sessions.set(key, session);
                this.reporter.output.appendLine(`[LSP] Starting ${command} in ${group.folder.uri.fsPath}`);
                try { await client.start(); }
                catch (error) { await this.stop(key, session); throw error; }
            } catch (error) { this.reporter.report(error); }
        }
    }

    async dispose(): Promise<void> {
        this.stopping = true;
        if (this.timer) clearTimeout(this.timer);
        for (const subscription of this.subscriptions) subscription.dispose();
        await this.refresh();
    }
}
