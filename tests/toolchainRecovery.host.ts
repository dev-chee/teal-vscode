import assert from 'node:assert/strict';
import childProcess, { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension';
import { executable } from '../src/environment';
import { toolchainTargets } from '../src/platform';
import { releaseAssetName } from '../src/toolchainDownloadCore';
import { toolchainTestContext } from './helpers/extensionContext';

/** 注入真实进程启动的一次失败，验证激活入口、旧 LSP 恢复和候选目录重试。 */
export async function run(): Promise<void> {
    const source = process.env.TEAL_TOOLCHAIN_PATH;
    assert.ok(source, 'a verified native distribution is required');
    const root = await mkdtemp(path.join(tmpdir(), 'teal-recovery-host-'));
    const subscriptions: vscode.Disposable[] = [];
    const context = toolchainTestContext(root, subscriptions);
    const originalFetch = globalThis.fetch;
    const originalSpawn = childProcess.spawn;
    const originalPath = process.env.PATH;
    const config = vscode.workspace.getConfiguration('teal');
    let failOnce = false;
    let starts = 0;
    const closing = new Set<Promise<void>>();
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
        const server = Array.isArray(args[1]) && args[1][0] === 'lsp';
        if (server) {
            starts++;
            if (failOnce) {
                failOnce = false;
                throw Object.assign(new Error('injected transient LSP spawn failure'), { code: 'EAGAIN' });
            }
        }
        const child = originalSpawn(...args);
        if (server) {
            const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
            closing.add(closed);
            void closed.then(() => closing.delete(closed));
        }
        return child;
    }) as typeof childProcess.spawn;
    async function stop() {
        await deactivate();
        await Promise.all([...closing]);
        subscriptions.splice(0).forEach(item => item.dispose());
    }
    try {
        assert.ok(vscode.workspace.isTrusted);
        // 系统已有 Teal 应继续优先，但不能掩盖本用例要验收的托管切换。
        process.env.PATH = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin';
        const bundle = path.join(root, 'bundle');
        await cp(source, bundle, { recursive: true });
        const packed = path.join(root, 'fixture.tar.gz');
        await promisify(execFile)('tar', ['-czf', packed, '-C', root, 'bundle']);
        const bytes = await readFile(packed);
        const digest = createHash('sha256').update(bytes).digest('hex');
        let version = 1, downloads = 0;
        globalThis.fetch = async input => {
            if (String(input).startsWith('https://api.github.com/')) return Response.json([{ id: version, tag_name: `toolchain-v${version}.0.0`, assets: toolchainTargets.map(target => ({
                name: releaseAssetName(target), browser_download_url: 'https://fixture.invalid/toolchain', digest: `sha256:${digest}`, size: bytes.length,
            })) }]);
            assert.equal(String(input), 'https://fixture.invalid/toolchain');
            downloads++; return new Response(bytes);
        };
        await config.update('toolchain.path', '', vscode.ConfigurationTarget.Global);
        await config.update('toolchain.release', 'latest', vscode.ConfigurationTarget.Global);
        await config.update('toolchain.autoUpdate', false, vscode.ConfigurationTarget.Global);
        await activate(context);
        await vscode.commands.executeCommand('teal.installToolchain');
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(root, 'project');
        await mkdir(folder, { recursive: true });
        const file = path.join(folder, 'recovery.tl');
        await writeFile(file, 'fn helper(value: int) -> int { return value; }\nfn main() { print(helper(42)); }\n');
        const document = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(document);
        const hover = async () => {
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
                const result = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, new vscode.Position(1, 20));
                if (result?.length) return;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('No running LSP answered hover after toolchain activation');
        };
        await hover();
        const oldCommand = await executable('teal', document.uri);
        const before = starts;
        assert.ok(before > 0, 'the initial real server must have started');
        version = 2; failOnce = true;
        await vscode.commands.executeCommand('teal.checkToolchainUpdates');
        assert.equal(failOnce, false, 'the process startup failure must be exercised');
        assert.equal(await executable('teal', document.uri), oldCommand);
        await hover();
        assert.equal(starts, before + 2, 'one failed new process and one recovered old process');
        await vscode.commands.executeCommand('teal.checkToolchainUpdates');
        const newCommand = await executable('teal', document.uri);
        assert.notEqual(newCommand, oldCommand);
        await hover();
        assert.equal(downloads, 2, 'retry reuses the validated candidate without downloading it again');
        assert.equal(starts, before + 3);
        await vscode.commands.executeCommand('teal.checkToolchainUpdates');
        assert.equal(starts, before + 3, 'an applied healthy candidate is not restarted');

        await stop();
        globalThis.fetch = async () => { throw new Error('offline cached recovery must not fetch'); };
        failOnce = true;
        await activate(context);
        assert.equal(failOnce, false);
        assert.equal(await executable('teal', document.uri), oldCommand);
        await hover();
        console.log('PASS: real LSP failure restores the old server, explicit retry reuses the candidate, and cached startup recovers offline');
    } finally {
        await stop();
        childProcess.spawn = originalSpawn;
        globalThis.fetch = originalFetch;
        process.env.PATH = originalPath;
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await rm(root, { recursive: true, force: true }).catch(() => {});
    }
}
