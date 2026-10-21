import * as vscode from 'vscode';
import { isSupported, requireExecution, setManagedToolchainProvider } from './environment';
import { DebugAdapter, DebugConfigurations, debugFile, runFile } from './execution';
import { LanguageClients } from './languageClient';
import { disposeLanguageServerExecutables } from './languageServerExecutable';
import { Reporter } from './reporting';
import { WorkspaceToolchains } from './workspaceToolchains';

let clients: LanguageClients | undefined;
let updates: WorkspaceToolchains | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('Teal');
    const reporter = new Reporter(output);
    clients = new LanguageClients(reporter);
    const managed = clients;
    const updater = new WorkspaceToolchains(context, force => managed.refresh(force), message => output.appendLine(message));
    updates = updater;
    setManagedToolchainProvider(resource => updater.directory(resource));
    const configurationChanged = (event?: vscode.ConfigurationChangeEvent) => { void updater.configurationChanged(event).catch(error => output.appendLine(`[Toolchain update] ${String(error)}`)); };
    const configuration = new DebugConfigurations();
    context.subscriptions.push(
        output,
        vscode.workspace.onDidGrantWorkspaceTrust(() => configurationChanged()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => configurationChanged()),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('teal.toolchain')) configurationChanged(event);
        }),
        vscode.commands.registerCommand('teal.checkToolchainUpdates', () => reporter.guard(async () => {
            requireExecution();
            await updater.check();
            void vscode.window.showInformationMessage('Teal toolchain update check completed. Explicit paths and complete PATH toolchains keep priority.');
        })),
        vscode.commands.registerCommand('teal.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:dev-chee.teal-vscode')),
        vscode.commands.registerCommand('teal.installToolchain', () => reporter.guard(async () => {
            requireExecution();
            const resource = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
            const configured = vscode.workspace.getConfiguration('teal', resource).get<string>('toolchain.path', '').trim();
            if (configured) {
                const choice = await vscode.window.showWarningMessage('teal.toolchain.path is configured and takes priority. Install a managed toolchain anyway?', 'Install anyway');
                if (choice !== 'Install anyway') return;
            }
            const installed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing Teal toolchain' }, async (progress) =>
                updater.install(resource, message => progress.report({ message })));
            void vscode.window.showInformationMessage(`Teal toolchain ${installed.release} installed for ${installed.target}.`);
        })),
        vscode.commands.registerCommand('teal.showOutput', () => output.show(true)),
        vscode.commands.registerCommand('teal.restartServer', () => reporter.guard(async () => {
            requireExecution();
            reporter.reset();
            await managed.refresh(true);
        })),
        vscode.commands.registerCommand('teal.runFile', (uri?: vscode.Uri) => reporter.guard(() => runFile(uri))),
        vscode.commands.registerCommand('teal.debugFile', (uri?: vscode.Uri) => reporter.guard(() => debugFile(uri))),
        vscode.debug.registerDebugConfigurationProvider('teal', {
            provideDebugConfigurations: () => configuration.provideDebugConfigurations(),
            resolveDebugConfiguration: (folder, config) => reporter.guard(async () => configuration.resolveDebugConfiguration(folder, config)),
            resolveDebugConfigurationWithSubstitutedVariables: (folder, config) => reporter.guard(() => configuration.resolveDebugConfigurationWithSubstitutedVariables(folder, config)),
        }),
        vscode.debug.registerDebugAdapterDescriptorFactory('teal', new DebugAdapter(reporter)),
    );
    await vscode.commands.executeCommand('setContext', 'teal.supported', isSupported());
    if (!isSupported()) output.appendLine('Teal tool execution requires a supported Windows, Linux or macOS Node.js workspace extension host.');
    updater.start();
    await managed.refresh();
}

export async function deactivate(): Promise<void> {
    await updates?.dispose();
    updates = undefined;
    setManagedToolchainProvider(undefined);
    await clients?.dispose();
    clients = undefined;
    await disposeLanguageServerExecutables();
}
