import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isLocalTealDocument } from './documents';
import { isSupported } from './environment';
import { currentManagedToolchainTarget, installManagedToolchain, loadManagedToolchain, updateManagedToolchain, type ManagedToolchainStorage } from './managedToolchain';
import { isCompleteToolchain, resolveToolchain } from './toolchain';
import { ToolchainUpdates, type UpdateSettings } from './toolchainUpdates';

export function toolchainRelease(resource?: vscode.Uri): string {
    const value = vscode.workspace.getConfiguration('teal', resource).get<string>('toolchain.release', 'latest').trim();
    return !value || value.toLowerCase() === 'latest' ? 'latest' : value;
}

interface Entry {
    resource: vscode.Uri | undefined;
    updates: ToolchainUpdates;
    bootstrap?: Promise<void>;
}

/** 文件夹独立调度，版本独立缓存；进程激活失败时恢复本窗口的旧选择。 */
export class WorkspaceToolchains {
    private readonly entries = new Map<string, Entry>();
    private readonly directories = new Map<string, Promise<string | undefined>>();
    private readonly applied = new Map<string, string>();
    private readonly blocked = new Set<string>();
    private queue: Promise<void> = Promise.resolve();
    private pathToolchain: Promise<Awaited<ReturnType<typeof resolveToolchain>> | undefined> | undefined;
    private documentRefresh: Promise<void> | undefined;
    private documentRefreshQueued = false;
    private started = false;
    private stopped = false;

    constructor(
        private readonly context: ManagedToolchainStorage,
        private readonly refresh: (force: boolean, keys: readonly string[]) => Promise<void>,
        private readonly log: (message: string) => void,
    ) {}

    private storage(release: string): ManagedToolchainStorage {
        if (release === 'latest') return this.context;
        const key = createHash('sha256').update(release).digest('hex');
        return { globalStorageUri: vscode.Uri.joinPath(this.context.globalStorageUri, 'toolchain-releases', key) };
    }

    private async cached(release: string, excluded: readonly string[] = []): Promise<string | undefined> {
        return await loadManagedToolchain(this.storage(release), release, excluded)
            ?? (release === 'latest' ? undefined : await loadManagedToolchain(this.context, release, excluded));
    }

    private load(release: string): Promise<string | undefined> {
        let directory = this.directories.get(release);
        if (!directory) {
            directory = this.cached(release);
            this.directories.set(release, directory);
        }
        return directory;
    }

    /** PATH 属于扩展宿主进程；文档或文件夹事件不会改变它。 */
    private localPathToolchain(): Promise<Awaited<ReturnType<typeof resolveToolchain>> | undefined> {
        return this.pathToolchain ??= resolveToolchain('').catch(() => undefined);
    }

    private async settings(resource?: vscode.Uri): Promise<UpdateSettings> {
        const config = vscode.workspace.getConfiguration('teal', resource);
        const configured = config.get<string>('toolchain.path', '').trim();
        const fromPath = configured ? undefined : await this.localPathToolchain();
        const release = toolchainRelease(resource);
        if (!configured && !isCompleteToolchain(fromPath)) await this.load(release);
        return { trusted: vscode.workspace.isTrusted, supported: isSupported() && !!currentManagedToolchainTarget(),
            autoUpdate: config.get<boolean>('toolchain.autoUpdate', true), release,
            local: !!configured || isCompleteToolchain(fromPath) };
    }

    /** 与 LanguageClients 的分组键一致；本地路径及其他固定版本不参与此次切换。 */
    private async affectedKeys(release: string): Promise<string[]> {
        const resources = new Map<string, vscode.Uri | undefined>();
        const candidates: Array<{ key: string; scope: string }> = [];
        for (const document of vscode.workspace.textDocuments) {
            if (!isLocalTealDocument(document)) continue;
            const folder = vscode.workspace.getWorkspaceFolder(document.uri);
            const resource = folder?.uri;
            const scope = resource?.toString() ?? '';
            resources.set(scope, resource);
            candidates.push({
                key: (resource ?? vscode.Uri.file(path.dirname(document.uri.fsPath))).toString(),
                scope,
            });
        }
        const settings = new Map(await Promise.all([...resources].map(async ([scope, resource]) => [scope, await this.settings(resource)] as const)));
        const keys = new Set<string>();
        for (const candidate of candidates) {
            const current = settings.get(candidate.scope)!;
            if (current.release === release && !current.local) {
                keys.add(candidate.key);
            }
        }
        return [...keys].sort();
    }

    private select(directory: string, release: string, onlyCurrent = false): Promise<void> {
        const operation = this.queue.then(async () => {
            if (this.stopped) return;
            const keys = await this.affectedKeys(release);
            const signature = JSON.stringify(keys);
            const previous = await this.load(release);
            // 文档事件可能排在更新之后，不能用事件开始时读取的旧目录覆盖新选择。
            if (onlyCurrent && previous && previous !== directory) return;
            if (previous === directory && this.applied.get(release) === signature) return;
            this.blocked.delete(release);
            this.directories.set(release, Promise.resolve(directory));
            try {
                // 新加入此版本的根可能仍运行其他工具链，必须确认所有目标根已切换。
                await this.refresh(true, keys);
                if (this.stopped || signature !== JSON.stringify(await this.affectedKeys(release))) return;
                this.applied.set(release, signature);
                this.log(`[Toolchain] Selected ${release}: ${directory}`);
            } catch (error) {
                this.applied.delete(release);
                if (this.stopped || signature !== JSON.stringify(await this.affectedKeys(release))) throw error;
                const fallback = previous && previous !== directory ? previous : await this.cached(release, [directory]);
                this.directories.set(release, Promise.resolve(fallback));
                if (!fallback) this.blocked.add(release);
                if (fallback) {
                    try {
                        await this.refresh(true, keys);
                        this.applied.set(release, signature);
                        this.log(`[Toolchain] Restored ${release}: ${fallback}`);
                    } catch (restore) {
                        throw new AggregateError([error, restore], `Toolchain activation failed: ${String(error)}; restoring the previous language server also failed.`, { cause: restore });
                    }
                }
                // 下载成功不等于进程可用；保持旧选择，使下一次检查能重试候选目录。
                throw error;
            }
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    private async bootstrap(resource?: vscode.Uri): Promise<void> {
        try {
            const settings = await this.settings(resource);
            if (this.stopped || !settings.trusted || !settings.supported || settings.local) return;
            const directory = await this.load(settings.release);
            if (directory && settings.release === toolchainRelease(resource)) await this.select(directory, settings.release, true);
        } catch (error) { this.log(`[Toolchain activation] ${String(error)}`); }
    }

    private entryRecord(resource?: vscode.Uri): Entry {
        const key = resource?.toString() ?? '';
        let entry = this.entries.get(key);
        if (!entry) {
            const updates = new ToolchainUpdates({
                settings: () => this.settings(resource),
                install: async (release, options) => {
                    const target = currentManagedToolchainTarget();
                    return target ? (await updateManagedToolchain(this.storage(release), release, target, options))?.directory : undefined;
                },
                apply: (directory, release) => this.select(directory, release),
                log: error => this.log(`[Toolchain update] ${String(error)}`),
            });
            entry = { resource, updates };
            this.entries.set(key, entry);
        }
        if (this.started && !this.stopped && !entry.bootstrap) {
            entry.bootstrap = this.bootstrap(resource);
            entry.updates.start();
        }
        return entry;
    }

    private entry(resource?: vscode.Uri): ToolchainUpdates {
        return this.entryRecord(resource).updates;
    }

    private resources(): Array<vscode.Uri | undefined> {
        const resources: Array<vscode.Uri | undefined> = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri);
        if (!resources.length || vscode.workspace.textDocuments.some(document => isLocalTealDocument(document) && !vscode.workspace.getWorkspaceFolder(document.uri))) resources.push(undefined);
        return resources;
    }

    async start(): Promise<void> {
        this.started = true;
        for (const resource of this.resources()) this.entryRecord(resource);
        await Promise.all([...this.entries.values()].map(entry => entry.bootstrap));
    }

    async directory(resource?: vscode.Uri): Promise<string | undefined> {
        if (this.stopped) return undefined;
        const scope = resource ? vscode.workspace.getWorkspaceFolder(resource)?.uri : undefined;
        const updates = this.entry(scope);
        for (;;) {
            const release = toolchainRelease(scope);
            let directory = await this.load(release);
            if (!directory && !this.blocked.has(release)) {
                // 空缓存不能永久记忆：另一个窗口可能刚安装了同一个固定版本。
                directory = await this.cached(release);
                if (directory) {
                    const selected = directory;
                    void this.select(selected, release, true).catch(error => this.log(`[Toolchain activation] ${String(error)}`));
                } else directory = await updates.preparedDirectory(release);
            }
            if (release === toolchainRelease(scope)) return directory;
        }
    }

    async check(): Promise<void> {
        const results = await Promise.allSettled(this.resources().map(resource => this.entry(resource).check(true)));
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as unknown);
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, 'Some workspace toolchain updates failed.');
    }

    async install(resource: vscode.Uri | undefined, report: (message: string) => void): Promise<{ release: string; target: string }> {
        const release = toolchainRelease(resource);
        const target = currentManagedToolchainTarget();
        if (!target) throw new Error('No managed Teal toolchain matches this host architecture and ABI. Configure teal.toolchain.path manually.');
        await this.load(release);
        const installed = await installManagedToolchain(this.storage(release), release, target, report, { canCommit: async () =>
            !this.stopped && vscode.workspace.isTrusted && toolchainRelease(resource) === release });
        await this.select(installed.directory, release);
        return installed;
    }

    private async refreshDocumentResources(): Promise<void> {
        const resources = this.resources();
        const bootstraps: Promise<void>[] = [];
        for (const resource of resources) {
            const entry = this.entryRecord(resource);
            if (entry.bootstrap) bootstraps.push(entry.bootstrap);
        }
        await Promise.all(bootstraps);
    }

    async documentsChanged(): Promise<void> {
        this.documentRefreshQueued = true;
        if (!this.documentRefresh) {
            const refresh = (async () => {
                while (this.documentRefreshQueued && !this.stopped) {
                    this.documentRefreshQueued = false;
                    await this.refreshDocumentResources();
                }
            })();
            this.documentRefresh = refresh;
            void refresh.then(() => {
                if (this.documentRefresh === refresh) this.documentRefresh = undefined;
            }, () => {
                if (this.documentRefresh === refresh) this.documentRefresh = undefined;
            });
        }
        await this.documentRefresh;
    }

    async configurationChanged(event?: vscode.ConfigurationChangeEvent): Promise<void> {
        if (this.stopped) return;
        const resources = this.resources();
        const keys = new Set(resources.map(resource => resource?.toString() ?? ''));
        const pending: Promise<unknown>[] = [];
        for (const [key, entry] of this.entries) {
            if (!keys.has(key)) {
                this.entries.delete(key);
                pending.push(entry.updates.dispose());
            } else if (!event || event.affectsConfiguration('teal.toolchain', entry.resource)) {
                pending.push(entry.updates.configurationChanged(), this.bootstrap(entry.resource));
            }
        }
        for (const resource of resources) this.entry(resource);
        await Promise.all(pending);
    }

    async dispose(): Promise<void> {
        this.stopped = true;
        await this.documentRefresh?.catch(() => {});
        await Promise.all([...this.entries.values()].map(entry => entry.updates.dispose()));
        await this.queue;
        this.entries.clear();
    }
}
