import { mkdir, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';

/** 全宿主窗口共用目录锁；心跳和失效恢复由 proper-lockfile 管理。 */
export async function withManagedLock<T>(root: string, action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    await mkdir(root, { recursive: true });
    const directory = await realpath(root);
    const compromised = new AbortController();
    const combined = signal ? AbortSignal.any([signal, compromised.signal]) : compromised.signal;
    const deadline = Date.now() + 10 * 60_000;
    let release: (() => Promise<void>) | undefined;
    while (!release) {
        combined.throwIfAborted();
        try {
            release = await lockfile.lock(directory, { stale: 120_000, update: 10_000, retries: 0,
                onCompromised: error => compromised.abort(error) });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) throw error;
            await delay(100, undefined, { signal: combined });
        }
    }
    try { combined.throwIfAborted(); return await action(combined); }
    finally { await release().catch(error => { if (!compromised.signal.aborted) throw error; }); }
}
