import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

/** 保留本会话的子进程句柄，供协议关闭失败时回收。 */
export function launchLanguageServer(command: string, cwd: string, env: NodeJS.ProcessEnv | undefined, log: (message: string) => void) {
    const child = spawn(command, ['lsp'], { cwd, env, windowsHide: true });
    const closed = new Promise<true>(resolve => child.once('close', () => resolve(true)));
    // spawn 失败由 ready 传给调用方；进程启动后的 I/O 或终止错误仍需消费。
    child.on('error', error => {
        if (child.pid !== undefined) log(`[LSP] Process ${child.pid}: ${error.message}`);
    });
    const ready = once(child, 'spawn').then(() => child);
    const waitForClose = (ms: number) => Promise.race([closed, delay(ms, false, { ref: false })]);
    return {
        ready,
        /** 正常关闭后给进程退出的时间；超时仅终止本会话的进程，并等待句柄关闭。 */
        async stop(graceful: boolean): Promise<boolean> {
            if (graceful && await waitForClose(1000)) return false;
            const terminated = child.pid !== undefined && child.exitCode === null && child.signalCode === null && child.kill('SIGKILL');
            if (!await waitForClose(2000)) throw new Error(`Language server process ${child.pid} did not exit.`);
            return terminated;
        },
    };
}
