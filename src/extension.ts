import * as vscode from 'vscode';
import { isSupported, Reporter, requireExecution } from './environment';
import { DebugAdapter, DebugConfigurations, debugFile, runFile } from './execution';
import { LanguageClients } from './languageClient';

let clients: LanguageClients | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('Teal');
    const reporter = new Reporter(output);
    clients = new LanguageClients(reporter);
    const managed = clients;
    const guard = <T>(action: () => Promise<T>): Promise<T | undefined> => action().catch((error: unknown) => {
        reporter.report(error);
        return undefined;
    });
    const configuration = new DebugConfigurations();
    context.subscriptions.push(
        output,
        vscode.commands.registerCommand('teal.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:dev-chee.teal-vscode')),
        vscode.commands.registerCommand('teal.showOutput', () => output.show(true)),
        vscode.commands.registerCommand('teal.restartServer', () => guard(async () => {
            requireExecution();
            reporter.reset();
            await managed.refresh(true);
        })),
        vscode.commands.registerCommand('teal.runFile', (uri?: vscode.Uri) => guard(() => runFile(uri))),
        vscode.commands.registerCommand('teal.debugFile', (uri?: vscode.Uri) => guard(() => debugFile(uri))),
        vscode.debug.registerDebugConfigurationProvider('teal', {
            provideDebugConfigurations: () => configuration.provideDebugConfigurations(),
            resolveDebugConfiguration: (folder, config) => guard(async () => configuration.resolveDebugConfiguration(folder, config)),
            resolveDebugConfigurationWithSubstitutedVariables: (folder, config) => guard(() => configuration.resolveDebugConfigurationWithSubstitutedVariables(folder, config)),
        }),
        vscode.debug.registerDebugAdapterDescriptorFactory('teal', new DebugAdapter(reporter)),
    );
    await vscode.commands.executeCommand('setContext', 'teal.supported', isSupported());
    if (!isSupported()) output.appendLine('Teal tool execution requires a local Windows x64 desktop extension host.');
    await managed.refresh();
}

export async function deactivate(): Promise<void> {
    await clients?.dispose();
    clients = undefined;
}
