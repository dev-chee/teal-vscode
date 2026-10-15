import * as vscode from 'vscode';
import { resolveToolchain, type ToolName } from './toolchain';
import { executableName, supportsExecution } from './platform';

export function isSupported(): boolean {
    return supportsExecution(process.platform, process.arch, vscode.env.remoteName, vscode.env.uiKind === vscode.UIKind.Desktop);
}

export function requireExecution(): void {
    if (!isSupported()) throw new Error('Teal requires a local Windows x64 or WSL Linux x64 workspace extension host in desktop VS Code.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting the Teal toolchain.');
}

export async function executable(name: ToolName, resource?: vscode.Uri): Promise<string> {
    requireExecution();
    const configured = vscode.workspace.getConfiguration('teal', resource).get<string>('toolchain.path', '');
    const toolchain = await resolveToolchain(configured);
    const result = toolchain.tools[name];
    if (!result) throw new Error(`${executableName(name)} is missing from ${toolchain.directory}. Configure a toolchain containing this tool.`);
    return result;
}
