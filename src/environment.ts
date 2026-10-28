import * as vscode from 'vscode';
import { isCompleteToolchain, resolveToolchain, resolveToolchainWithFallbacks, type ToolName } from './toolchain';
import { executableName, supportsExecution } from './platform';
import type { BundledToolchain } from './bundledToolchain';

export function isSupported(): boolean {
    return supportsExecution(process.platform, process.arch);
}

let managedToolchain: ((resource?: vscode.Uri) => Promise<string | undefined>) | undefined;
let bundledToolchain: ((resource?: vscode.Uri) => Promise<BundledToolchain | undefined>) | undefined;

export function setManagedToolchainProvider(provider: typeof managedToolchain): void {
    managedToolchain = provider;
}

/** 包内工具链只在 PATH 和托管缓存均不可用时兜底，避免阻止正常自动更新。 */
export function setBundledToolchainProvider(provider: typeof bundledToolchain): void {
    bundledToolchain = provider;
}

export function requireExecution(): void {
    if (!isSupported()) throw new Error('Teal requires a supported Windows, Linux or macOS Node.js workspace extension host.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting the Teal toolchain.');
}

function toolchainSettings(resource?: vscode.Uri): { path: string; release: string } {
    const config = vscode.workspace.getConfiguration('teal', resource);
    const release = config.get<string>('toolchain.release', 'latest').trim();
    return { path: config.get<string>('toolchain.path', ''), release: !release || release.toLowerCase() === 'latest' ? 'latest' : release };
}

export async function executable(name: ToolName, resource?: vscode.Uri): Promise<string> {
    for (;;) {
        requireExecution();
        const settings = toolchainSettings(resource);
        const changed = () => {
            const current = toolchainSettings(resource);
            return current.path !== settings.path || current.release !== settings.release;
        };
        try {
            let toolchain = await resolveToolchain(settings.path).catch(error => {
                if (settings.path.trim()) throw error;
                return undefined;
            });
            if (changed()) continue;
            // 本地工具不等待其他文件夹的下载，显式错误仍直接报告。
            if (!settings.path.trim() && !isCompleteToolchain(toolchain)) {
                let managedDirectory: string | undefined;
                let managedError: unknown;
                try {
                    managedDirectory = await managedToolchain?.(resource);
                } catch (error) {
                    managedError = error;
                }
                const bundled = await bundledToolchain?.(resource);
                requireExecution();
                // 托管目录与包内结果属于同一配置快照，版本变化后必须重新选择。
                if (changed()) continue;
                const bundledDirectory = settings.release === 'latest' || bundled?.release === settings.release ? bundled?.directory : undefined;
                try {
                    toolchain = await resolveToolchainWithFallbacks(settings.path, [managedDirectory, bundledDirectory]);
                } catch (error) {
                    // 网络更新失败时，已校验的包内工具链仍可离线启动。
                    if (!bundledDirectory && managedError) throw managedError;
                    throw error;
                }
            }
            requireExecution();
            if (changed()) continue;
            if (!toolchain) throw new Error('No Teal toolchain found.');
            const result = toolchain.tools[name];
            if (!result) throw new Error(`${executableName(name)} is missing from ${toolchain.directory}. Configure a toolchain containing this tool.`);
            return result;
        } catch (error) {
            requireExecution();
            if (changed()) continue;
            throw error;
        }
    }
}
