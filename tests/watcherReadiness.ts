import { setTimeout as delay } from 'node:timers/promises';

/** 注册确认不代表系统监听已就绪；仅在准备阶段重试探针，后续变更仍只发送一次。 */
export async function waitForWatcher(
    probe: () => Promise<void>,
    observed: () => boolean,
    message: string,
    { timeoutMs = 12_000, retryMs = 1000, pollMs = 100 } = {},
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let nextProbe = 0;
    while (Date.now() < deadline) {
        if (Date.now() >= nextProbe) {
            await probe();
            // LanguageClient 对文件事件防抖 250ms；持续快速写入会推迟通知。
            nextProbe = Date.now() + retryMs;
        }
        if (observed()) return;
        const remaining = deadline - Date.now();
        if (remaining > 0) await delay(Math.min(pollMs, remaining));
    }
    throw new Error(message);
}
