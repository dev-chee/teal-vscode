import * as vscode from 'vscode';
import { isCompleteToolchain, resolveToolchain, resolveToolchainWithManaged, type ToolName } from './toolchain';
import { executableName, supportsExecution } from './platform';

export function isSupported(): boolean {
    return supportsExecution(process.platform, process.arch);
}

let managedToolchain: ((resource?: vscode.Uri) => Promise<string | undefined>) | undefined;

export function setManagedToolchainProvider(provider: typeof managedToolchain): void {
    managedToolchain = provider;
}

export function requireExecution(): void {
    if (!isSupported()) throw new Error('Teal requires a supported Windows, Linux or macOS Node.js workspace extension host.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting the Teal toolchain.');
}

export async function executable(name: ToolName, resource?: vscode.Uri): Promise<string> {
    requireExecution();
    const configured = vscode.workspace.getConfiguration('teal', resource).get<string>('toolchain.path', '');
    let toolchain = await resolveToolchain(configured).catch(error => {
        if (configured.trim()) throw error;
        return undefined;
    });
    // 本地工具不等待其他文件夹的下载，显式错误仍直接报告。
    if (!configured.trim() && !isCompleteToolchain(toolchain)) {
        const directory = await managedToolchain?.(resource);
        requireExecution();
        const current = vscode.workspace.getConfiguration('teal', resource).get<string>('toolchain.path', '');
        toolchain = await resolveToolchainWithManaged(current, directory);
    }
    requireExecution();
    if (!toolchain) throw new Error('No Teal toolchain found.');
    const result = toolchain.tools[name];
    if (!result) throw new Error(`${executableName(name)} is missing from ${toolchain.directory}. Configure a toolchain containing this tool.`);
    return result;
}
