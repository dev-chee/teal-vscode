import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { isLocalTealDocument } from './documents';
import { isSupported } from './environment';
import { currentManagedToolchainTarget, installManagedToolchain, loadManagedToolchain, updateManagedToolchain, type ManagedToolchainStorage } from './managedToolchain';
import { isCompleteToolchain, resolveToolchain } from './toolchain';
import { ToolchainUpdates } from './toolchainUpdates';

export function toolchainRelease(resource?: vscode.Uri): string {
    const value = vscode.workspace.getConfiguration('teal', resource).get<string>('toolchain.release', 'latest').trim();
    return !value || value.toLowerCase() === 'latest' ? 'latest' : value;
}

/** 每个文件夹独立调度；相同版本共享安装，不同固定标签不会互相替换选择。 */
export class WorkspaceToolchains {
    private readonly entries = new Map<string, { resource: vscode.Uri | undefined; updates: ToolchainUpdates }>();
    private readonly directories = new Map<string, Promise<string | undefined>>();
    private started = false;
    private stopped = false;

    constructor(
        private readonly context: ManagedToolchainStorage,
        private readonly refresh: (force: boolean) => Promise<void>,
        private readonly log: (message: string) => void,
    ) {}

    private storage(release: string): ManagedToolchainStorage {
        if (release === 'latest') return this.context;
        const key = createHash('sha256').update(release).digest('hex');
        return { globalStorageUri: vscode.Uri.joinPath(this.context.globalStorageUri, 'toolchain-releases', key) };
    }

    private load(release: string): Promise<string | undefined> {
        let directory = this.directories.get(release);
        if (!directory) {
            directory = loadManagedToolchain(this.storage(release), release).then(value =>
                value ?? (release === 'latest' ? undefined : loadManagedToolchain(this.context, release)));
            this.directories.set(release, directory);
        }
        return directory;
    }

    private async select(directory: string, release: string): Promise<void> {
        const previous = await this.load(release);
        if (previous === directory) return;
        this.directories.set(release, Promise.resolve(directory));
        this.log(`[Toolchain] Selected ${release}: ${directory}`);
        await this.refresh(previous !== undefined);
    }

    private entry(resource?: vscode.Uri): ToolchainUpdates {
        const key = resource?.toString() ?? '';
        let entry = this.entries.get(key);
        if (!entry) {
            const updates = new ToolchainUpdates({
                settings: async () => {
                    const config = vscode.workspace.getConfiguration('teal', resource);
                    const configured = config.get<string>('toolchain.path', '').trim();
                    const fromPath = configured ? undefined : await resolveToolchain('').catch(() => undefined);
                    const release = toolchainRelease(resource);
                    if (!configured && !isCompleteToolchain(fromPath)) await this.load(release);
                    return { trusted: vscode.workspace.isTrusted, supported: isSupported() && !!currentManagedToolchainTarget(),
                        autoUpdate: config.get<boolean>('toolchain.autoUpdate', true), release,
                        local: !!configured || isCompleteToolchain(fromPath) };
                },
                install: async (release, options) => {
                    const target = currentManagedToolchainTarget();
                    return target ? (await updateManagedToolchain(this.storage(release), release, target, options))?.directory : undefined;
                },
                apply: (directory, release) => this.select(directory, release),
                log: error => this.log(`[Toolchain update] ${String(error)}`),
            });
            entry = { resource, updates };
            this.entries.set(key, entry);
            if (this.started && !this.stopped) updates.start();
        }
        return entry.updates;
    }

    private resources(): Array<vscode.Uri | undefined> {
        const resources: Array<vscode.Uri | undefined> = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri);
        if (!resources.length || vscode.workspace.textDocuments.some(document => isLocalTealDocument(document) && !vscode.workspace.getWorkspaceFolder(document.uri))) resources.push(undefined);
        return resources;
    }

    start(): void {
        this.started = true;
        for (const resource of this.resources()) this.entry(resource);
    }

    async directory(resource?: vscode.Uri): Promise<string | undefined> {
        const scope = resource ? vscode.workspace.getWorkspaceFolder(resource)?.uri : undefined;
        const updates = this.entry(scope);
        for (;;) {
            const release = toolchainRelease(scope);
            let directory = await this.load(release);
            if (!directory) {
                await updates.ready();
                directory = await this.load(release);
            }
            if (release === toolchainRelease(scope)) return directory;
        }
    }

    async check(): Promise<void> {
        await Promise.all(this.resources().map(resource => this.entry(resource).check(true)));
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

    async configurationChanged(event?: vscode.ConfigurationChangeEvent): Promise<void> {
        if (this.stopped) return;
        const resources = this.resources();
        const keys = new Set(resources.map(resource => resource?.toString() ?? ''));
        const pending: Promise<unknown>[] = [];
        for (const [key, entry] of this.entries) {
            if (!keys.has(key)) {
                this.entries.delete(key);
                pending.push(entry.updates.dispose());
            } else if (!event || event.affectsConfiguration('teal.toolchain', entry.resource)) pending.push(entry.updates.configurationChanged());
        }
        for (const resource of resources) this.entry(resource);
        await Promise.all(pending);
    }

    async dispose(): Promise<void> {
        this.stopped = true;
        await Promise.all([...this.entries.values()].map(entry => entry.updates.dispose()));
        this.entries.clear();
    }
}
