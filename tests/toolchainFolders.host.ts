import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension';
import { executable } from '../src/environment';
import { executableName, toolchainTargets } from '../src/platform';
import { releaseAssetName } from '../src/toolchainDownloadCore';

/** 使用真实配置、激活入口、安装器和工具选择；夹具工具不执行。 */
export async function run(): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-folder-updates-'));
    const subscriptions: vscode.Disposable[] = [];
    const context = { globalStorageUri: vscode.Uri.file(path.join(root, 'storage')), subscriptions } as vscode.ExtensionContext;
    const originalFetch = globalThis.fetch;
    const originalPath = process.env.PATH;
    async function within<T>(pending: Promise<T>, label: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15_000);
            })]);
        } finally { if (timer) clearTimeout(timer); }
    }
    try {
        assert.ok(vscode.workspace.isTrusted);
        const local = path.join(root, 'local');
        await mkdir(local);
        for (const tool of ['teal', 'teal-lsp', 'teal-dap', 'teal-fmt']) {
            const file = path.join(local, executableName(tool));
            await writeFile(file, 'fixture executable, never executed');
            await chmod(file, 0o755);
        }
        const folders = ['a', 'b'].map(name => vscode.Uri.file(path.join(root, name)));
        for (const folder of folders) await mkdir(folder.fsPath);
        const changed = new Promise<void>(resolve => {
            const event = vscode.workspace.onDidChangeWorkspaceFolders(() => { event.dispose(); resolve(); });
        });
        assert.ok(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0,
            ...folders.map(uri => ({ uri }))));
        await within(changed, 'workspace folders added');
        const global = vscode.workspace.getConfiguration('teal');
        await global.update('toolchain.path', '', vscode.ConfigurationTarget.Global);
        await global.update('toolchain.release', 'latest', vscode.ConfigurationTarget.Global);
        await global.update('toolchain.autoUpdate', true, vscode.ConfigurationTarget.Global);
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const config = vscode.workspace.getConfiguration('teal', folder.uri);
            await config.update('toolchain.path', local, vscode.ConfigurationTarget.WorkspaceFolder);
            await config.update('toolchain.autoUpdate', false, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        const configs = folders.map(uri => vscode.workspace.getConfiguration('teal', uri));
        for (let i = 0; i < configs.length; i++) await configs[i].update('toolchain.release', `toolchain-v${i + 1}.0.0`, vscode.ConfigurationTarget.WorkspaceFolder);
        const metadata: string[] = [];
        // 禁止 PATH 中其他 Teal 安装掩盖文件夹配置读取错误；此阶段不运行 tar。
        process.env.PATH = '';
        globalThis.fetch = async input => { metadata.push(String(input)); return Response.json([]); };
        await activate(context);
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(metadata.length, 0, 'local folder toolchains and folder opt-out must suppress background checks');
        for (const folder of folders) assert.equal(await executable('teal-lsp', folder), path.join(local, executableName('teal-lsp')));
        await deactivate();
        subscriptions.splice(0).forEach(item => item.dispose());
        process.env.PATH = originalPath;

        const bundle = path.join(root, 'bundle');
        await mkdir(bundle, { recursive: true });
        for (const tool of ['teal', 'teal-lsp', 'teal-dap', 'teal-fmt']) {
            const file = path.join(bundle, executableName(tool));
            await writeFile(file, 'fixture executable, never executed');
            await chmod(file, 0o755);
        }
        const files = [];
        for (const tool of ['teal', 'teal-lsp', 'teal-dap', 'teal-fmt']) {
            const file = executableName(tool);
            const bytes = await readFile(path.join(bundle, file));
            files.push({ path: file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
        await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({ formatVersion: 1, files }));
        const packed = path.join(root, 'fixture.tar.gz');
        await promisify(execFile)('tar', ['-czf', packed, '-C', root, 'bundle']);
        const bytes = await readFile(packed);
        const digest = createHash('sha256').update(bytes).digest('hex');
        process.env.PATH = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin';
        for (const config of configs) {
            await config.update('toolchain.path', '', vscode.ConfigurationTarget.WorkspaceFolder);
            await config.update('toolchain.autoUpdate', true, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        globalThis.fetch = async input => {
            const url = String(input);
            if (url.startsWith('https://api.github.com/')) {
                metadata.push(url);
                const tag = decodeURIComponent(url.split('/tags/')[1] ?? 'unexpected latest');
                assert.match(tag, /^toolchain-v[12]\.0\.0$/);
                return Response.json({ id: tag.includes('v1') ? 1 : 2, tag_name: tag, assets: toolchainTargets.map(target => ({
                    name: releaseAssetName('teal', target), browser_download_url: 'https://fixture.invalid/toolchain', digest: `sha256:${digest}`, size: bytes.length,
                })) });
            }
            assert.equal(url, 'https://fixture.invalid/toolchain');
            return new Response(bytes);
        };
        await activate(context);
        const selected = await within(Promise.all(folders.map(uri => executable('teal-lsp', uri))), 'both pinned installations');
        console.log(JSON.stringify({ selected, metadata }));
        assert.notEqual(path.dirname(selected[0]), path.dirname(selected[1]), 'different pins must retain independent installations');
        assert.ok(metadata.some(url => url.endsWith('/tags/toolchain-v1.0.0')));
        assert.ok(metadata.some(url => url.endsWith('/tags/toolchain-v2.0.0')));
        assert.equal(metadata.length, 2);
        for (let i = 0; i < folders.length; i++) {
            for (const tool of ['teal', 'teal-lsp', 'teal-dap', 'teal-fmt'] as const) {
                assert.equal(await executable(tool, folders[i]), path.join(path.dirname(selected[i]), executableName(tool)));
            }
        }
        await deactivate();
        subscriptions.splice(0).forEach(item => item.dispose());
        for (const config of configs) await config.update('toolchain.autoUpdate', false, vscode.ConfigurationTarget.WorkspaceFolder);
        globalThis.fetch = async () => { throw new Error('cached pins with autoUpdate=false must not fetch'); };
        await activate(context);
        assert.deepEqual(await Promise.all(folders.map(uri => executable('teal-lsp', uri))), selected, 'reopening must retain both cached pins while updates are disabled');

        let downloaded!: () => void;
        const downloading = new Promise<void>(resolve => { downloaded = resolve; });
        let cancelled!: () => void;
        let downloadCancelled = false;
        const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
        globalThis.fetch = async (input, options) => {
            if (String(input).startsWith('https://api.github.com/')) return Response.json({ id: 3, tag_name: 'toolchain-v3.0.0', assets: toolchainTargets.map(target => ({
                name: releaseAssetName('teal', target), browser_download_url: 'https://fixture.invalid/pending', digest: `sha256:${digest}`, size: bytes.length,
            })) });
            assert.equal(String(input), 'https://fixture.invalid/pending');
            const signal = options?.signal;
            assert.ok(signal);
            downloaded();
            return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => { downloadCancelled = true; cancelled(); reject(signal.reason); }, { once: true }));
        };
        await configs[1].update('toolchain.release', 'toolchain-v3.0.0', vscode.ConfigurationTarget.WorkspaceFolder);
        await configs[1].update('toolchain.autoUpdate', true, vscode.ConfigurationTarget.WorkspaceFolder);
        await within(downloading, 'new folder version download');
        await configs[0].update('toolchain.path', local, vscode.ConfigurationTarget.WorkspaceFolder);
        assert.equal(await within(executable('teal-lsp', folders[0]), 'local tool during another download'), path.join(local, executableName('teal-lsp')), 'a local folder must not wait for another folder download');
        assert.equal(downloadCancelled, false, 'an unrelated folder setting must not cancel this download');
        const removed = vscode.workspace.workspaceFolders!.findIndex(folder => folder.uri.toString() === folders[1].toString());
        assert.ok(vscode.workspace.updateWorkspaceFolders(removed, 1));
        await within(cancellation, 'removed folder download cancellation');
        assert.ok((await readFile(path.join(path.dirname(selected[1]), 'manifest.json'))).length, 'removing a folder must preserve its previously installed generation');
        console.log('PASS: folder local priority, opt-out, independent pins, cached reopening, and cancellation on folder removal');
    } finally {
        await deactivate();
        subscriptions.splice(0).forEach(item => item.dispose());
        globalThis.fetch = originalFetch;
        process.env.PATH = originalPath;
        // Windows 工作区监听器可能仍持有夹具目录，不能掩盖测试的原始结果。
        await rm(root, { recursive: true, force: true }).catch(() => {});
    }
}
