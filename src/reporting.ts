import * as vscode from 'vscode';

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

    async guard<T>(action: () => Promise<T>): Promise<T | undefined> {
        try { return await action(); }
        catch (error) { this.report(error); return undefined; }
    }

    reset(): void { this.shown.clear(); }
}
