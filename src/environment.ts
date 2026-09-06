import * as vscode from 'vscode';
import { resolveToolchain, type ToolName } from './toolchain';

export function isSupported(): boolean {
    return process.platform === 'win32' && process.arch === 'x64'
        && !vscode.env.remoteName && vscode.env.uiKind === vscode.UIKind.Desktop;
}

export function requireExecution(): void {
    if (!isSupported()) throw new Error('Teal currently supports only the local Windows x64 desktop extension host.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting the Teal toolchain.');
}

export async function executable(name: ToolName, resource?: vscode.Uri): Promise<string> {
    requireExecution();
    const configured = vscode.workspace.getConfiguration('teal', resource).get<string>('toolchain.path', '');
    const toolchain = await resolveToolchain(configured);
    const result = toolchain.tools[name];
    if (!result) throw new Error(`${name}.exe is missing from ${toolchain.directory}. Configure a toolchain containing this tool.`);
    return result;
}

export function stringArray(value: unknown, name: string): string[] {
    if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== 'string')) {
        throw new Error(`${name} must be an array of strings.`);
    }
    return value as string[];
}

/** 错误统一进入日志，通知按文本去重，避免每次编辑重复打扰用户。 */
export class Reporter {
    private readonly shown = new Set<string>();
    constructor(readonly output: vscode.OutputChannel) {}

    report(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[Error] ${message}`);
        if (this.shown.has(message)) return;
        this.shown.add(message);
        void vscode.window.showErrorMessage(`Teal: ${message}`, 'Open Settings', 'Show Output').then((choice) => {
            if (choice === 'Open Settings') void vscode.commands.executeCommand('teal.openSettings');
            if (choice === 'Show Output') this.output.show(true);
        });
    }

    reset(): void { this.shown.clear(); }
}
