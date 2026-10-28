import { realpath } from 'node:fs/promises';
import { isWithinRoot } from './platform';

export interface LanguageGroup {
    key: string;
    root: string;
    documents: readonly { uri: string; path: string }[];
}

export interface LanguageSession {
    isRunning(): boolean;
    dispose(): Promise<void>;
}

export interface LanguageSessionHost<Group extends LanguageGroup> {
    groups(): readonly Group[];
    start(group: Group): Promise<LanguageSession>;
    report(error: unknown): void;
    changed?(): void;
}

/** 串行管理会话和刷新事件；编辑器事件与实际进程由宿主提供。 */
export class LanguageSessions<Group extends LanguageGroup> {
    private readonly sessions = new Map<string, { group: Group; root: string; signature: string; session: LanguageSession }>();
    private readonly dirtyRoots = new Set<string>();
    private queue: Promise<void> = Promise.resolve();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private forcePending = false;
    private stopping = false;

    constructor(private readonly host: LanguageSessionHost<Group>) {}

    diskChanged(file: { uri: string; path: string }): void {
        if (this.stopping) return;
        for (const group of this.host.groups()) {
            if (!group.documents.some((document) => document.uri === file.uri) && isWithinRoot(group.root, file.path)) {
                this.dirtyRoots.add(group.key);
            }
        }
        if (this.dirtyRoots.size) this.schedule();
    }

    owner(file: string): string | undefined {
        let owner: { key: string; length: number } | undefined;
        for (const { group, root, session } of this.sessions.values()) {
            if (!session.isRunning()) continue;
            // 只比较实际包含输入路径的根；链接目标长度不能决定编辑器别名的层级。
            const canonicalLength = isWithinRoot(root, file) ? root.length : -1;
            const editorLength = group.root === root ? canonicalLength : isWithinRoot(group.root, file) ? group.root.length : -1;
            const length = Math.max(canonicalLength, editorLength);
            if (length >= 0 && (!owner || length > owner.length)) {
                owner = { key: group.key, length };
            }
        }
        return owner?.key;
    }

    schedule(force = false): void {
        if (this.stopping) return;
        // 全量刷新也覆盖正在启动、尚未登记到 sessions 的会话。
        this.forcePending ||= force;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh().catch((error: unknown) => this.host.report(error)); }, 400);
    }

    refresh(force = false): Promise<void> {
        return this.enqueue(force);
    }

    /** 工具链切换只刷新受影响的根；启动错误必须返回给更新器以恢复旧选择。 */
    refreshScopes(keys: readonly string[], force = false): Promise<void> {
        return this.enqueue(force, new Set(keys), true);
    }

    private enqueue(force: boolean, keys?: ReadonlySet<string>, strict = false): Promise<void> {
        const operation = this.queue.then(() => this.reconcile(force, keys, strict)).finally(() => this.host.changed?.());
        this.queue = operation.catch(() => {});
        return operation;
    }

    private async stop(key: string, session: LanguageSession): Promise<void> {
        const current = this.sessions.get(key);
        this.sessions.delete(key);
        try { await session.dispose(); }
        catch (error) {
            // 停止失败时保留句柄供重试，不能同时启动同根的第二个进程。
            if (current) this.sessions.set(key, current);
            this.dirtyRoots.add(key);
            throw error;
        }
    }

    private async reconcile(force: boolean, keys?: ReadonlySet<string>, strict = false): Promise<void> {
        const groups = new Map((this.stopping ? [] : this.host.groups()).map((group) => [group.key, group]));
        const dirty = new Set(this.dirtyRoots);
        for (const key of dirty) if (!keys || keys.has(key)) this.dirtyRoots.delete(key);
        force ||= this.forcePending;
        if (!keys) this.forcePending = false;
        const signature = (group: Group) => group.documents.map((document) => document.uri).sort().join('\n');
        const failures: unknown[] = [];
        for (const [key, current] of [...this.sessions]) {
            if (keys && !keys.has(key)) continue;
            const group = groups.get(key);
            if (!group || force || dirty.has(key) || current.signature !== signature(group) || strict && !current.session.isRunning()) {
                try { await this.stop(key, current.session); }
                catch (error) { failures.push(error); }
            }
        }
        if (failures.length) throw new AggregateError(failures, 'Some Teal language sessions could not be stopped.');
        for (const [key, group] of groups) {
            if (keys && !keys.has(key)) continue;
            if (this.stopping) break;
            if (this.sessions.has(key)) continue;
            try {
                const documentSignature = signature(group);
                const session = await this.host.start(group);
                const root = await realpath(group.root).catch(() => group.root);
                this.sessions.set(key, { group, root, session, signature: documentSignature });
                if (this.stopping) await this.stop(key, session);
            } catch (error) {
                this.host.report(error);
                if (strict) failures.push(error);
            }
        }
        if (failures.length) throw new AggregateError(failures, 'Some Teal language sessions could not be started.');
    }

    async dispose(): Promise<void> {
        this.stopping = true;
        if (this.timer) clearTimeout(this.timer);
        await this.refresh();
    }
}
