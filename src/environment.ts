import * as vscode from 'vscode';
import { resolveToolchainWithManaged, type ToolName } from './toolchain';
import { executableName, supportsExecution } from './platform';

export function isSupported(): boolean {
    return supportsExecution(process.platform, process.arch);
}

let managedToolchainDirectory: string | undefined;

export function setManagedToolchainDirectory(directory: string | undefined): void {
    managedToolchainDirectory = directory;
}

export function requireExecution(): void {
    if (!isSupported()) throw new Error('Teal requires a supported Windows, Linux or macOS Node.js workspace extension host.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting the Teal toolchain.');
}

export async function executable(name: ToolName, resource?: vscode.Uri): Promise<string> {
    requireExecution();
    const configured = vscode.workspace.getConfiguration('teal', resource).get<string>('toolchain.path', '');
    const toolchain = await resolveToolchainWithManaged(configured, managedToolchainDirectory);
    const result = toolchain.tools[name];
    if (!result) throw new Error(`${executableName(name)} is missing from ${toolchain.directory}. Configure a toolchain containing this tool.`);
    return result;
}
