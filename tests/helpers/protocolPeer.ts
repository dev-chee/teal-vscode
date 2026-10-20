import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

export interface ProtocolMessage {
    id?: number;
    seq?: number;
    type?: string;
    request_seq?: number;
    success?: boolean;
    message?: string;
    method?: string;
    command?: string;
    event?: string;
    error?: unknown;
    params?: { uri?: string; diagnostics?: Array<{ severity?: number; message: string }> };
    arguments?: { args?: string[]; cwd?: string; kind?: string };
    body?: { stackFrames?: unknown[] };
}

/** 测试真实 LSP/DAP 的 Content-Length 协议，不依赖编辑器宿主。 */
export class ProtocolPeer {
    readonly process: ChildProcessWithoutNullStreams;
    private buffer = Buffer.alloc(0);
    private readonly messages: ProtocolMessage[] = [];
    private readonly waiters: Array<{ matches: (message: ProtocolMessage) => boolean; resolve: (message: ProtocolMessage) => void; reject: (error: Error) => void }> = [];
    private sequence = 0;
    private failure?: Error;

    constructor(executable: string, cwd: string) {
        this.process = spawn(executable, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        this.process.stderr.resume();
        this.process.on('error', (error) => this.fail(error));
        this.process.on('exit', () => this.fail(new Error('Protocol process exited')));
        this.process.stdout.on('data', (chunk: Buffer) => {
            try {
                this.buffer = Buffer.concat([this.buffer, chunk]);
                for (;;) {
                    const end = this.buffer.indexOf('\r\n\r\n');
                    if (end < 0) return;
                    const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1]);
                    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid protocol header');
                    if (this.buffer.length < end + 4 + length) return;
                    const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString()) as ProtocolMessage;
                    this.buffer = this.buffer.subarray(end + 4 + length);
                    const index = this.waiters.findIndex((waiter) => waiter.matches(message));
                    if (index < 0) this.messages.push(message);
                    else this.waiters.splice(index, 1)[0].resolve(message);
                }
            } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
        });
    }

    private fail(error: Error): void {
        this.failure = error;
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    }

    send(message: object): void {
        const body = Buffer.from(JSON.stringify(message));
        this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.process.stdin.write(body);
    }

    wait(matches: (message: ProtocolMessage) => boolean): Promise<ProtocolMessage> {
        const index = this.messages.findIndex(matches);
        if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
        if (this.failure) return Promise.reject(this.failure);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                reject(new Error('Protocol response timed out'));
            }, Number(process.env.TEAL_TEST_TIMEOUT_MS ?? 15_000));
            const waiter = { matches, resolve: (message: ProtocolMessage) => { clearTimeout(timer); resolve(message); }, reject: (error: Error) => { clearTimeout(timer); reject(error); } };
            this.waiters.push(waiter);
        });
    }

    async request(method: string, params: object): Promise<ProtocolMessage> {
        const id = ++this.sequence;
        this.send({ jsonrpc: '2.0', id, method, params });
        const response = await this.wait((message) => message.id === id);
        if (response.error) throw new Error(JSON.stringify(response.error));
        return response;
    }

    dap(command: string, args: object = {}): number {
        const seq = ++this.sequence;
        this.send({ seq, type: 'request', command, arguments: args });
        return seq;
    }

    async response(seq: number): Promise<ProtocolMessage> {
        const response = await this.wait((message) => message.type === 'response' && message.request_seq === seq);
        if (!response.success) throw new Error(response.message ?? 'DAP request failed');
        return response;
    }

    async dispose(): Promise<void> {
        if (this.process.exitCode !== null || this.process.signalCode !== null) return;
        const exited = once(this.process, 'exit');
        this.process.kill();
        const timer = setTimeout(() => { this.process.kill('SIGKILL'); }, 2_000);
        try { await exited; }
        finally { clearTimeout(timer); }
    }
}
