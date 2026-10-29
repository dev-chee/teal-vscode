import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { toolchainTargets } from '../src/platform';
import { releaseAssetName } from '../src/toolchainDownloadCore';

/** 在真实扩展宿主中替换网络，安装真实工具后确认 LSP 在更新前后均能服务。 */
export async function run(): Promise<void> {
    const source = process.env.TEAL_TOOLCHAIN_PATH;
    const storage = process.env.TEAL_TEST_STORAGE_DIR;
    assert.ok(source); assert.ok(storage);
    assert.ok(vscode.workspace.isTrusted);
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'teal-update-host-')));
    const originalFetch = globalThis.fetch;
    const originalPath = process.env.PATH;
    const config = vscode.workspace.getConfiguration('teal');
    try {
        process.env.PATH = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin';
        const bundle = path.join(root, 'bundle');
        await cp(source, bundle, { recursive: true });
        const packed = path.join(root, 'fixture.tar.gz');
        await promisify(execFile)('tar', ['-czf', packed, '-C', root, 'bundle']);
        const bytes = await readFile(packed);
        const digest = createHash('sha256').update(bytes).digest('hex');
        let version = 1, downloads = 0;
        globalThis.fetch = async input => {
            if (String(input).startsWith('https://api.github.com/repos/dev-chee/teal-vscode/releases')) {
                return Response.json([{ id: version, tag_name: `toolchain-v${version}.0.0`, assets: toolchainTargets.map(target => ({
                    name: releaseAssetName(target), browser_download_url: 'https://fixture.invalid/toolchain', digest: `sha256:${digest}`, size: bytes.length,
                })) }]);
            }
            assert.equal(String(input), 'https://fixture.invalid/toolchain');
            downloads++; return new Response(bytes);
        };
        await config.update('toolchain.path', '', vscode.ConfigurationTarget.Global);
        await config.update('toolchain.release', 'latest', vscode.ConfigurationTarget.Global);
        await config.update('toolchain.autoUpdate', true, vscode.ConfigurationTarget.Global);
        const extension = vscode.extensions.getExtension('dev-chee.teal-vscode');
        assert.ok(extension); await extension.activate();
        const fixture = path.join(root, 'project'); await mkdir(fixture);
        const file = path.join(fixture, 'main.tl');
        await writeFile(file, 'fn helper(value: int) -> int { return value; }\nfn main() { print(helper(42)); }\n');
        const document = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(document);
        const stateFile = path.join(storage, 'managed-toolchain/current.json');
        async function waitFor<T>(action: () => Promise<T | undefined>): Promise<T> {
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
                const result = await action().catch(() => undefined);
                if (result !== undefined) return result;
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            throw new Error('Timed out waiting for installed toolchain or language server');
        }
        const first = await waitFor(async () => JSON.parse(await readFile(stateFile, 'utf8')) as { release: string; directory: string; repository: string });
        assert.equal(first.release, 'toolchain-v1.0.0');
        assert.equal(first.repository, 'dev-chee/teal-vscode');
        const hover = () => waitFor(async () => {
            const result = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, new vscode.Position(1, 20));
            return result?.length ? result : undefined;
        });
        await hover();
        version = 2;
        await vscode.commands.executeCommand('teal.checkToolchainUpdates');
        const second = JSON.parse(await readFile(stateFile, 'utf8'));
        assert.equal(second.release, 'toolchain-v2.0.0');
        assert.notEqual(second.directory, first.directory);
        assert.ok((await readFile(path.join(first.directory, 'manifest.json'))).length);
        await hover();
        await vscode.commands.executeCommand('teal.checkToolchainUpdates');
        assert.equal(downloads, 2);
        console.log('PASS: automatic first install, explicit update, retained generation and live LSP after switching');
    } finally {
        await config.update('toolchain.autoUpdate', false, vscode.ConfigurationTarget.Global);
        globalThis.fetch = originalFetch;
        process.env.PATH = originalPath;
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await rm(root, { recursive: true, force: true }).catch(() => {});
    }
}
