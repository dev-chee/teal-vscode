export interface UpdateSettings {
    trusted: boolean;
    supported: boolean;
    autoUpdate: boolean;
    release: string;
    local: boolean;
}

export interface UpdateHost {
    settings(): Promise<UpdateSettings>;
    install(release: string, options: { force: boolean; signal: AbortSignal; canCommit: () => Promise<boolean> }): Promise<string | undefined>;
    apply(directory: string): Promise<void>;
    log(error: unknown): void;
}

/** 宿主事件适配之外的更新调度；准备完成先于 LSP 刷新，避免首次安装互相等待。 */
export class ToolchainUpdates {
    private operation: Promise<string | undefined> | undefined;
    private preparation: Promise<unknown> = Promise.resolve();
    private cancellation: AbortController | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private stopped = false;
    private forced = false;

    constructor(private readonly host: UpdateHost) {}

    start(): void {
        this.background();
        this.timer = setInterval(() => this.background(), 6 * 60 * 60_000);
        this.timer.unref();
    }

    async ready(): Promise<void> { await this.preparation.catch(() => {}); }

    check(force = false): Promise<string | undefined> {
        if (this.stopped) return Promise.resolve(undefined);
        if (this.operation) {
            if (force && !this.forced) return this.operation.catch(() => undefined).then(() => this.check(true));
            return this.operation;
        }
        this.forced = force;
        const controller = new AbortController();
        this.cancellation = controller;
        const preparation = (async () => {
            const initial = await this.host.settings();
            const eligible = (settings: UpdateSettings) => settings.trusted && settings.supported && !settings.local && (force || settings.autoUpdate);
            if (!eligible(initial)) return undefined;
            const canCommit = async () => {
                const current = await this.host.settings();
                return !this.stopped && !controller.signal.aborted && eligible(current) && current.release === initial.release;
            };
            return this.host.install(initial.release, { force, signal: controller.signal, canCommit });
        })();
        this.preparation = preparation;
        // 无消费者等待 ready 时也需要处理后台拒绝。
        void preparation.catch(() => {});
        const operation = preparation.then(async directory => {
            if (directory && !this.stopped && !controller.signal.aborted) await this.host.apply(directory);
            return directory;
        }).finally(() => { if (this.operation === operation) this.operation = undefined; });
        this.operation = operation;
        return operation;
    }

    private background(): void { void this.check().catch(error => this.host.log(error)); }

    async configurationChanged(): Promise<void> {
        this.cancellation?.abort();
        await this.operation?.catch(() => {});
        if (!this.stopped) this.background();
    }

    async dispose(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.cancellation?.abort();
        await this.operation?.catch(() => {});
    }
}
