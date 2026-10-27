import * as path from 'node:path';
import * as vscode from 'vscode';
import { executable, requireExecution } from './environment';
import { prepareDebugConfiguration } from './debugOptions';
import { runArguments } from './configuration';
import { isLocalTealDocument, saveDocument } from './documents';
import { Reporter } from './reporting';

async function sourceFile(uri?: vscode.Uri): Promise<vscode.TextDocument> {
    requireExecution();
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document || !isLocalTealDocument(document)) {
        throw new Error('Open and save a local Teal file before running or debugging.');
    }
    await saveDocument(document);
    return document;
}

export async function runFile(uri?: vscode.Uri): Promise<vscode.TaskExecution> {
    const document = await sourceFile(uri);
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const cwd = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const command = await executable('teal', document.uri);
    const config = vscode.workspace.getConfiguration('teal', document.uri);
    const args = runArguments(document.uri.fsPath, config.get('run.options', []), config.get('run.args', []));
    const task = new vscode.Task(
        { type: 'teal', program: document.uri.fsPath }, folder ?? vscode.TaskScope.Global,
        `Run ${path.basename(document.uri.fsPath)}`, 'Teal',
        new vscode.ProcessExecution(command, args, { cwd }), [],
    );
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: true, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    return vscode.tasks.executeTask(task);
}

export async function debugFile(uri?: vscode.Uri): Promise<boolean> {
    const document = await sourceFile(uri);
    return vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(document.uri), {
        type: 'teal', name: 'Teal: Current File', request: 'launch',
        program: document.uri.fsPath, console: 'integratedTerminal',
    });
}

export class DebugConfigurations implements vscode.DebugConfigurationProvider {
    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [{ type: 'teal', request: 'launch', name: 'Teal: Current File', program: '${file}', console: 'integratedTerminal' }];
    }

    resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.DebugConfiguration {
        requireExecution();
        if (!config.type && !config.request && !config.name) {
            config = this.provideDebugConfigurations()[0];
        }
        if (config.request === 'launch') {
            config.program ??= '${file}';
            config.console ??= 'integratedTerminal';
        }
        return config;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration,
    ): Promise<vscode.DebugConfiguration> {
        requireExecution();
        return prepareDebugConfiguration(config, {
            baseDirectory: folder?.uri.fsPath ?? path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? ''),
            workspaceDirectory: folder?.uri.fsPath,
            documents: vscode.workspace.textDocuments,
        });
    }
}

export class DebugAdapter implements vscode.DebugAdapterDescriptorFactory {
    constructor(private readonly reporter: Reporter) {}

    async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor | undefined> {
        return this.reporter.guard(async () => {
            const resource = session.workspaceFolder?.uri
                ?? (session.configuration.request === 'launch' ? vscode.Uri.file(session.configuration.program) : undefined);
            const command = await executable('teal', resource);
            return new vscode.DebugAdapterExecutable(command, ['dap'], { cwd: session.configuration.cwd ?? session.workspaceFolder?.uri.fsPath ?? path.dirname(command) });
        });
    }
}
